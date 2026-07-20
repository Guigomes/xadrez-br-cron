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
  // Torneios nativos são gerenciados pelo próprio chess-viewer — o import
  // jamais deve tocá-los (sobrescreveria pareamentos gerados pela engine).
  const { data: tournament } = await supabase
    .from('tournaments')
    .select('mode')
    .eq('id', row.tournament_id)
    .single();
  if (tournament?.mode === 'native') {
    throw new Error('torneio nativo — importação bloqueada (desabilite esta linha de import)');
  }

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

  // 2. Discover round count from standings (art=1) AND pairings index (art=2).
  // When only pairings have been published (no results yet), art=1 has no rd= links
  // so we must also check art=2 to detect the first round.
  const standingsPageUrl = buildArtUrl(info, 1);
  const pairingsIndexUrl = buildArtUrl(info, 2);
  const [standingsHtml, pairingsIndexHtml] = await Promise.all([
    fetchHtml(standingsPageUrl),
    fetchHtml(pairingsIndexUrl),
  ]);
  const maxRound = Math.max(
    extractMaxRound(standingsHtml),
    extractMaxRound(pairingsIndexHtml),
  );

  // 3. Pairings for each round (art=2)
  // Use fetchExcelDirect so the SNode param is preserved — fetchExcelFromPage
  // extracts the Excel link from the rendered HTML and that link drops SNode,
  // which would mix pairings from all groups.
  let totalPairings = 0;
  let totalPairingsUnmatched = 0;
  for (let rd = 1; rd <= maxRound; rd++) {
    try {
      const pairingsUrl = buildArtUrl(info, 2, rd);
      const buf = await fetchExcelDirect(pairingsUrl);
      const r = await importPairings(supabase, row.tournament_id, buf, pairingGroupId);
      totalPairings += r.imported;
      totalPairingsUnmatched += r.unmatched;
    } catch (err) {
      // A future round that hasn't been published yet will fail to parse;
      // skip it and continue with the rest.
      console.warn(`[${row.id}] rodada ${rd} falhou: ${(err as Error).message}`);
    }
  }

  // 4. Standings (final ranking - art=1)
  // chess-results is the authoritative source for points, rank and tiebreakers.
  // No local recalculation — it diverges from chess-results and is not needed.
  const standingsBuf = await fetchExcelDirect(standingsPageUrl);
  const standingsResult = await importStandings(supabase, row.tournament_id, standingsBuf, pairingGroupId);

  return [
    `jogadores: ${playersResult.added}+${playersResult.reused} (criados ${playersResult.created}${playersResult.removed > 0 ? `, removidos ${playersResult.removed}` : ''})`,
    `rodadas 1..${maxRound}: ${totalPairings} pareamentos`,
    `classificação: ${standingsResult.matched} jogadores`,
  ].join(' · ');
}
