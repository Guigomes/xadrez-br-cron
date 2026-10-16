import * as cheerio from 'cheerio';
import * as XLSX from 'xlsx';

/**
 * Fonte info64.org (sistema Vega, usado pela Federação Espanhola e em eventos FIDE
 * como o Mundial Sub-7 a Sub-17 de 2026). As páginas são tabelas HTML simples:
 *
 *   /<seção>            ranking inicial  — Ran. | Tit. | Name | Fed. | FIDE | FIDE ID | Origin
 *   /<seção>/<N>        pareamentos da rodada N — Brd. | White | Ran. | Pts. | FIDE | Fed. | Res. | Black | Ran. | ...
 *   /<seção>/standings  classificação — Pos. | Ran. | Tit. | Name | Fed. | Pts. | DE | BH/C1 | BH | SB | ...
 *
 * Em vez de um segundo caminho de importação, cada página vira uma planilha no MESMO
 * layout do Excel do chess-results, e os importadores existentes (importPlayers,
 * importPairings, importStandings) fazem o resto — casamento de nomes, W.O., bye,
 * classificação e avisos de rodada continuam sendo uma lógica só.
 */

const UA = 'Mozilla/5.0 (compatible; chess-viewer-cron-import)';

export function isInfo64Url(url: string): boolean {
  try {
    return /(^|\.)info64\.org$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface Info64Source {
  origin: string;
  /** Primeiro segmento do caminho: a seção do torneio (ex.: "fide-world-championship-2026-o7"). */
  section: string;
}

/** Aceita a URL da seção ou de qualquer página dentro dela (jogador, rodada, classificação). */
export function parseInfo64Url(url: string): Info64Source {
  const u = new URL(url);
  const section = u.pathname.split('/').filter(Boolean)[0];
  if (!section) throw new Error(`URL do info64 sem a seção do torneio: ${url}`);
  return { origin: u.origin, section };
}

const sectionUrl = (s: Info64Source, path = '') => `${s.origin}/${s.section}${path ? `/${path}` : ''}`;

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  return res.text();
}

/** Primeira tabela de dados da página: cabeçalho + linhas, células já sem espaços sobrando. */
function readTable(html: string): { header: string[]; rows: string[][] } {
  const $ = cheerio.load(html);
  const table = $('table').first();
  const clean = (el: Parameters<typeof $>[0]) => $(el).text().replace(/\s+/g, ' ').trim();
  const header = table.find('tr').first().find('th,td').map((_, c) => clean(c)).get();
  const rows = table
    .find('tr')
    .slice(1)
    .map((_, tr) => [$(tr).find('td').map((__, c) => clean(c)).get()])
    .get() as string[][];
  return { header, rows: rows.filter((r) => r.length > 1) };
}

function col(header: string[], ...names: string[]): number {
  const norm = (v: string) => v.toLowerCase().replace(/\.$/, '').trim();
  const wanted = names.map(norm);
  return header.findIndex((h) => wanted.includes(norm(h)));
}

function toXlsx(aoa: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'info64');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

/** Quantas rodadas o torneio tem, pelo menu da seção ("Round 1" … "Round 11"). */
export function totalRoundsFromMenu(html: string, s: Info64Source): number {
  const re = new RegExp(`href="/${s.section}/(\\d+)"`, 'g');
  let max = 0;
  for (const m of html.matchAll(re)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Ranking inicial → planilha de jogadores no layout do chess-results. */
export function playersSheet(html: string, opts: { girlsSection: boolean }): ArrayBuffer {
  const { header, rows } = readTable(html);
  const iRank = col(header, 'Ran'), iTit = col(header, 'Tit'), iName = col(header, 'Name');
  const iFed = col(header, 'Fed'), iElo = col(header, 'FIDE'), iId = col(header, 'FIDE ID');
  if (iName < 0) throw new Error('info64: coluna "Name" não encontrada no ranking inicial');
  // Título numa coluna SEM cabeçalho logo antes de "Nome", como no chess-results.
  const aoa: unknown[][] = [['Nº.', '', 'Nome', 'FED', 'Elo', 'ID FIDE', 'sexo']];
  for (const r of rows) {
    const id = iId >= 0 ? r[iId] : '';
    aoa.push([
      iRank >= 0 ? r[iRank] : '',
      iTit >= 0 ? r[iTit] : '',
      r[iName],
      iFed >= 0 ? r[iFed] : '',
      iElo >= 0 && Number(r[iElo]) > 0 ? r[iElo] : '',
      /^\d+$/.test(id) && Number(id) > 0 ? id : '',
      opts.girlsSection ? 'w' : '',
    ]);
  }
  return toXlsx(aoa);
}

/** Resultado do info64 → célula de resultado no padrão do chess-results. */
function resultCell(raw: string): string {
  const v = raw.replace(/\s+/g, '').toUpperCase();
  if (v === '1-0') return '1 - 0';
  if (v === '0-1') return '0 - 1';
  if (v === '½-½' || v === '1/2-1/2' || v === '0.5-0.5') return '½ - ½';
  // W.O.: o lado presente leva "+", o ausente "-" (também aparece como 1F-0F).
  if (v === '+-' || v === '1F-0F' || v === '1-0F') return '+ - -';
  if (v === '-+' || v === '0F-1F' || v === '0F-1') return '- - +';
  if (v === '--' || v === '0F-0F') return '- - -';
  return '';
}

/**
 * Pareamentos de uma rodada → planilha no layout do chess-results. Retorna null quando a
 * rodada ainda não foi pareada (a página existe, mas a tabela vem vazia).
 */
export function pairingsSheet(html: string, round: number): { sheet: ArrayBuffer; boards: number; open: number } | null {
  const { header, rows } = readTable(html);
  if (rows.length === 0) return null;
  const iBrd = col(header, 'Brd'), iWhite = col(header, 'White'), iRes = col(header, 'Res');
  const iBlack = col(header, 'Black');
  const ranIdxs = header.map((h, i) => (/^ran\.?$/i.test(h) ? i : -1)).filter((i) => i >= 0);
  if (iWhite < 0 || iRes < 0 || iBlack < 0) throw new Error(`info64: colunas da rodada ${round} não reconhecidas`);
  const aoa: unknown[][] = [[`Round ${round}`], ['Mesa', 'Nº.', 'White', 'Resultado', 'Black', 'Nº.']];
  let open = 0;
  rows.forEach((r, idx) => {
    const black = r[iBlack] ?? '';
    const raw = r[iRes] ?? '';
    let blackCell = black;
    let res: string;
    if (!black) {
      // Sem adversário: "+" = bye de 1 ponto, "½" = bye de meio ponto, "0" = não emparceirado.
      const v = raw.trim();
      if (v === '0') { blackCell = 'não emparceirado'; res = '0'; }
      else { blackCell = 'bye'; res = v === '½' || v === '0.5' ? '½' : '1'; }
    } else {
      res = resultCell(raw);
      if (!res) open++;
    }
    aoa.push([
      Number(r[iBrd]) || idx + 1,
      ranIdxs[0] !== undefined ? r[ranIdxs[0]] : '',
      r[iWhite],
      res,
      blackCell,
      black && ranIdxs[1] !== undefined ? r[ranIdxs[1]] : '',
    ]);
  });
  return { sheet: toXlsx(aoa), boards: rows.length, open };
}

/** Classificação → planilha no layout do chess-results (desempates BH, BH/C1 e SB). */
export function standingsSheet(html: string, completedRound: number): ArrayBuffer {
  const { header, rows } = readTable(html);
  const iPos = col(header, 'Pos'), iRan = col(header, 'Ran'), iTit = col(header, 'Tit'), iName = col(header, 'Name');
  const iPts = col(header, 'Pts'), iBh = col(header, 'BH'), iBhC1 = col(header, 'BH/C1'), iSb = col(header, 'SB');
  if (iName < 0 || iPts < 0) throw new Error('info64: colunas da classificação não reconhecidas');
  const aoa: unknown[][] = [[`Ranking after round ${completedRound}`], ['Pos.', 'Nº.Inic.', '', 'Nome', 'Pts.', 'Desp1', 'Desp2', 'Desp3']];
  for (const r of rows) {
    aoa.push([
      r[iPos],
      iRan >= 0 ? r[iRan] : '',
      iTit >= 0 ? r[iTit] : '',
      r[iName],
      Number(r[iPts]) || 0,
      iBh >= 0 ? Number(r[iBh]) || 0 : 0,
      iBhC1 >= 0 ? Number(r[iBhC1]) || 0 : 0,
      iSb >= 0 ? Number(r[iSb]) || 0 : 0,
    ]);
  }
  return toXlsx(aoa);
}

export const info64Pages = {
  section: (s: Info64Source) => fetchPage(sectionUrl(s)),
  round: (s: Info64Source, rd: number) => fetchPage(sectionUrl(s, String(rd))),
  standings: (s: Info64Source) => fetchPage(sectionUrl(s, 'standings')),
};

/** Seção feminina ("…-g7", "…-g13"): todas as jogadoras entram com sexo 'w'. */
export function isGirlsSection(s: Info64Source): boolean {
  return /-g\d+$/i.test(s.section);
}
