import { Chess } from 'chess.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildArtUrl, fetchHtml, type BaseUrlInfo } from './chess-results.js';
import { normalizeNameKey } from './normalize.js';

// Alguns torneios (os que usam tabuleiros eletrônicos) publicam os lances de cada
// partida: a página de emparceiramento de cada rodada (art=2) tem um link por linha
// (PartieSuche.aspx?art=36&id=…) e essa página traz os lances. Quando o torneio
// publica, gravamos o PGN em pairing_pgns (só usuários logados leem).
//
// Torneio sem PGN publicado custa só 1–2 requisições (rodada 1 e a última).

const MAX_GAMES = 600; // teto por grupo (uma requisição por partida)
const CONCURRENCY = 4;
const TITLES = new Set(['gm', 'im', 'fm', 'cm', 'nm', 'afm', 'wgm', 'wim', 'wfm', 'wcm', 'wnm', 'mf', 'mi', 'mn', 'wmf', 'wmn', 'cmn', 'cmf', 'fim']);

/** Chave de nome sem título (GM, NM…) e sem ordem: "NM Silva, Ana" == "Ana Silva". */
function nameKey(s: string): string {
  return normalizeNameKey(s)
    .split(' ')
    .filter((w) => w && !TITLES.has(w))
    .join(' ');
}

function stripTags(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

type RoundLink = { round: number; white: string; black: string; id: string };

/** Linhas da página de emparceiramento de uma rodada que têm link de PGN. */
export function parseRoundLinks(html: string, defaultRound: number): RoundLink[] {
  const out: RoundLink[] = [];
  let round = defaultRound;
  let whiteIdx = -1;
  let blackIdx = -1;
  for (const m of html.matchAll(/<tr class="CR[^"]*"[\s\S]*?<\/tr>/g)) {
    const row = m[0];
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1]));
    if (cells.length === 1) {
      const h = cells[0].match(/^(\d+)\./);
      if (h) round = Number(h[1]);
      continue;
    }
    const w = cells.findIndex((c) => c === 'White' || c === 'Brancas');
    const b = cells.findIndex((c) => c === 'Black' || c === 'Pretas');
    if (w >= 0 && b >= 0) {
      whiteIdx = w;
      blackIdx = b;
      continue;
    }
    const id = row.match(/PartieSuche\.aspx\?art=36&amp;id=(\d+)/)?.[1];
    if (id && whiteIdx >= 0) out.push({ round, white: cells[whiteIdx], black: cells[blackIdx], id });
  }
  return out;
}

type ParsedGame = { white: string; black: string; whiteElo: string; blackElo: string; event: string; date: string; moves: string[] };

