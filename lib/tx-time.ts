import { parse } from 'date-fns';

// Shared timestamp parser used by BOTH client and server.
// Goal: never silently "fallback to now" on invalid data — return null instead.

const FORMATS: readonly string[] = [
  // Examples seen in exports / UI
  'MMMM d, yyyy, h:mm a', // October 3, 2025, 1:43 PM
  'MMMM d, yyyy, h:mm:ss a',
  'MMM d, yyyy, h:mm a',
  'MMM d, yyyy, h:mm:ss a',

  // Slash-separated
  'MM/dd/yyyy h:mm a',
  'MM/dd/yyyy h:mm:ss a',
  'MM/dd/yyyy HH:mm',
  'MM/dd/yyyy HH:mm:ss',
  'dd/MM/yyyy h:mm a',
  'dd/MM/yyyy h:mm:ss a',
  'dd/MM/yyyy HH:mm',
  'dd/MM/yyyy HH:mm:ss',

  // Dash-separated
  'dd-MM-yyyy HH:mm',
  'dd-MM-yyyy HH:mm:ss',
  'MM-dd-yyyy HH:mm',
  'MM-dd-yyyy HH:mm:ss',

  // ISO-ish without T
  'yyyy-MM-dd HH:mm',
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd HH:mm:ss.SSS',

  // Slash-separated ISO-ish
  'yyyy/MM/dd HH:mm',
  'yyyy/MM/dd HH:mm:ss',
  'yyyy/MM/dd',

  // Date-only
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'dd-MM-yyyy',
  'MM-dd-yyyy',
];

function isValidDate(d: Date) {
  return !Number.isNaN(d.getTime());
}

function parseEpochLikeNumber(n: number): Date | null {
  if (!Number.isFinite(n)) return null;

  // Excel serial date (days since 1899-12-30; fractional part is time-of-day).
  // Typical range for modern dates is ~40k-60k.
  if (n >= 20_000 && n <= 80_000) {
    const excelEpochUtcMs = Date.UTC(1899, 11, 30);
    const ms = excelEpochUtcMs + n * 86_400_000;
    const d = new Date(ms);
    return isValidDate(d) ? d : null;
  }

  const abs = Math.abs(n);

  // Epoch seconds are usually ~10 digits (e.g. 1700000000).
  if (abs >= 1e9 && abs < 1e10) {
    const d = new Date(n * 1000);
    return isValidDate(d) ? d : null;
  }

  // Otherwise assume epoch milliseconds.
  const d = new Date(n);
  return isValidDate(d) ? d : null;
}

function normalizeIsoLikeString(s: string) {
  // Handle "2025-01-05 12:34:56" (space instead of "T") which `Date` often won't parse reliably.
  // Only rewrite if it clearly looks like a date-time prefix.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    return s.replace(' ', 'T');
  }
  return s;
}

export function parseTxTime(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isValidDate(value) ? value : null;

  // Excel serials / epoch values sometimes appear as numbers.
  if (typeof value === 'number') {
    return parseEpochLikeNumber(value);
  }

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  // Numeric strings (epoch seconds/millis or Excel serials) are common in some exports.
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    const d = parseEpochLikeNumber(n);
    if (d) return d;
  }

  // First: try native parse for true ISO strings.
  const isoCandidate = normalizeIsoLikeString(trimmed);
  const iso = new Date(isoCandidate);
  if (isValidDate(iso)) return iso;

  // Then: try known explicit formats.
  for (const fmt of FORMATS) {
    try {
      const d = parse(trimmed, fmt, new Date(0));
      if (isValidDate(d)) return d;
    } catch {
      // continue
    }
  }

  return null;
}


