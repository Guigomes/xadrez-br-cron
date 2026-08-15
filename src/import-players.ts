import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalize, normalizeNameKey, colIndex } from './normalize.js';

interface ImportedParticipant {
  fullName: string;
  fideId?: string;
  federation?: string;
  ratingStd?: number;
  initialRanking?: number;
  category?: string;
  city?: string;
}

function parseRows(rows: unknown[][]): ImportedParticipant[] {
  const asStr = rows.map((row) => row.map((c) => String(c ?? '').trim()));

  const headerIdx = asStr.findIndex(
    (row) => row.some((c) => normalize(c) === 'nome'),
  );
  if (headerIdx < 0) {
    throw new Error('Cabeçalho do padrão Chess-Results não encontrado (coluna "Nome" ausente).');
  }

  const headers = asStr[headerIdx];
  const numIdx = colIndex(headers, ['nº.', 'nº', 'no.', 'no', 'num', 'numero']);
  const nameIdx = colIndex(headers, ['nome']);
  const fideIdx = colIndex(headers, ['id fide']);
  const fedIdx = colIndex(headers, ['fed']);
  const eloIdx = colIndex(headers, ['elo', 'elon', 'elof', 'rtg', 'rating']);
  const typeIdx = colIndex(headers, ['tipo']);
  const cityIdx = colIndex(headers, ['clube/cidade', 'clube / cidade', 'clube cidade']);

  if (nameIdx < 0) throw new Error('Coluna "Nome" não encontrada.');

  const out: ImportedParticipant[] = [];
  for (const row of asStr.slice(headerIdx + 1)) {
    const rawName = row[nameIdx] ?? '';
    const fullName = rawName.includes(',')
      ? rawName.split(',').map((s) => s.trim()).filter(Boolean).reverse().join(' ')
      : rawName;
    if (!fullName) continue;
    if (normalize(fullName).startsWith('encontrara todos os detalhes')) break;
    if (normalize(fullName).includes('chess-results')) continue;

    const ratingStd = parseInt(eloIdx >= 0 ? row[eloIdx] : '', 10);
    const initialRanking = parseInt(numIdx >= 0 ? row[numIdx] : '', 10);

    out.push({
      fullName,
      fideId: fideIdx >= 0 ? row[fideIdx] || undefined : undefined,
      federation: fedIdx >= 0 ? row[fedIdx] || undefined : undefined,
      ratingStd: Number.isFinite(ratingStd) && ratingStd > 0 ? ratingStd : undefined,
      initialRanking: Number.isFinite(initialRanking) && initialRanking > 0 ? initialRanking : undefined,
      category: typeIdx >= 0 ? row[typeIdx] || undefined : undefined,
      city: cityIdx >= 0 ? row[cityIdx] || undefined : undefined,
    });
  }

  return out;
}

export interface ImportPlayersResult {
  total: number;
  added: number;
  reused: number;
  created: number;
  skipped: number;
  failed: number;
  removed: number;
}

