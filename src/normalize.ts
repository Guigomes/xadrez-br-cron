export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Produz o nome de exibição sem inferir qual lado da vírgula é sobrenome.
 * O texto original é preservado em tournament_players.source_name.
 */
export function displayNameFromSource(value: string): string {
  return value
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Chave de casamento de nome de jogador, insensível à ORDEM das palavras —
 * não só a acento/caixa. chess-results não é consistente entre a planilha
 * de jogadores e a de pareamentos de um mesmo torneio: às vezes uma delas
 * grafa "Nome, Resto" em vez do "Sobrenome, Nome" de sempre, e o import
 * (players ou pairings) inverte errado ao tentar reconstruir "Nome
 * Sobrenome" a partir da vírgula. Ordenar as palavras alfabeticamente antes
 * de comparar cancela esse tipo de inversão dos dois lados ao mesmo tempo,
 * sem precisar adivinhar qual convenção a fonte usou daquela vez — "Ana
 * Livia Marques Xavier" e "Livia Marques Xavier Ana" caem na mesma chave.
 * Vírgula é tratada como separador de palavra, não como marcador de ordem.
 */
export function normalizeNameKey(value: string): string {
  // chess-results acrescenta marcadores de rodapé ao nome ("Fulana de Tal *)"), que não fazem
  // parte dele — sem tirar, a mesa ficava sem adversário.
  return normalize(value.replace(/\*\)/g, ' ').replace(/,/g, ' '))
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Identidade forte dentro de um grupo importado. O ranking inicial é único no
 * Chess-Results e impede que dois homônimos sejam unidos só porque o nome tem
 * as mesmas palavras em outra ordem.
 */
export function participantIdentityKey(value: string, initialRanking?: number | null): string | null {
  const nameKey = normalizeNameKey(value);
  return nameKey && initialRanking != null ? `${initialRanking}:${nameKey}` : null;
}

export function colIndex(headers: string[], aliases: string[]): number {
  const norm = aliases.map(normalize);
  return headers.findIndex((h) => norm.includes(normalize(h)));
}

/**
 * Nome canônico de categoria de idade/senior: letra + 2 dígitos ("U8" e "U08"
 * viram "U08", "s050" vira "S50"). O chess-results mistura as grafias no
 * mesmo torneio (cada organizador digita de um jeito), e sem isto cada grafia
 * virava uma categoria separada. Nome que não segue o padrão (ex.: "Feminino")
 * só tem o espaço aparado.
 */
export function canonicalCategoryName(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ');
  const m = v.match(/^([A-Za-z])\s*0*(\d{1,2})$/);
  if (!m) return v;
  return `${m[1].toUpperCase()}${m[2].padStart(2, '0')}`;
}
