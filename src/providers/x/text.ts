// X counts "weighted" characters, not code points. From X's published counting rules
// (https://docs.x.com/resources/fundamentals/counting-characters): the limit is 280; every URL counts as
// 23 whatever its length; code points in the ranges below weigh 1 (Latin, Greek, Cyrillic, Indic
// scripts, … up to U+10FF), everything else (CJK, emoji, …) weighs 2. Text is NFC-normalised first.
// Emoji ZWJ sequences may be counted a little high here, which errs on the safe side.
export const X_MAX_WEIGHTED = 280;
export const X_URL_WEIGHT = 23;

const LIGHT: [number, number][] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const URL = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/gi;

const weightOf = (cp: number) => (LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2);

export function xWeightedLength(text: string): number {
  const s = text.normalize('NFC');
  let n = 0;
  let last = 0;
  for (const m of s.matchAll(URL)) {
    for (const ch of s.slice(last, m.index)) n += weightOf(ch.codePointAt(0)!);
    n += X_URL_WEIGHT;
    last = (m.index ?? 0) + m[0].length;
  }
  for (const ch of s.slice(last)) n += weightOf(ch.codePointAt(0)!);
  return n;
}