export async function importPlayers(
  supabase: SupabaseClient,
  tournamentId: string,
  fileBuffer: ArrayBuffer,
  pairingGroupId: string | null,
  /** When true, re-assigns pairing_group_id on already-existing tournament_players rows */
  repairGroups = true,
): Promise<ImportPlayersResult> {
  const workbook = XLSX.read(fileBuffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
  }) as unknown[][];

  const participants = parseRows(rawRows);
  if (participants.length === 0) {
    return { total: 0, added: 0, reused: 0, created: 0, skipped: 0, failed: 0, removed: 0 };
  }

  // Fetch existing tournament_players scoped to this group so we can:
  // (a) skip re-insert for already-linked players,
  // (b) remove players who are no longer in the Excel at the end, and
  // (c) reconhecer alguém que já está NESTE grupo mesmo se a fonte mudou a
  //     grafia do nome entre uma execução e outra (ver byNameKey abaixo).
  let existingTPsQuery = supabase
    .from('tournament_players')
    .select('id, player_id, player:players(full_name)')
    .eq('tournament_id', tournamentId);
  if (pairingGroupId) {
    existingTPsQuery = existingTPsQuery.eq('pairing_group_id', pairingGroupId);
  } else {
    existingTPsQuery = existingTPsQuery.is('pairing_group_id', null);
  }
  const { data: existingTPs } = await existingTPsQuery;
  // Map player_id → tp.id for quick lookup
  const existingPlayerIds = new Map<string, string>(
    (existingTPs ?? []).map((tp) => [tp.player_id as string, tp.id as string]),
  );
  // Track which player_ids appear in the current Excel so we can remove the rest
  const seenPlayerIds = new Set<string>();

  // Casamento por nome tolerante à ordem das palavras, mas só entre quem já
  // está NESTE tournament+group — escopo apertado de propósito, pra não
  // arriscar casar gente errada em outro torneio. Existe porque um jogador
  // já cadastrado aqui pode ter o nome reformatado numa execução seguinte
  // (chess-results não é consistente entre exports do mesmo torneio ao
  // longo do tempo); sem isso, o ilike exato abaixo não reconhece a mesma
  // pessoa e cria um cadastro global duplicado — foi o que aconteceu com um
  // jogador do FESTIVAL DA CRIANCA E JUVENTUDE 2026 (SUB11MISTO): o nome
  // dele mudou de formatação entre duas execuções e ganhou um `players` novo
  // do zero, órfão do histórico (rodadas, ranking) que já existia no antigo.
  const byNameKey = new Map<string, string>();
  const storedNameByPlayerId = new Map<string, string>();
  for (const tp of existingTPs ?? []) {
    const playerIdX = tp.player_id as string;
    const fullName = ((tp.player as unknown) as { full_name?: string } | null)?.full_name ?? '';
    storedNameByPlayerId.set(playerIdX, fullName);
    const key = normalizeNameKey(fullName);
    if (key && !byNameKey.has(key)) byNameKey.set(key, playerIdX);
  }

  const { data: categoryRows } = await supabase
    .from('tournament_categories')
    .select('id, name')
    .eq('tournament_id', tournamentId);
  const categoryMap = new Map<string, string>(
    (categoryRows ?? []).map((r) => [normalize(r.name as string), r.id as string]),
  );

  let added = 0;
  let created = 0;
  let reused = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of participants) {
    try {
      let categoryId: string | undefined;

      if (p.category) {
        const normCat = normalize(p.category);
        if (categoryMap.has(normCat)) {
          categoryId = categoryMap.get(normCat);
          if (pairingGroupId && categoryId) {
            await supabase
              .from('tournament_categories')
              .update({ pairing_group_id: pairingGroupId })
              .eq('id', categoryId)
              .is('pairing_group_id', null);
          }
        } else {
          const { data: createdCat } = await supabase
            .from('tournament_categories')
            .insert({
              tournament_id: tournamentId,
              name: p.category,
              pairing_group_id: pairingGroupId ?? null,
            })
            .select('id')
            .single();
          if (createdCat) {
            categoryMap.set(normCat, createdCat.id as string);
            categoryId = createdCat.id as string;
          }
        }
      }

      let playerId: string | null = null;

      if (p.fideId) {
        const { data: match } = await supabase
          .from('players')
          .select('id')
          .eq('fide_id', p.fideId)
          .limit(1)
          .maybeSingle();
        if (match?.id) {
          playerId = match.id as string;
          reused++;
          if (p.city || p.ratingStd || p.federation) {
            await supabase
              .from('players')
              .update({ city: p.city, rating_std: p.ratingStd, federation: p.federation })
              .eq('id', playerId);
          }
        }
      }

      if (!playerId) {
        const candidate = byNameKey.get(normalizeNameKey(p.fullName));
        if (candidate) {
          playerId = candidate;
          reused++;
          const stored = storedNameByPlayerId.get(candidate);
          // Só grava se o texto realmente mudou — reconstrução por vírgula
          // idêntica de execução em execução não deveria disparar update à
          // toa. Quando muda, assume a formatação mais recente da fonte.
          if (stored !== p.fullName) {
            await supabase.from('players').update({ full_name: p.fullName }).eq('id', playerId);
          }
        }
      }

      if (!playerId) {
        const { data: matches } = await supabase
          .from('players')
          .select('id, full_name')
          .ilike('full_name', p.fullName)
          .limit(10);
        const exact = matches?.find((m) => normalize(m.full_name as string) === normalize(p.fullName));
        if (exact) {
          playerId = exact.id as string;
          reused++;
          if (p.fideId || p.city || p.ratingStd) {
            await supabase
              .from('players')
              .update({
                fide_id: p.fideId,
                city: p.city,
                rating_std: p.ratingStd,
                federation: p.federation,
              })
              .eq('id', playerId);
          }
        }
      }

      if (!playerId) {
        const { data: np } = await supabase
          .from('players')
          .insert({
            full_name: p.fullName,
            fide_id: p.fideId,
            federation: p.federation ?? 'BRA',
            rating_std: p.ratingStd,
            city: p.city,
          })
          .select('id')
          .single();
        if (np) {
          playerId = np.id as string;
          created++;
        }
      }

      if (!playerId) {
        failed++;
        continue;
      }
      seenPlayerIds.add(playerId);

      if (existingPlayerIds.has(playerId)) {
        // Player already in this group — sync ranking and category in case they changed.
        await supabase
          .from('tournament_players')
          .update({
            pairing_group_id: pairingGroupId ?? null,
            initial_ranking: p.initialRanking ?? null,
            category_id: categoryId ?? null,
          })
          .eq('tournament_id', tournamentId)
          .eq('player_id', playerId);
        skipped++;
        continue;
      }

      await supabase.from('tournament_players').insert({
        tournament_id: tournamentId,
        player_id: playerId,
        initial_ranking: p.initialRanking,
        category_id: categoryId,
        pairing_group_id: pairingGroupId ?? null,
      });

      existingPlayerIds.set(playerId, '');  // mark as known so duplicates in Excel are skipped
      added++;
    } catch (err) {
      const msg = String((err as Error)?.message ?? '');
      if (msg.includes('duplicate key') || msg.includes('unique')) skipped++;
      else failed++;
    }
  }

  // Remove players that were in this group before but are no longer in the Excel.
  // This handles cases where participants leave or are moved to a different group.
  let removed = 0;
  const tpIdsToRemove = (existingTPs ?? [])
    .filter((tp) => !seenPlayerIds.has(tp.player_id as string))
    .map((tp) => tp.id as string);

  if (tpIdsToRemove.length > 0) {
    await supabase
      .from('tournament_players')
      .delete()
      .in('id', tpIdsToRemove);
    removed = tpIdsToRemove.length;
  }

  return { total: participants.length, added, reused, created, skipped, failed, removed };
}
