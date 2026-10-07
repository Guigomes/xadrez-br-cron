import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  displayNameFromSource,
  normalize,
  normalizeNameKey,
  participantIdentityKey,
  colIndex,
} from './normalize.js';

interface ImportedParticipant {
  fullName: string;
  sourceName: string;
  title?: string;
  /** ID CBX (coluna "ID" da planilha). É a identidade principal do jogador. */
  cbxId?: string;
  fideId?: string;
  federation?: string;
  ratingStd?: number;
  initialRanking?: number;
  category?: string;
  state?: string;
  clubOrSchool?: string;
}

const BR_STATE_CODES = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
  'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC',
  'SP', 'SE', 'TO',
]);

/** CBX vem como número puro; qualquer outra coisa na coluna "ID" é ignorada. */
function parseCbxId(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  return /^\d{1,7}$/.test(v) && Number(v) > 0 ? String(Number(v)) : undefined;
}

/**
 * Trava de segurança para o casamento por CBX: o número digitado na inscrição às
 * vezes é de outra pessoa (acontece muito). Só aceita o casamento se os dois
 * nomes dividem pelo menos 2 palavras (ou todas, se um deles tiver só 1-2).
 */
function namesShareWords(a: string, b: string): boolean {
  const A = normalizeNameKey(a).split(' ').filter((w) => w.length > 1);
  const B = new Set(normalizeNameKey(b).split(' ').filter((w) => w.length > 1));
  if (!A.length || !B.size) return false;
  const shared = A.filter((w) => B.has(w)).length;
  return shared >= Math.min(2, A.length, B.size);
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
  const cbxIdx = colIndex(headers, ['id']);
  const fideIdx = colIndex(headers, ['id fide']);
  const fedIdx = colIndex(headers, ['fed']);
  const eloIdx = colIndex(headers, ['elo', 'elon', 'elof', 'rtg', 'rating']);
  const typeIdx = colIndex(headers, ['tipo']);
  const stateIdx = colIndex(headers, ['gr', 'uf', 'estado', 'state']);
  const clubIdx = colIndex(headers, ['clube/cidade', 'clube / cidade', 'clube cidade']);
  // Título (CM, AFM, WCM, GM...) vem numa coluna SEM cabeçalho, sempre logo
  // antes de "Nome" — visto ao vivo num torneio (tnr1485382): header
  // ["Nº.", "", "Nome", "EloI", "EloN", "sexo", "Tipo"]. Só assume essa
  // posição quando a célula ali é realmente vazia, pra não confundir com
  // uma coluna de verdade numa fonte com layout diferente.
  const titleIdx = nameIdx > 0 && headers[nameIdx - 1] === '' ? nameIdx - 1 : -1;

  if (nameIdx < 0) throw new Error('Coluna "Nome" não encontrada.');

  const out: ImportedParticipant[] = [];
  for (const row of asStr.slice(headerIdx + 1)) {
    const sourceName = (row[nameIdx] ?? '').replace(/\s+/g, ' ').trim();
    const fullName = displayNameFromSource(sourceName);
    if (!fullName) continue;
    if (normalize(fullName).startsWith('encontrara todos os detalhes')) break;
    if (normalize(fullName).includes('chess-results')) continue;

    const ratingStd = parseInt(eloIdx >= 0 ? row[eloIdx] : '', 10);
    const initialRanking = parseInt(numIdx >= 0 ? row[numIdx] : '', 10);

    const rawState = stateIdx >= 0 ? row[stateIdx].toUpperCase() : '';
    out.push({
      fullName,
      sourceName,
      title: titleIdx >= 0 ? row[titleIdx] || undefined : undefined,
      cbxId: cbxIdx >= 0 ? parseCbxId(row[cbxIdx]) : undefined,
      fideId: fideIdx >= 0 ? row[fideIdx] || undefined : undefined,
      federation: fedIdx >= 0 ? row[fedIdx] || undefined : undefined,
      ratingStd: Number.isFinite(ratingStd) && ratingStd > 0 ? ratingStd : undefined,
      initialRanking: Number.isFinite(initialRanking) && initialRanking > 0 ? initialRanking : undefined,
      category: typeIdx >= 0 ? row[typeIdx] || undefined : undefined,
      state: BR_STATE_CODES.has(rawState) ? rawState : undefined,
      clubOrSchool: clubIdx >= 0 ? row[clubIdx] || undefined : undefined,
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
  /** Vínculos antigos que passaram a apontar para o cadastro identificado por FIDE. */
  relinked: number;
  /** Vínculos obsoletos que o banco preservou por ainda terem referências. */
  notRemoved: number;
  /** Homônimos de outro grupo do mesmo torneio, tratados como pessoa distinta. */
  homonyms: number;
  /** Descartados por colisão de chave — o participante NÃO entrou no torneio. */
  collided: number;
  /** Casados pelo CBX (identidade principal). */
  byCbx: number;
  /** CBX da planilha que pertence a outra pessoa (nome sem relação): ignorado. */
  cbxMismatch: number;
}

/**
 * Torneios escolares e festivais não publicam a coluna "ID" (CBX) na lista de jogadores, mas a ficha do
 * jogador (art=9) traz o "Ident-Number", que nos torneios brasileiros é o ID CBX. Uma requisição por
 * jogador, então só para quem ainda não está no grupo e com teto por execução.
 */
const MAX_IDENT_LOOKUPS_PER_RUN = 40;

async function fetchIdentNumber(origin: string, tnr: string, snr: number, snode: string | null): Promise<string | undefined> {
  try {
    const res = await fetch(`${origin}/tnr${tnr}.aspx?lan=1&art=9&snr=${snr}${snode ? `&SNode=${snode}` : ''}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; chess-viewer-cron-import)' },
    });
    if (!res.ok) return undefined;
    const text = (await res.text()).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
    return parseCbxId(text.match(/Ident-Number\s*(\d+)/)?.[1]);
  } catch {
    return undefined;
  }
}

export async function importPlayers(
  supabase: SupabaseClient,
  tournamentId: string,
  fileBuffer: ArrayBuffer,
  pairingGroupId: string | null,
  /** When true, re-assigns pairing_group_id on already-existing tournament_players rows */
  repairGroups = true,
  /** Torneio de origem: permite buscar o ID CBX na ficha do jogador quando a lista não traz. */
  source?: { origin: string; tnr: string; snode: string | null },
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
    return { total: 0, added: 0, reused: 0, created: 0, skipped: 0, failed: 0, removed: 0, relinked: 0, notRemoved: 0, homonyms: 0, collided: 0, byCbx: 0, cbxMismatch: 0 };
  }

  // Fetch existing tournament_players scoped to this group so we can:
  // (a) skip re-insert for already-linked players,
  // (b) remove players who are no longer in the Excel at the end, and
  // (c) reconhecer alguém que já está NESTE grupo mesmo se a fonte mudou a
  //     grafia do nome entre uma execução e outra (ver byNameKey abaixo).
  let existingTPsQuery = supabase
    .from('tournament_players')
    .select('id, player_id, source_name, initial_ranking, player:players(full_name, title, fide_id)')
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

  // Todos os player_id já inscritos NESTE torneio, em QUALQUER grupo — usado
  // pra decidir homonímia (ver o casamento global por nome mais abaixo).
  // Consulta separada porque existingTPs é filtrada pelo grupo atual.
  const { data: tpsAnyGroup } = await supabase
    .from('tournament_players')
    .select('player_id')
    .eq('tournament_id', tournamentId);
  const playerIdsInOtherGroups = new Set<string>(
    (tpsAnyGroup ?? [])
      .map((tp) => tp.player_id as string)
      .filter((id) => !existingPlayerIds.has(id)),
  );
  // Track which player_ids appear in the current Excel so we can remove the rest
  const seenPlayerIds = new Set<string>();
  const relinkedTpIds = new Set<string>();

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
  const byIdentityKey = new Map<string, string>();
  const storedNameByPlayerId = new Map<string, string>();
  const storedTitleByPlayerId = new Map<string, string | null>();
  const storedFideByPlayerId = new Map<string, string | null>();
  for (const tp of existingTPs ?? []) {
    const playerIdX = tp.player_id as string;
    const playerRow = (tp.player as unknown) as { full_name?: string; title?: string | null; fide_id?: string | null } | null;
    const fullName = playerRow?.full_name ?? '';
    storedNameByPlayerId.set(playerIdX, fullName);
    storedTitleByPlayerId.set(playerIdX, playerRow?.title ?? null);
    storedFideByPlayerId.set(playerIdX, playerRow?.fide_id ?? null);
    for (const name of [fullName, tp.source_name as string | null]) {
      const key = normalizeNameKey(name ?? '');
      if (key && !byNameKey.has(key)) byNameKey.set(key, playerIdX);
      const identityKey = participantIdentityKey(name ?? '', tp.initial_ranking as number | null);
      if (identityKey && !byIdentityKey.has(identityKey)) byIdentityKey.set(identityKey, playerIdX);
    }
  }

  // Sem ID CBX na lista: tenta a ficha do jogador, só para quem ainda não está neste grupo.
  if (source) {
    const pending = participants.filter(
      (p) =>
        !p.cbxId &&
        p.initialRanking != null &&
        !byNameKey.has(normalizeNameKey(p.fullName)) &&
        !byIdentityKey.has(participantIdentityKey(p.fullName, p.initialRanking) ?? ''),
    );
    const batch = pending.slice(0, MAX_IDENT_LOOKUPS_PER_RUN);
    for (let i = 0; i < batch.length; i += 5) {
      await Promise.all(
        batch.slice(i, i + 5).map(async (p) => {
          p.cbxId = await fetchIdentNumber(source.origin, source.tnr, p.initialRanking!, source.snode);
        }),
      );
    }
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
  let relinked = 0;
  let homonyms = 0;
  let collided = 0;
  let byCbx = 0;
  let cbxMismatch = 0;

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
      // CBX é a identidade principal; FIDE e nome só entram quando não há CBX.
      let cbxId = p.cbxId;
      let fideId = p.fideId;

      if (cbxId) {
        const { data: match } = await supabase
          .from('players')
          .select('id, full_name, fide_id')
          .eq('cbx_id', cbxId)
          .limit(1)
          .maybeSingle();
        if (match?.id) {
          if (!namesShareWords(match.full_name as string, p.fullName)) {
            cbxMismatch++;
            cbxId = undefined; // CBX digitado errado: cai para FIDE / nome
          } else if (seenPlayerIds.has(match.id as string)) {
            homonyms++; // mesmo CBX duas vezes no mesmo Excel: a segunda linha não funde
            cbxId = undefined;
          } else {
            playerId = match.id as string;
            byCbx++;
            reused++;
            // FIDE só entra se o cadastro ainda não tem e ninguém mais usa
            let setFide: string | undefined;
            if (fideId && !match.fide_id) {
              const { data: other } = await supabase.from('players').select('id').eq('fide_id', fideId).limit(1).maybeSingle();
              if (!other?.id) setFide = fideId;
            }
            await supabase
              .from('players')
              .update({
                ...(setFide ? { fide_id: setFide } : {}),
                state: p.state,
                club_or_school: p.clubOrSchool,
                rating_std: p.ratingStd,
                federation: p.federation,
                title: p.title,
              })
              .eq('id', playerId);
          }
        }
      }

      if (!playerId && fideId) {
        const { data: match } = await supabase
          .from('players')
          .select('id, full_name, cbx_id')
          .eq('fide_id', fideId)
          .limit(1)
          .maybeSingle();
        // FIDE de quem tem outro CBX é de outra pessoa: não casa nem repete o FIDE
        if (match?.id && cbxId && match.cbx_id && match.cbx_id !== cbxId) {
          fideId = undefined;
        } else if (match?.id) {
          playerId = match.id as string;
          reused++;
          const shouldUpdateName =
            match.full_name !== p.fullName &&
            normalizeNameKey(match.full_name as string) === normalizeNameKey(p.fullName);
          if (shouldUpdateName || cbxId || p.state || p.clubOrSchool || p.ratingStd || p.federation || p.title) {
            await supabase
              .from('players')
              .update({
                ...(shouldUpdateName ? { full_name: p.fullName } : {}),
                state: p.state,
                club_or_school: p.clubOrSchool,
                rating_std: p.ratingStd,
                federation: p.federation,
                title: p.title,
                ...(cbxId && !match.cbx_id ? { cbx_id: cbxId } : {}),
              })
              .eq('id', playerId);
          }
        }
      }

      if (!playerId) {
        const candidate = byNameKey.get(normalizeNameKey(p.fullName));
        // seenPlayerIds.has(candidate): outra linha do MESMO Excel, ainda
        // nesta mesma execução, já reivindicou esse player_id — ou seja, tem
        // duas pessoas com o mesmo nome NESTE grupo (não coberto pela guarda
        // de homônimo entre grupos abaixo, que só olha OUTROS grupos). Sem
        // esta checagem as duas linhas do Excel convergiam pro mesmo
        // tournament_players.id: a segunda pessoa nunca ganhava cadastro
        // próprio, e cada reexecução sobrescrevia o registro com o que veio
        // por último — dava exatamente a "confusão completa" ao editar a
        // lista de inscritos antes da 1ª rodada.
        if (candidate && !seenPlayerIds.has(candidate)) {
          playerId = candidate;
          reused++;
          const stored = storedNameByPlayerId.get(candidate);
          const storedTitle = storedTitleByPlayerId.get(candidate);
          // Só grava se o texto realmente mudou — reconstrução por vírgula
          // idêntica de execução em execução não deveria disparar update à
          // toa. Quando muda, assume a formatação mais recente da fonte.
          if (stored !== p.fullName || (p.title && p.title !== storedTitle) || p.state || p.clubOrSchool || p.ratingStd || p.federation) {
            await supabase
              .from('players')
              .update({ full_name: p.fullName, title: p.title, state: p.state, club_or_school: p.clubOrSchool, rating_std: p.ratingStd, federation: p.federation })
              .eq('id', playerId);
          }
        } else if (candidate) {
          homonyms++;
        }
      }

      if (!playerId) {
        const { data: matches } = await supabase
          .from('players')
          .select('id, full_name, cbx_id, fide_id')
          .ilike('full_name', p.fullName)
          .limit(10);
        let exact = matches?.find((m) => normalize(m.full_name as string) === normalize(p.fullName));

        // Homônimo dentro do mesmo torneio = pessoa DIFERENTE, não a mesma.
        // Os grupos de um festival jogam em paralelo (mesmo dia, mesmo
        // horário), então ninguém disputa dois — se o nome bate com alguém já
        // inscrito em outro grupo, são duas pessoas com o mesmo nome.
        //
        // Sem esta guarda o casamento global por nome devolvia o `players` do
        // outro grupo, o insert em tournament_players batia no
        // UNIQUE (tournament_id, player_id), o catch classificava como
        // `skipped` e o jogador sumia sem erro nenhum — junto com todos os
        // pareamentos dele, que passavam a "não identificados". Visto no
        // Festival Estadual da Criança e Juventude (11/04/2026): "Leonel,
        // Mateus Fernando Silva" aparece no Sub 7 (Elo 0, U11) e no Sub 17
        // Masculino (Elo 1800, U13) — confirmado pelo organizador como duas
        // pessoas distintas. O segundo grupo importou 79 de 80 inscritos.
        //
        // Cair fora daqui deixa o fluxo criar um `players` novo, que é o certo.
        if (exact && playerIdsInOtherGroups.has(exact.id as string)) {
          exact = undefined;
          homonyms++;
        }

        // Mesma guarda do bloco de byNameKey acima, pro caminho de nome
        // exato global: outra linha deste MESMO Excel já reivindicou este
        // player_id nesta execução — segunda pessoa com o nome idêntico no
        // mesmo grupo, cai fora daqui e vai criar um `players` novo abaixo.
        if (exact && seenPlayerIds.has(exact.id as string)) {
          exact = undefined;
          homonyms++;
        }

        // Homônimo com ID diferente é outra pessoa: não casa nem sobrescreve o ID
        if (exact && ((cbxId && exact.cbx_id && exact.cbx_id !== cbxId) || (fideId && exact.fide_id && exact.fide_id !== fideId))) {
          exact = undefined;
          homonyms++;
        }

        if (exact) {
          playerId = exact.id as string;
          reused++;
          if (fideId || cbxId || p.state || p.clubOrSchool || p.ratingStd || p.title) {
            await supabase
              .from('players')
              .update({
                ...(fideId && !exact.fide_id ? { fide_id: fideId } : {}),
                ...(cbxId && !exact.cbx_id ? { cbx_id: cbxId } : {}),
                state: p.state,
                club_or_school: p.clubOrSchool,
                rating_std: p.ratingStd,
                federation: p.federation,
                title: p.title,
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
            title: p.title,
            cbx_id: cbxId,
            fide_id: fideId,
            federation: p.federation ?? 'BRA',
            rating_std: p.ratingStd,
            state: p.state,
            club_or_school: p.clubOrSchool,
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

      // O cadastro global identificado por FIDE pode já existir, enquanto o
      // vínculo deste torneio nasceu antes, sem FIDE e com o nome em outra
      // ordem. Preserve o tournament_players.id antigo (e suas partidas) e
      // troque apenas o player_id. Nome + ranking inicial evitam unir homônimos.
      if ((p.fideId || p.cbxId) && !existingPlayerIds.has(playerId) && !playerIdsInOtherGroups.has(playerId)) {
        const identityKey = participantIdentityKey(p.fullName, p.initialRanking);
        const previousPlayerId = identityKey ? byIdentityKey.get(identityKey) : null;
        const previousFideId = previousPlayerId ? storedFideByPlayerId.get(previousPlayerId) : null;
        const existingTpId = previousPlayerId ? existingPlayerIds.get(previousPlayerId) : null;

        if (
          previousPlayerId
          && previousPlayerId !== playerId
          && existingTpId
          && (!previousFideId || previousFideId === p.fideId)
        ) {
          const { error: relinkError } = await supabase
            .from('tournament_players')
            .update({ player_id: playerId })
            .eq('id', existingTpId);
          if (relinkError) throw new Error(`falha ao relincar participante por FIDE: ${relinkError.message}`);

          existingPlayerIds.delete(previousPlayerId);
          existingPlayerIds.set(playerId, existingTpId);
          relinkedTpIds.add(existingTpId);
          byNameKey.set(normalizeNameKey(p.fullName), playerId);
          if (identityKey) byIdentityKey.set(identityKey, playerId);
          relinked++;
        }
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
            source_name: p.sourceName,
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
        source_name: p.sourceName,
      });

      existingPlayerIds.set(playerId, '');  // mark as known so duplicates in Excel are skipped
      added++;
    } catch (err) {
      const msg = String((err as Error)?.message ?? '');
      // `skipped` (acima) é o caso benigno "já está neste grupo", normal em
      // toda reexecução. Cair AQUI por chave duplicada é outra coisa: o
      // player_id resolvido já pertence a outro grupo deste torneio e o
      // participante fica de fora. Contar os dois juntos era o que escondia a
      // perda — um número que sobe em toda reimportação não denuncia nada.
      if (msg.includes('duplicate key') || msg.includes('unique')) collided++;
      else failed++;
    }
  }

  // Remove players that were in this group before but are no longer in the Excel.
  // This handles cases where participants leave or are moved to a different group.
  let removed = 0;
  let notRemoved = 0;
  const tpIdsToRemove = (existingTPs ?? [])
    .filter((tp) => !relinkedTpIds.has(tp.id as string) && !seenPlayerIds.has(tp.player_id as string))
    .map((tp) => tp.id as string);

  if (tpIdsToRemove.length > 0) {
    const { error: removeError } = await supabase
      .from('tournament_players')
      .delete()
      .in('id', tpIdsToRemove);
    if (removeError) {
      notRemoved = tpIdsToRemove.length;
      console.warn(`Participantes obsoletos preservados: ${removeError.message}`);
    } else {
      removed = tpIdsToRemove.length;
    }
  }

  return { total: participants.length, added, reused, created, skipped, failed, removed, relinked, notRemoved, homonyms, collided, byCbx, cbxMismatch };
}
