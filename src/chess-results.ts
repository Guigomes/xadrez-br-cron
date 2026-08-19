import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (compatible; chess-viewer-cron-import)';

export interface BaseUrlInfo {
  href: string;
  tnr: string;
  lan: string;
  snode: string | null;
}

export function parseBaseUrl(url: string): BaseUrlInfo {
  const u = new URL(url);
  const m = u.pathname.match(/tnr(\d+)\.aspx/i);
  if (!m) {
    throw new Error(
      `URL inválida: esperado caminho tnr<id>.aspx, recebido ${u.pathname}`,
    );
  }
  return {
    href: u.toString(),
    tnr: m[1],
    lan: u.searchParams.get('lan') ?? '10',
    snode: u.searchParams.get('SNode'),
  };
}

/**
 * Builds a chess-results URL for a specific "art" (page type) and optional round.
 * Preserves lan and SNode from the base URL.
 */
export function buildArtUrl(info: BaseUrlInfo, art: number, round?: number): string {
  const u = new URL(info.href);
  // Reset to known params
  u.search = '';
  u.searchParams.set('lan', info.lan);
  u.searchParams.set('art', String(art));
  if (round !== undefined) u.searchParams.set('rd', String(round));
  if (info.snode) u.searchParams.set('SNode', info.snode);
  u.searchParams.set('turdet', 'YES');
  return u.toString();
}

/**
 * Fetches the HTML for a chess-results page.
 */
export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  return res.text();
}

/**
 * Looks for an Excel download link in a chess-results HTML page.
 * The button is typically rendered as <a href="...prt=4&excel=2010">Excel</a>.
 */
export function findExcelLink(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);
  let foundHref: string | null = null;

  $('a').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim().toLowerCase();
    const href = $el.attr('href') ?? '';
    if (
      text === 'excel' ||
      text === 'xlsx' ||
      /excel|xlsx/i.test(href) ||
      /[?&]prt=4(?:&|$)/i.test(href)
    ) {
      foundHref = href;
      return false;
    }
  });

  if (!foundHref) return null;
  return new URL(foundHref, pageUrl).toString();
}

/**
 * Fetches a chess-results page, finds the Excel download link, and downloads it.
 * Falls back to appending prt=4&excel=2010 to the page URL if no link is found.
 */
export async function fetchExcelFromPage(pageUrl: string): Promise<ArrayBuffer> {
  const html = await fetchHtml(pageUrl);

  let excelUrl = findExcelLink(html, pageUrl);
  if (!excelUrl) {
    const fallback = new URL(pageUrl);
    fallback.searchParams.set('prt', '4');
    fallback.searchParams.set('excel', '2010');
    excelUrl = fallback.toString();
  }

  const res = await fetch(excelUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar Excel de ${excelUrl}`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    throw new Error(`Resposta HTML em vez de Excel para ${excelUrl} (link Excel não localizado)`);
  }

  return res.arrayBuffer();
}

/**
 * Downloads an Excel file directly from a chess-results page URL by appending
 * prt=4&excel=2010 — preserves all existing params (including SNode).
 * Use this instead of fetchExcelFromPage when you need to keep SNode.
 */
export async function fetchExcelDirect(pageUrl: string): Promise<ArrayBuffer> {
  const u = new URL(pageUrl);
  u.searchParams.set('prt', '4');
  u.searchParams.set('excel', '2010');
  const excelUrl = u.toString();

  const res = await fetch(excelUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar Excel de ${excelUrl}`);

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    throw new Error(`Resposta HTML em vez de Excel para ${excelUrl}`);
  }

  return res.arrayBuffer();
}

/**
 * Reads the highest "rd=N" value referenced in any anchor on the page —
 * a reliable approximation of how many rounds have been published.
 */
export function extractMaxRound(html: string): number {
  // chess-results.com renders hrefs with HTML-encoded ampersands (&amp;rd=N),
  // so the char before `rd=` is `;`, not `&`. Accept `?`, `&`, or `;`.
  const matches = html.matchAll(/[?&;]rd=(\d+)/g);
  let max = 0;
  for (const m of matches) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

/**
 * Reads the round count from the standings heading — "Classificação final após
 * 6 rondas" / "Final Ranking after 6 Rounds" / "Endstand nach 6 Runden".
 *
 * Existe porque extractMaxRound falha em torneio com mais de 2 semanas: o
 * chess-results troca os links de rodada por um botão ("Para reduzir a carga do
 * servidor pela verificação diária de todos os links..."), então não sobra
 * nenhum `rd=N` no HTML e a contagem dá 0 — o worker importava jogadores e
 * classificação, e nenhuma rodada, sem erro nenhum. Medido em tnr1369969
 * (abril, links escondidos, maxRound=0) contra tnr1449184 (agosto, links
 * visíveis, maxRound=6).
 *
 * O cabeçalho está no mesmo HTML que o worker já baixa pra extractMaxRound —
 * sem requisição extra. Casa também com o torneio em andamento, cujo título
 * não traz "final" ("Classificação após 3 rondas").
 */
export function extractRoundCountFromHeading(html: string): number {
  const m = html.match(
    /(?:após|apos|after|nach)\s+(\d+)\s*(?:rondas?|rodadas?|rounds?|runden)/i,
  );
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? 0 : n;
}
