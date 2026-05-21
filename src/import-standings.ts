import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';

interface StandingRow {
  rank: number;
  initialRanking: number;
  name: string;
  points: number;
  buchholz: number;
  buchholzCut1: number;
  sonnebornBerger: number;
}

function parseExcel(buffer: ArrayBuffer): StandingRow[] {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

  let dataStart = -1;
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    if (row?.some((cell) => String(cell ?? '').trim() === 'Nome')) {
      dataStart = i + 1;
      break;
    }
  }
  if (dataStart === -1) throw new Error('Coluna "Nome" não encontrada.');

  const rows: StandingRow[] = [];
  for (let i = dataStart; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    if (!row || row[0] == null) continue;
    const rank = Number(row[0]);
    if (isNaN(rank) || rank <= 0) continue;

    rows.push({
      rank,
      initialRanking: Number(row[1]) || 0,
      name: String(row[3] ?? '').trim(),
      points: Number(row[9]) || 0,
      buchholz: Number(row[10]) || 0,
      buchholzCut1: Number(row[11]) || 0,
      sonnebornBerger: Number(row[12]) || 0,
    });
  }

  return rows;
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
  const rows = parseExcel(fileBuffer);
  if (rows.length === 0) return { matched: 0, unmatched: 0 };

  // Scope player lookup to the group so initial_ranking is unambiguous.
  // Each group has its own 1-N ranking; without scoping, rankings from
  // different groups collide and map to the wrong player.
  let playersQuery = supabase
    .from('tournament_players')
    .select('id, initial_ranking')
    .eq('tournament_id', tournamentId);

  if (pairingGroupId) {
    playersQuery = playersQuery.eq('pairing_group_id', pairingGroupId);
  }

  const { data: tPlayers } = await playersQuery;

  const byInitial = new Map(
    (tPlayers ?? []).map((tp) => [tp.initial_ranking as number, tp.id as string]),
  );

  const matched: { tournament_player_id: string; row: StandingRow }[] = [];
  let unmatched = 0;

  for (const row of rows) {
    const tpId = byInitial.get(row.initialRanking);
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

  // Close most recent ongoing round for this group (mirrors the manual import behavior).
  // Scoping to the group prevents closing a round that belongs to a different group.
  let ongoingQuery = supabase
    .from('rounds')
    .select('id')
    .eq('tournament_id', tournamentId)
    .eq('status', 'ongoing')
    .order('round_number', { ascending: false })
    .limit(1);

  if (pairingGroupId) {
    ongoingQuery = ongoingQuery.eq('pairing_group_id', pairingGroupId);
  } else {
    ongoingQuery = ongoingQuery.is('pairing_group_id', null);
  }

  const hasResults = matched.some(({ row }) => row.points > 0);
  const { data: ongoing } = await ongoingQuery.maybeSingle();
  if (ongoing && hasResults) {
    await supabase.from('rounds').update({ status: 'finished' }).eq('id', ongoing.id);
  }

  return { matched: matched.length, unmatched };
}
