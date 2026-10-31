// Wall-clock scheduling for the video's overnight shot (scripts/video/overnight.ts).

/**
 * The first instant after `from` at which the wall clock in `zone` reads `at` (HH:MM, 24-hour). Searching minute by
 * minute on the zone's own clock makes daylight-saving changes harmless: on the US fall-back night 01:30 occurs
 * twice (the first is returned) and 03:00 occurs once, an hour later in UTC than on other nights.
 */
export function nextLocal(at: string, zone: string, from = Date.now()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`a time is HH:MM (24-hour), got "${at}"`);
  const want = `${(m[1] as string).padStart(2, "0")}:${m[2]}`;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const start = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let t = start; t < start + 50 * 3_600_000; t += 60_000) if (fmt.format(t) === want) return t;
  throw new Error(`${want} does not occur in ${zone} in the next 50 hours`);
}
