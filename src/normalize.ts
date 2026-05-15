export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function colIndex(headers: string[], aliases: string[]): number {
  const norm = aliases.map(normalize);
  return headers.findIndex((h) => norm.includes(normalize(h)));
}
