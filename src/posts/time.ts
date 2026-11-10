// Schedule times: stored in UTC, entered and shown in the operator's zone (default UTC).
// Wall-clock input ("2026-10-26T09:30") is resolved in the zone with Intl only, no tz database dependency.
export const DEFAULT_TIMEZONE = process.env.POSTGATE_DEFAULT_TIMEZONE || 'UTC';

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `d` in `tz`. */
function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of `tz` from UTC at instant `d`, in minutes (Asia/Kolkata = +330). */
export function offsetMinutes(d: Date, tz: string): number {
  const p = parts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * "2026-10-26T09:30" in `tz` -> UTC Date. Strings that carry their own offset ("…Z", "…+05:30") are taken as is.
 * Returns null when the input is not a time.
 */
export function parseScheduleTime(input: string, tz = DEFAULT_TIMEZONE): Date | null {
  const s = input.trim();
  if (HAS_OFFSET.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = WALL.exec(s);
  if (!m) return null;
  const [, y, mo, da, h, mi, se] = m.map(Number) as number[];
  const guess = Date.UTC(y!, mo! - 1, da!, h!, mi!, se || 0);
  // Two passes handle DST edges: the offset at the guessed instant, then at the corrected one.
  let t = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  t = guess - offsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

/** UTC Date -> "2026-10-26T09:30:00+05:30" in `tz`. */
export function formatInZone(d: Date, tz = DEFAULT_TIMEZONE): string {
  const p = parts(d, tz);
  const off = offsetMinutes(d, tz);
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const sign = off < 0 ? '-' : '+';
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}
