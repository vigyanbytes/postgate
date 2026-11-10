// LinkedIn "little text format" for Posts API commentary.
// Source: https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/little-text-format
// Reserved characters must be backslash-escaped, otherwise LinkedIn drops or reinterprets text after them.
// #tags become hashtag templates so they stay clickable. The Comments API takes PLAIN text: never run
// comment text through this (the bug behind Postiz issue #1847).

const RESERVED = /[\\|{}@\[\]()<>#*_~]/g;

export const escapeLittleText = (s: string): string => s.replace(RESERVED, (c) => `\\${c}`);

const HASHTAG = /(^|\s)#([\p{L}\p{N}]+)/gu;

/** User text -> commentary: escape everything, then rebuild hashtags as {hashtag|\#|tag}. */
export function toCommentary(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(HASHTAG)) {
    const start = m.index ?? 0;
    const lead = m[1] ?? '';
    out += escapeLittleText(text.slice(last, start)) + lead + `{hashtag|\\#|${m[2]}}`;
    last = start + m[0].length;
  }
  return out + escapeLittleText(text.slice(last));
}
