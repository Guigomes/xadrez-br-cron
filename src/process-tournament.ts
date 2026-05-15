import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseBaseUrl,
  buildArtUrl,
  fetchExcelFromPage,
  fetchExcelDirect,
  fetchHtml,
  extractMaxRound,
} from './chess-results.js';
import { importPlayers } from './import-players.js';
import { importPairings } from './import-pairings.js';
import { importStandings } from './import-standings.js';

interface ImportRow {
  id: string;
  tournament_id: string;
  base_url: string;
  pairing_group_name: string | null;
}

async function resolvePairingGroupId(
  supabase: SupabaseClient,
  tournamentId: string,
  groupName: string | null,
): Promise<string | null> {
  if (!groupName) return null;
  const trimmed = groupName.trim();
  if (!trimmed) return null;

  const { data: existing } = await supabase
    .from('pairing_groups')
    .select('id')
    .eq('tournament_id', tournamentId)
    .ilike('name', trimmed)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: existingGroups } = await supabase
    .from('pairing_groups')
    .select('id')
    .eq('tournament_id', tournamentId);
  const { data: created } = await supabase
    .from('pairing_groups')
    .insert({
      tournament_id: tournamentId,
      name: trimmed,
      sort_order: existingGroups?.length ?? 0,
    })
    .select('id')
    .single();
  return (created?.id as string) ?? null;
}

export async function processImport(
  supabase: SupabaseClient,
  row: ImportRow,
): Promise<string> {
  const info = parseBaseUrl(row.base_url);
  const pairingGroupId = await resolvePairingGroupId(
    supabase,
    row.tournament_id,
    row.pairing_group_name,
  );

  // 1. Players (art=0 com SNode preservado para filtrar o grupo correto)
  // Usamos fetchExcelDirect em vez de fetchExcelFromPage porque o link Excel
  // da página derruba o SNode, misturando jogadores de todos os grupos.
  const playersUrl = buildArtUrl(info, 0);
  const playersBuf = await fetchExcelDirect(playersUrl);
  const playersResult = await importPlayers(
    supabase,
    row.tournament_id,
    playersBuf,
    pairingGroupId,
  );

  // 2. Discover round count from the standings page (art=1)
  const standingsPageUrl = buildArtUrl(info, 1);
  const standingsHtml = await fetchHtml(standingsPageUrl);
  const maxRound = extractMaxRound(standingsHtml);

  // 3. Pairings for each round (art=2)
  let totalPairings = 0;
  let totalPairingsUnmatched = 0;
  for (let rd = 1; rd <= maxRound; rd++) {
    try {
      const pairingsUrl = buildArtUrl(info, 2, rd);
      const buf = await fetchExcelFromPage(pairingsUrl);
      const r = await importPairings(supabase, row.tournament_id, buf);
      totalPairings += r.imported;
      totalPairingsUnmatched += r.unmatched;
    } catch (err) {
      // A future round that hasn't been published yet will fail to parse;
      // skip it and continue with the rest.
      console.warn(`[${row.id}] rodada ${rd} falhou: ${(err as Error).message}`);
    }
  }

  // 4. Standings (final ranking - art=1)
  const standingsBuf = await fetchExcelFromPage(standingsPageUrl);
  const standingsResult = await importStandings(supabase, row.tournament_id, standingsBuf);

  // 5. Recalculate (uses pairings to derive Buchholz etc.;
  // overrides standings ranks within each pairing group)
  await supabase.rpc('recalculate_standings', { p_tournament_id: row.tournament_id });

  return [
    `jogadores: ${playersResult.added}+${playersResult.reused} (criados ${playersResult.created})`,
    `rodadas 1..${maxRound}: ${totalPairings} pareamentos`,
    `classificação: ${standingsResult.matched} jogadores`,
  ].join(' · ');
}
