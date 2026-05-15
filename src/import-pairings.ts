import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';

type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*' | 'bye';

interface PairingRow {
  board: number;
  whiteInitial: number;
  blackInitial: number | null;
  result: GameResult;
  whitePoints: number | null;
  blackPoints: number | null;
  isBye: boolean;
}

interface ParsedFile {
  roundNumber: number;
  pairings: PairingRow[];
}

function parseResult(raw: unknown): {
  result: GameResult;
  whitePoints: number | null;
  blackPoints: number | null;
} {
  const s = String(raw ?? '').trim();
  if (s === '1 - 0') return { result: '1-0', whitePoints: 1.0, blackPoints: 0.0 };
  if (s === '0 - 1') return { result: '0-1', whitePoints: 0.0, blackPoints: 1.0 };
  if (s.includes('½') || s.includes('1/2'))
    return { result: '1/2-1/2', whitePoints: 0.5, blackPoints: 0.5 };
  return { result: '*', whitePoints: null, blackPoints: null };
}

function parseExcel(buffer: ArrayBuffer): ParsedFile {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

  let roundNumber = 0;
  for (let i = 0; i < Math.min(10, raw.length); i++) {
    const cell = String((raw[i] as unknown[])?.[0] ?? '').trim();
    const m =
      cell.match(/^(\d+)\.\s*Ronda/i) ??
      cell.match(/Ronda\s+(\d+)/i) ??
      cell.match(/Round\s+(\d+)/i);
    if (m) {
      roundNumber = parseInt(m[1], 10);
      break;
    }
  }
  if (!roundNumber) throw new Error('Número da rodada não encontrado.');

  let dataStart = -1;
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    if (row?.some((c) => String(c ?? '').trim() === 'Resultado')) {
      dataStart = i + 1;
      break;
    }
  }
  if (dataStart === -1) throw new Error('Coluna "Resultado" não encontrada.');

  const pairings: PairingRow[] = [];
  for (let i = dataStart; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    if (!row || row[0] == null) continue;
    const board = Number(row[0]);
    if (isNaN(board) || board <= 0) continue;

    const whiteInitial = Number(row[1]);
    const blackName = String(row[12] ?? '').trim().toLowerCase();
    const isBye = blackName === 'não emparceirado' || row[17] == null;
    const blackInitial = isBye ? null : Number(row[17]);

    if (isBye) {
      pairings.push({
        board,
        whiteInitial,
        blackInitial: null,
        result: 'bye',
        whitePoints: 1.0,
        blackPoints: null,
        isBye: true,
      });
    } else {
      const { result, whitePoints, blackPoints } = parseResult(row[9]);
      pairings.push({
        board,
        whiteInitial,
        blackInitial,
        result,
        whitePoints,
        blackPoints,
        isBye: false,
      });
    }
  }

  return { roundNumber, pairings };
}

export interface ImportPairingsResult {
  roundNumber: number;
  imported: number;
  unmatched: number;
}

export async function importPairings(
  supabase: SupabaseClient,
  tournamentId: string,
  fileBuffer: ArrayBuffer,
): Promise<ImportPairingsResult> {
  const { roundNumber, pairings } = parseExcel(fileBuffer);
  if (pairings.length === 0) {
    return { roundNumber, imported: 0, unmatched: 0 };
  }

  // Round must already exist (manager creates rounds when starting tournament)
  let { data: round } = await supabase
    .from('rounds')
    .select('id, status')
    .eq('tournament_id', tournamentId)
    .eq('round_number', roundNumber)
    .maybeSingle();

  if (!round) {
    const { data: created } = await supabase
      .from('rounds')
      .insert({ tournament_id: tournamentId, round_number: roundNumber, status: 'pending' })
      .select('id, status')
      .single();
    round = created;
  }
  if (!round) throw new Error(`Não foi possível resolver a rodada ${roundNumber}`);

  const { data: tPlayers } = await supabase
    .from('tournament_players')
    .select('id, initial_ranking')
    .eq('tournament_id', tournamentId);

  const byInitial = new Map(
    (tPlayers ?? []).map((tp) => [tp.initial_ranking as number, tp.id as string]),
  );

  const toInsert: Record<string, unknown>[] = [];
  let unmatched = 0;

  for (const p of pairings) {
    const whiteTpId = byInitial.get(p.whiteInitial);
    if (!whiteTpId) {
      unmatched++;
      continue;
    }
    const blackTpId = p.blackInitial != null ? byInitial.get(p.blackInitial) : undefined;
    if (!p.isBye && p.blackInitial != null && !blackTpId) unmatched++;

    toInsert.push({
      tournament_id: tournamentId,
      round_id: round.id,
      board_number: p.board,
      white_tp_id: whiteTpId,
      black_tp_id: blackTpId ?? null,
      result: p.result,
      white_points: p.whitePoints,
      black_points: p.blackPoints,
      is_bye: p.isBye,
    });
  }

  if (toInsert.length === 0) {
    return { roundNumber, imported: 0, unmatched };
  }

  // Replace pairings for this round
  await supabase.from('pairings').delete().eq('round_id', round.id);
  const { error } = await supabase.from('pairings').insert(toInsert);
  if (error) throw new Error(error.message);

  if (round.status === 'pending') {
    await supabase.from('rounds').update({ status: 'ongoing' }).eq('id', round.id);
  }

  return { roundNumber, imported: toInsert.length, unmatched };
}
