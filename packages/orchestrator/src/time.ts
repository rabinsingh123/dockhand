// Calendar helpers on an injected clock. Dates are ISO YYYY-MM-DD in the rep's time zone.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date at `ms` in `tz`, e.g. "2026-10-27" for America/Sao_Paulo. */
export function todayIso(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "Tue" for the date at `ms` in `tz`. */
export function weekdayShort(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms));
}

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function addDaysIso(iso: string, days: number): string {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`not an ISO date: ${iso}`);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return date.toISOString().slice(0, 10);
}

/** First day of the month after `iso`. */
export function firstOfNextMonth(iso: string): string {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`not an ISO date: ${iso}`);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return date.toISOString().slice(0, 10);
}

/** "DD/MM/YYYY" for an ISO date (pt-BR display). */
export function isoToDmy(iso: string): string {
  const m = ISO_DATE.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
