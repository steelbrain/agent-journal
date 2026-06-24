export const now = () => Date.now();

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
} as const;

export function parseDurationMs(value: string): number {
  const match = /^(\d+)(s|m|h|d|y)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Expected e.g. 90d, 12h, 30m, 45s, or 5y.`);
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MS;
  return amount * UNIT_MS[unit];
}

const RELATIVE_UNITS: ReadonlyArray<readonly [string, number]> = [
  ['year', UNIT_MS.y],
  ['month', 30 * UNIT_MS.d],
  ['week', 7 * UNIT_MS.d],
  ['day', UNIT_MS.d],
  ['hour', UNIT_MS.h],
  ['minute', UNIT_MS.m],
  ['second', UNIT_MS.s],
];

/** Render a Unix-epoch-ms timestamp as a human phrase like "2 minutes ago" or "in 3 days". */
export function humanizeRelative(timestamp: number, reference: number = now()): string {
  const diff = reference - timestamp;
  const abs = Math.abs(diff);
  if (abs < 5 * UNIT_MS.s) return 'just now';
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) {
      const value = Math.floor(abs / ms);
      const label = value === 1 ? unit : `${unit}s`;
      return diff >= 0 ? `${value} ${label} ago` : `in ${value} ${label}`;
    }
  }
  return 'just now';
}

/** Build a `_relative` map humanizing each present (numeric, non-null) timestamp field on a record. */
export function relativeMap(
  record: Record<string, unknown>,
  fields: readonly string[],
  reference: number = now(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'number') out[field] = humanizeRelative(value, reference);
  }
  return out;
}