/** Lances e cabeçalho da página de uma partida. */
export function parseGamePage(html: string): ParsedGame | null {
  const moves = [...html.matchAll(/<a class="game\d*" href="javascript:c\(\d+\)" id="l\d+">([^<]+)<\/a>/g)]
    .map((m) => m[1].trim())
    // algumas partidas terminam os lances com o resultado; o resultado é acrescentado depois
    .filter((t) => !/^(1-0|0-1|1\/2-1\/2|½-½|\*)$/.test(t));
  const head = html.match(/<p><b>([^<]+)<\/b>\s*\((\d*)\)\s*-\s*<b>([^<]+)<\/b>\s*\((\d*)\)<br>([^<]*)<\/p>/);
  if (!moves.length || !head) return null;
  const meta = head[5].trim();
  const date = meta.match(/(\d{2})\.(\d{2})\.(\d{4})\s*$/);
  return {
    white: head[1].trim(),
    black: head[3].trim(),
    whiteElo: head[2],
    blackElo: head[4],
    event: meta.replace(/,\s*\d{2}\.\d{2}\.\d{4}\s*$/, '').replace(/\s*\(.*$/, '').trim() || 'Torneio',
    date: date ? `${date[3]}.${date[2]}.${date[1]}` : '????.??.??',
    moves,
  };
}

/** Monta o PGN e valida os lances com chess.js; devolve null se não for jogável. */
export function buildPgn(g: ParsedGame, round: number, result: string): string | null {
  const res = result === '1-0' || result === '0-1' || result === '1/2-1/2' ? result : '*';
  const tag = (k: string, v: string | number) => `[${k} "${String(v).replace(/"/g, "'")}"]`;
  const tags = [tag('Event', g.event), tag('Site', 'chess-results.com'), tag('Date', g.date), tag('Round', round), tag('White', g.white), tag('Black', g.black), tag('Result', res)];
  if (Number(g.whiteElo) > 0) tags.push(tag('WhiteElo', g.whiteElo));
  if (Number(g.blackElo) > 0) tags.push(tag('BlackElo', g.blackElo));
  // lixo de codificação (espaço duplamente codificado) vira espaço
  const moves = g.moves.join(' ').replace(/[^\x00-\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  const pgn = `${tags.join('\n')}\n\n${moves} ${res}\n`;
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.history().length ? pgn : null;
  } catch {
    return null;
  }
}

export interface ImportPgnsResult {
  /** Mesas do grupo que ainda não tinham PGN. */
  candidates: number;
  /** Links de PGN encontrados nas páginas das rodadas. */
  links: number;
  /** PGNs gravados. */
  saved: number;
}

/**
 * Baixa e grava os PGN das mesas de um grupo que ainda não os têm.
 * Só deve rodar com o grupo já encerrado (todas as rodadas finished).
 */
export async function importPgns(
  supabase: SupabaseClient,
  tournamentId: string,
  info: BaseUrlInfo,
  pairingGroupId: string | null,
  maxRound: number,
): Promise<ImportPgnsResult> {
  const empty = { candidates: 0, links: 0, saved: 0 };
  if (maxRound < 1) return empty;

  // mesas do grupo (rodada, brancas, pretas, resultado) e os nomes de cada inscrição
  let roundsQuery = supabase.from('rounds').select('id, round_number').eq('tournament_id', tournamentId);
  roundsQuery = pairingGroupId ? roundsQuery.eq('pairing_group_id', pairingGroupId) : roundsQuery.is('pairing_group_id', null);
  const { data: rounds } = await roundsQuery;
  const roundNumber = new Map<string, number>((rounds ?? []).map((r) => [r.id as string, r.round_number as number]));
  if (roundNumber.size === 0) return empty;

  const { data: pairings } = await supabase
    .from('pairings')
    .select('id, round_id, white_tp_id, black_tp_id, result, is_bye')
    .eq('tournament_id', tournamentId)
    .in('round_id', [...roundNumber.keys()])
    .eq('is_bye', false);
  const { data: tps } = await supabase
    .from('tournament_players')
    .select('id, source_name, player:players(full_name)')
    .eq('tournament_id', tournamentId);
  const names = new Map<string, string[]>();
  for (const tp of tps ?? []) {
    const full = ((tp.player as unknown) as { full_name?: string } | null)?.full_name ?? '';
    names.set(tp.id as string, [tp.source_name as string | null, full].filter((x): x is string => !!x));
  }

  const ids = (pairings ?? []).map((p) => p.id as string);
  const { data: have } = ids.length
    ? await supabase.from('pairing_pgns').select('pairing_id').in('pairing_id', ids)
    : { data: [] as { pairing_id: string }[] };
  const hasPgn = new Set((have ?? []).map((h) => h.pairing_id as string));

  // índice: rodada | brancas | pretas -> mesa (as duas grafias de nome de cada jogador)
  const index = new Map<string, { id: string; result: string; round: number }>();
  let candidates = 0;
  for (const p of pairings ?? []) {
    if (hasPgn.has(p.id as string) || !p.white_tp_id || !p.black_tp_id) continue;
    candidates++;
    const round = roundNumber.get(p.round_id as string)!;
    for (const w of names.get(p.white_tp_id as string) ?? []) {
      for (const b of names.get(p.black_tp_id as string) ?? []) {
        index.set(`${round}|${nameKey(w)}|${nameKey(b)}`, { id: p.id as string, result: p.result as string, round });
      }
    }
  }
  if (candidates === 0) return empty;

  // links de PGN: sem link na rodada 1 nem na última, o torneio não publica lances
  const links = new Map<string, RoundLink>();
  const loadRound = async (rd: number) => {
    const url = new URL(buildArtUrl(info, 2, rd));
    url.searchParams.set('zeilen', '99999');
    try {
      for (const l of parseRoundLinks(await fetchHtml(url.toString()), rd)) if (!links.has(l.id)) links.set(l.id, l);
    } catch (e) {
      console.warn(`PGN: rodada ${rd} falhou: ${(e as Error).message}`);
    }
  };
  await loadRound(1);
  if (!links.size && maxRound > 1) await loadRound(maxRound);
  if (!links.size) return { candidates, links: 0, saved: 0 };
  for (let rd = 2; rd <= maxRound; rd += CONCURRENCY) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, maxRound - rd + 1) }, (_, i) => loadRound(rd + i)));
  }

  let saved = 0;
  const linkIds = [...links.keys()].slice(0, MAX_GAMES);
  const origin = new URL(info.href).origin;
  for (let i = 0; i < linkIds.length; i += CONCURRENCY) {
    const rows = await Promise.all(
      linkIds.slice(i, i + CONCURRENCY).map(async (id) => {
        const link = links.get(id)!;
        const pairing = index.get(`${link.round}|${nameKey(link.white)}|${nameKey(link.black)}`);
        if (!pairing) return null;
        let html: string;
        try {
          html = await fetchHtml(`${origin}/PartieSuche.aspx?lan=1&art=36&id=${id}`);
        } catch {
          return null;
        }
        const parsed = parseGamePage(html);
        // confere se a partida baixada é dos mesmos jogadores
        if (!parsed || nameKey(parsed.white) !== nameKey(link.white) || nameKey(parsed.black) !== nameKey(link.black)) return null;
        const pgn = buildPgn(parsed, pairing.round, pairing.result);
        return pgn ? { pairing_id: pairing.id, pgn, source: 'chess-results' } : null;
      }),
    );
    const ok = rows.filter((r): r is { pairing_id: string; pgn: string; source: string } => r !== null);
    if (ok.length) {
      const { error } = await supabase.from('pairing_pgns').upsert(ok, { onConflict: 'pairing_id' });
      if (error) throw new Error(`falha ao gravar PGN: ${error.message}`);
      saved += ok.length;
    }
  }
  return { candidates, links: links.size, saved };
}
