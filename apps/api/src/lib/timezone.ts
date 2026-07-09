// ---------------------------------------------------------------------------
// Timezone-aware day boundaries without a date library (none is implied by the
// spec — ask before adding one). Uses only Intl, which ships with Node's ICU.
// ---------------------------------------------------------------------------

// Offset (in minutes) of `date` in `timeZone`, ahead-of-UTC positive. Computed by
// formatting the UTC instant's wall-clock as if it were UTC and diffing — this
// stays correct across any future DST rule change for the zone (no hardcoded
// +2 for Africa/Cairo).
function tzOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

// The UTC instant corresponding to 00:00:00 in `timeZone` on the calendar day
// that `date` falls on in that zone. Used to bound "today's orders" to the
// venue's local day rather than the server process's (likely UTC) day.
export function startOfDayUTC(timeZone: string, date: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const midnightGuessUTC = new Date(`${map.year}-${map.month}-${map.day}T00:00:00Z`);
  const offset = tzOffsetMinutes(timeZone, midnightGuessUTC);
  return new Date(midnightGuessUTC.getTime() - offset * 60_000);
}
