import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeNameKey } from './normalize.js';

interface StandingRow {
  rank: number;
  initialRanking: number;
  name: string;
  points: number;
  buchholz: number;
  buchholzCut1: number;
  sonnebornBerger: number;
}

interface ParsedExcel {
  rows: StandingRow[];
  completedRound: number | null;
}

function parseExcel(buffer: ArrayBuffer): ParsedExcel {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

  // Extract "Classificação após a ronda N" / "Ranking after round N"
  let completedRound: number | null = null;
  for (let i = 0; i < Math.min(25, raw.length); i++) {
    const cell = String((raw[i] as unknown[])?.[0] ?? '');
    const m = cell.match(/ronda\s+(\d+)|round\s+(\d+)/i);
    if (m) { completedRound = parseInt(m[1] ?? m[2], 10); break; }
  }

  let headerIdx = -1;
  let headerCells: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    if (row?.some((cell) => String(cell ?? '').trim() === 'Nome')) {
      headerIdx = i;
      headerCells = row.map((c) => String(c ?? '').trim());
      break;
    }
  }
  if (headerIdx === -1) throw new Error('Coluna "Nome" não encontrada.');

  // "Nº.Inic.", "Nr", "No." etc.
  const colNr = headerCells.findIndex((h) => /^n[rº°]/i.test(h) && !/^nome/i.test(h));
  // "Pts. " (trailing space), "Pts.", "Pontos", "Punkte"
  const colPts = headerCells.findIndex((h) => /^pts\.?\s*$/i.test(h) || /^pontos$/i.test(h) || /^punkte$/i.test(h));
  const colName = headerCells.findIndex((h) => /^nome$/i.test(h) || /^name$/i.test(h));
  // "Desp1", "Des1", "Des 1", "TB1", "Dp1" etc.
  const tbCols = headerCells
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => /^(des|tb|dp)/i.test(h) && /\d/.test(h))
    .sort((a, b) => a.i - b.i)
    .map(({ i }) => i);

  if (colPts === -1) throw new Error('Coluna de pontos não encontrada no cabeçalho.');

  const rows: StandingRow[] = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    if (!row || row[0] == null) continue;
    const rank = Number(row[0]);
    if (isNaN(rank) || rank <= 0) continue;

    rows.push({
      rank,
      initialRanking: colNr >= 0 ? Number(row[colNr]) || 0 : Number(row[1]) || 0,
      name: String(row[colName >= 0 ? colName : 3] ?? '').trim(),
      points: Number(row[colPts]) || 0,
      buchholz: tbCols[0] !== undefined ? Number(row[tbCols[0]]) || 0 : 0,
      buchholzCut1: tbCols[1] !== undefined ? Number(row[tbCols[1]]) || 0 : 0,
      sonnebornBerger: tbCols[2] !== undefined ? Number(row[tbCols[2]]) || 0 : 0,
    });
  }

  return { rows, completedRound };
}

export interface ImportStandingsResult {
  matched: number;
  unmatched: number;
}

export async function importStandings(
  supabase: SupabaseClient,
  tournamentId: string,
  fileBuffer: ArrayBuffer,
  pairingGroupId: string | null = null,
): Promise<ImportStandingsResult> {
  const { rows, completedRound } = parseExcel(fileBuffer);
  if (rows.length === 0) return { matched: 0, unmatched: 0 };

  // Scope player lookup to the group. Nome é a chave primária (mesmo padrão
  // de import-pairings.ts), initial_ranking só entra como fallback: a coluna
  // "Nº" é renumerada pelo chess-results toda vez que a lista de inscritos
  // muda antes da 1ª rodada, então casar só por ela atribui pontuação/rank
  // de um jogador a OUTRO sempre que a lista foi editada entre duas
  // execuções — sem erro nenhum, silencioso.
  let playersQuery = supabase
    .from('tournament_players')
    .select('id, initial_ranking, player:players(full_name)')
    .eq('tournament_id', tournamentId);

  if (pairingGroupId) {
    playersQuery = playersQuery.eq('pairing_group_id', pairingGroupId);
  }

  const { data: tPlayers } = await playersQuery;

  const byName = new Map<string, string>();
  const byInitial = new Map<number, string>();
  for (const tp of tPlayers ?? []) {
    const fullName = ((tp.player as unknown) as { full_name?: string } | null)?.full_name ?? '';
    const key = normalizeNameKey(fullName);
    if (key) byName.set(key, tp.id as string);
    const rank = tp.initial_ranking as number | null;
    if (rank != null) byInitial.set(rank, tp.id as string);
  }

  const matched: { tournament_player_id: string; row: StandingRow }[] = [];
  let unmatched = 0;

  for (const row of rows) {
    const tpId = byName.get(normalizeNameKey(row.name)) ?? byInitial.get(row.initialRanking);
    if (tpId) matched.push({ tournament_player_id: tpId, row });
    else unmatched++;
  }

  if (matched.length === 0) return { matched: 0, unmatched };

  const upsertRows = matched.map(({ tournament_player_id, row }) => ({
    tournament_id: tournamentId,
    tournament_player_id,
    rank: row.rank,
    points: row.points,
    buchholz: row.buchholz,
    buchholz_cut1: row.buchholzCut1,
    sonneborn_berger: row.sonnebornBerger,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('standings')
    .upsert(upsertRows, { onConflict: 'tournament_id,tournament_player_id' });
  if (error) throw new Error(error.message);

  // Sync tournament_players denormalized fields
  for (const { tournament_player_id, row } of matched) {
    await supabase
      .from('tournament_players')
      .update({
        current_score: row.points,
        current_rank: row.rank,
        buchholz: row.buchholz,
        buchholz_cut1: row.buchholzCut1,
        sonneborn_berger: row.sonnebornBerger,
      })
      .eq('id', tournament_player_id);
  }

  // Close all ongoing rounds that are known to be complete.
  // The Excel title "Classificação após a ronda N" tells us up to which round results exist.
  // Without that, fall back to closing only the most recent ongoing round.
  const hasResults = matched.some(({ row }) => row.points > 0);
  if (hasResults) {
    let ongoingQuery = supabase
      .from('rounds')
      .select('id, round_number')
      .eq('tournament_id', tournamentId)
      .eq('status', 'ongoing');

    if (pairingGroupId) {
      ongoingQuery = ongoingQuery.eq('pairing_group_id', pairingGroupId);
    } else {
      ongoingQuery = ongoingQuery.is('pairing_group_id', null);
    }

    if (completedRound !== null) {
      ongoingQuery = ongoingQuery.lte('round_number', completedRound);
    } else {
      ongoingQuery = ongoingQuery.order('round_number', { ascending: false }).limit(1);
    }

    const { data: ongoingRounds } = await ongoingQuery;
    if (ongoingRounds && ongoingRounds.length > 0) {
      const ids = ongoingRounds.map((r) => r.id as string);
      await supabase.from('rounds').update({ status: 'finished' }).in('id', ids);
    }
  }

  return { matched: matched.length, unmatched };
}
