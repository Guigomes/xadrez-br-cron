import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseBaseUrl,
  buildArtUrl,
  fetchExcelFromPage,
  fetchExcelDirect,
  fetchHtml,
  extractMaxRound,
  extractRoundCountFromHeading,
} from './chess-results.js';
import { importPlayers } from './import-players.js';
import { importPairings } from './import-pairings.js';
import { importStandings } from './import-standings.js';
import { importPgns } from './import-pgns.js';
import { notifyRoundPublished } from './notify.js';
import {
  isInfo64Url,
  parseInfo64Url,
  info64Pages,
  isGirlsSection,
  playersSheet,
  pairingsSheet,
  standingsSheet,
  totalRoundsFromMenu,
} from './info64.js';

interface ImportRow {
  id: string;
  tournament_id: string;
  base_url: string;
  pairing_group_name: string | null;
}

/**
 * Regra fixa: todo torneio importado leva na descrição o link da fonte (chess-results / info64).
 * Descrição vazia recebe o link; descrição que o worker mesmo gerou ganha o link de cada grupo
 * importado. Texto escrito pelo organizador nunca é tocado.
 */
const SOURCE_LINK_PREFIX = 'Resultados oficiais:';

async function ensureSourceLink(
  supabase: SupabaseClient,
  row: ImportRow,
  description: string | null,
): Promise<void> {
  const url = row.base_url.trim();
  const current = (description ?? '').trim();
  if (current.includes(url)) return;
  if (current && !current.startsWith(SOURCE_LINK_PREFIX)) return;
  const line = row.pairing_group_name ? `${row.pairing_group_name}: ${url}` : url;
  const next = current ? `${current}
${line}` : `${SOURCE_LINK_PREFIX}
${line}`;
  await supabase.from('tournaments').update({ description: next }).eq('id', row.tournament_id);
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

// PGN: só com o grupo encerrado e poucas vezes (até 3, com 6 h entre elas). Cada busca custa
// 1–2 requisições quando o torneio não publica lances e uma por partida quando publica.
const PGN_MAX_TRIES = 3;
const PGN_RETRY_HOURS = 6;

async function maybeImportPgns(
  supabase: SupabaseClient,
  row: ImportRow,
  info: ReturnType<typeof parseBaseUrl>,
  pairingGroupId: string | null,
  maxRound: number,
): Promise<string | null> {
  if (maxRound < 1) return null;
  const { data: imp, error } = await supabase
    .from('tournament_imports')
    .select('pgn_checked_at, pgn_check_count')
    .eq('id', row.id)
    .single();
  if (error || !imp) return null; // marcador ainda não existe no banco: segue sem PGN
  const tries = (imp.pgn_check_count as number | null) ?? 0;
  if (tries >= PGN_MAX_TRIES) return null;
  const last = imp.pgn_checked_at as string | null;
  if (last && Date.now() - Date.parse(last) < PGN_RETRY_HOURS * 3_600_000) return null;

  let roundsQuery = supabase.from('rounds').select('status').eq('tournament_id', row.tournament_id);
  roundsQuery = pairingGroupId ? roundsQuery.eq('pairing_group_id', pairingGroupId) : roundsQuery.is('pairing_group_id', null);
  const { data: rounds } = await roundsQuery;
  if (!rounds?.length || rounds.length < maxRound || rounds.some((r) => r.status !== 'finished')) return null;

  try {
    const r = await importPgns(supabase, row.tournament_id, info, pairingGroupId, maxRound);
    await supabase
      .from('tournament_imports')
      .update({ pgn_checked_at: new Date().toISOString(), pgn_check_count: r.saved > 0 ? PGN_MAX_TRIES : tries + 1 })
      .eq('id', row.id);
    return r.saved > 0 ? `PGN: ${r.saved} de ${r.candidates} partidas` : null;
  } catch (err) {
    // PGN é um extra: nunca derruba a importação do torneio
    console.warn(`[${row.id}] PGN falhou: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Torneio publicado no info64.org (ver info64.ts). Mesmo fluxo do chess-results —
 * jogadores, rodadas, classificação, avisos — com as páginas do info64 convertidas
 * para o layout de planilha que os importadores já leem. PGN ainda não: o info64
 * só expõe as partidas por busca, sem um arquivo por rodada.
 */
async function processInfo64Import(
  supabase: SupabaseClient,
  row: ImportRow,
  pairingGroupId: string | null,
): Promise<string> {
  const src = parseInfo64Url(row.base_url);
  const sectionHtml = await info64Pages.section(src);
  const playersResult = await importPlayers(
    supabase,
    row.tournament_id,
    playersSheet(sectionHtml, { girlsSection: isGirlsSection(src) }),
    pairingGroupId,
    true,
  );

  // Mesma regra de revisão do chess-results: rodadas encerradas só são relidas se
  // estiverem entre as 2 últimas, ou uma vez por hora.
  let roundsQuery = supabase.from('rounds').select('round_number, status').eq('tournament_id', row.tournament_id);
  roundsQuery = pairingGroupId ? roundsQuery.eq('pairing_group_id', pairingGroupId) : roundsQuery.is('pairing_group_id', null);
  const { data: knownRounds } = await roundsQuery;
  const finishedRounds = new Set((knownRounds ?? []).filter((r) => r.status === 'finished').map((r) => r.round_number as number));
  const knownMax = Math.max(0, ...(knownRounds ?? []).map((r) => r.round_number as number));
  const hourlyDeepCheck = new Date().getUTCMinutes() < 3;

  const totalRounds = totalRoundsFromMenu(sectionHtml, src);
  let maxRound = 0;
  let completedRound = 0;
  let totalPairings = 0;
  let totalPairingsUnmatched = 0;
  let skippedFinishedRounds = 0;
  const roundsToNotify = new Set<string>();
  for (let rd = 1; rd <= totalRounds; rd++) {
    const alreadyFinished = finishedRounds.has(rd);
    if (alreadyFinished && rd < knownMax - 1 && !hourlyDeepCheck) {
      skippedFinishedRounds++;
      maxRound = rd;
      completedRound = rd;
      continue;
    }
    const page = pairingsSheet(await info64Pages.round(src, rd), rd);
    if (!page) break; // rodada ainda não pareada: as seguintes também não estão
    maxRound = rd;
    if (page.open === 0) completedRound = rd;
    try {
      const r = await importPairings(supabase, row.tournament_id, page.sheet, pairingGroupId);
      totalPairings += r.imported;
      totalPairingsUnmatched += r.unmatched;
      if (r.roundId && (!alreadyFinished || r.published)) roundsToNotify.add(r.roundId);
    } catch (err) {
      console.warn(`[${row.id}] info64 rodada ${rd} falhou: ${(err as Error).message}`);
    }
  }

  const { error: roundsCountError } = await supabase
    .from('tournament_imports')
    .update({ discovered_rounds_count: maxRound })
    .eq('id', row.id);
  if (roundsCountError) throw new Error(roundsCountError.message);

  const standingsResult = await importStandings(
    supabase,
    row.tournament_id,
    standingsSheet(await info64Pages.standings(src), completedRound),
    pairingGroupId,
  );

  for (const roundId of roundsToNotify) {
    await notifyRoundPublished(roundId);
  }

  const perdidos = playersResult.collided + playersResult.failed;
  return [
    `info64 · jogadores: ${playersResult.added}+${playersResult.reused} (criados ${playersResult.created}${playersResult.removed > 0 ? `, removidos ${playersResult.removed}` : ''}${perdidos > 0 ? `, NÃO IMPORTADOS ${perdidos}` : ''})`,
    `rodadas 1..${maxRound} de ${totalRounds}: ${totalPairings} pareamentos${totalPairingsUnmatched > 0 ? ` (${totalPairingsUnmatched} não identificados)` : ''}${skippedFinishedRounds > 0 ? ` · ${skippedFinishedRounds} já encerradas, puladas` : ''}`,
    `classificação: ${standingsResult.matched} jogadores`,
  ].join(' · ');
}

export async function processImport(
  supabase: SupabaseClient,
  row: ImportRow,
): Promise<string> {
  // Torneios nativos são gerenciados pelo próprio chess-viewer — o import
  // jamais deve tocá-los (sobrescreveria pareamentos gerados pela engine).
  const { data: tournament } = await supabase
    .from('tournaments')
    .select('mode, description')
    .eq('id', row.tournament_id)
    .single();
  if (tournament?.mode === 'native') {
    throw new Error('torneio nativo — importação bloqueada (desabilite esta linha de import)');
  }
  await ensureSourceLink(supabase, row, tournament?.description ?? null);

  const pairingGroupId = await resolvePairingGroupId(
    supabase,
    row.tournament_id,
    row.pairing_group_name,
  );
  if (isInfo64Url(row.base_url)) return processInfo64Import(supabase, row, pairingGroupId);

  const info = parseBaseUrl(row.base_url);

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
    true,
    { origin: new URL(info.href).origin, tnr: info.tnr, snode: info.snode },
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
  let maxRound = Math.max(
    extractMaxRound(standingsHtml),
    extractMaxRound(pairingsIndexHtml),
  );

  // Fallback pro torneio com mais de 2 semanas: o chess-results esconde os
  // links de rodada atrás de um botão e não sobra nenhum `rd=N` pra contar.
  // O cabeçalho da classificação ("... após 6 rondas") continua no mesmo HTML.
  // Sem isso o import terminava com "success" tendo gravado zero rodadas.
  if (maxRound === 0) {
    maxRound = Math.max(
      extractRoundCountFromHeading(standingsHtml),
      extractRoundCountFromHeading(pairingsIndexHtml),
    );
  }

  // NULL no banco significa "fonte ainda não inspecionada"; zero significa
  // uma categoria real sem rodadas. O processador de push usa esta diferença
  // para saber quais categorias devem participar do resumo global.
  const { error: roundsCountError } = await supabase
    .from('tournament_imports')
    .update({ discovered_rounds_count: maxRound })
    .eq('id', row.id);
  if (roundsCountError) throw new Error(roundsCountError.message);

  // 3. Pairings for each round (art=2)
  // Use fetchExcelDirect so the SNode param is preserved — fetchExcelFromPage
  // extracts the Excel link from the rendered HTML and that link drops SNode,
  // which would mix pairings from all groups.
  //
  // Rodada já 'finished' localmente quase nunca muda no chess-results — refazer o
  // download + parse de TODAS em toda execução (às vezes dezenas de rodadas) era o
  // maior custo do worker. Mas muda de vez em quando (correção de resultado pela
  // arbitragem), então: as 2 últimas são relidas sempre e as demais 1x por hora.
  let finishedRoundsQuery = supabase
    .from('rounds')
    .select('round_number')
    .eq('tournament_id', row.tournament_id)
    .eq('status', 'finished');
  finishedRoundsQuery = pairingGroupId
    ? finishedRoundsQuery.eq('pairing_group_id', pairingGroupId)
    : finishedRoundsQuery.is('pairing_group_id', null);
  const { data: finishedRoundRows } = await finishedRoundsQuery;
  const finishedRounds = new Set((finishedRoundRows ?? []).map((r) => r.round_number as number));

  let totalPairings = 0;
  let totalPairingsUnmatched = 0;
  let skippedFinishedRounds = 0;
  const roundsToNotify = new Set<string>();
  for (let rd = 1; rd <= maxRound; rd++) {
    // A última rodada divulgada é revista mesmo estando 'finished': o árbitro pode
    // refazer o emparceiramento (às vezes mais de uma vez) e antes a rodada nunca
    // mais era relida. importPairings só regrava se o conteúdo mudou e reabre a
    // rodada quando voltam mesas sem resultado. As anteriores seguem a regra de revisão abaixo.
    const alreadyFinished = finishedRounds.has(rd);
    // O árbitro também corrige RESULTADO de rodada já encerrada (ex.: 1-0 virou 0-1 na R3 e
    // o banco ficou com a mesa invertida, a pontuação certa e vitórias/derrotas erradas).
    // Por isso as 2 últimas rodadas são revistas em toda execução, e todas as encerradas uma
    // vez por hora (nos primeiros minutos de cada hora UTC). A revisão é barata: importPairings
    // só regrava a mesa que mudou.
    const recentRound = rd >= maxRound - 1;
    const hourlyDeepCheck = new Date().getUTCMinutes() < 3;
    if (alreadyFinished && !recentRound && !hourlyDeepCheck) {
      skippedFinishedRounds++;
      continue;
    }
    try {
      const pairingsUrl = buildArtUrl(info, 2, rd);
      const buf = await fetchExcelDirect(pairingsUrl);
      const r = await importPairings(supabase, row.tournament_id, buf, pairingGroupId);
      totalPairings += r.imported;
      totalPairingsUnmatched += r.unmatched;
      // A rota interna deduplica quatro eventos independentes. Ela precisa ser
      // chamada em toda sincronização da rodada para perceber resultados que
      // chegam enquanto o status continua 'ongoing'.
      // Rodada encerrada que só foi revista não notifica a cada execução — só
      // quando mudou de estado (ex.: foi reemparceirada e reabriu).
      if (r.roundId && (!alreadyFinished || r.published)) roundsToNotify.add(r.roundId);
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

  // 4b. PGN dos torneios que publicam os lances (só com o grupo encerrado)
  const pgnNote = await maybeImportPgns(supabase, row, info, pairingGroupId, maxRound);

  // 5. Processa os eventos de push só depois de gravar pairings E standings,
  // para a rota interna do app ler dados consistentes. A deduplicação por
  // evento mora no app; aqui só disparamos.
  for (const roundId of roundsToNotify) {
    await notifyRoundPublished(roundId);
  }

  // totalPairingsUnmatched era calculado e jogado fora — nenhum jogador ou
  // sistema via esse número, então um nome que não casasse na importação
  // ficava invisível até alguém notar o jogador sumido na tela e investigar
  // manualmente. Agora entra no last_message (só quando > 0, pra não poluir
  // o caso comum de tudo casar).
  // Participante que a fonte lista e que NÃO entrou. Era invisível: o contador
  // de colisão de chave dividia variável com o "já está neste grupo", que sobe
  // em toda reexecução — número alto o tempo todo não denuncia nada. Foi assim
  // que o import terminou 'success' com 79 de 80 inscritos.
  const perdidos = playersResult.collided + playersResult.failed;

  return [
    `jogadores: ${playersResult.added}+${playersResult.reused} (criados ${playersResult.created}${playersResult.relinked > 0 ? `, relincados ${playersResult.relinked}` : ''}${playersResult.removed > 0 ? `, removidos ${playersResult.removed}` : ''}${playersResult.notRemoved > 0 ? `, NÃO REMOVIDOS ${playersResult.notRemoved}` : ''}${playersResult.homonyms > 0 ? `, homônimos ${playersResult.homonyms}` : ''}${perdidos > 0 ? `, NÃO IMPORTADOS ${perdidos}` : ''})`,
    `rodadas 1..${maxRound}: ${totalPairings} pareamentos${totalPairingsUnmatched > 0 ? ` (${totalPairingsUnmatched} não identificados)` : ''}${skippedFinishedRounds > 0 ? ` · ${skippedFinishedRounds} já encerradas, puladas` : ''}`,
    `classificação: ${standingsResult.matched} jogadores`,
    ...(pgnNote ? [pgnNote] : []),
  ].join(' · ');
}
