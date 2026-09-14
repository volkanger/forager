import type { Window } from "./catalog";

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateParts(ts: number, tz: string): { year: string; month: string; day: string } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(ts).map((p) => [p.type, p.value]));
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Identifier of the quota cycle `ts` falls in. Day/month cycles follow the provider's reset time zone. */
export function periodId(window: Window, ts: number, tz = "UTC"): string {
  switch (window) {
    case "minute":
      return `m${Math.floor(ts / 60_000)}`;
    case "hour":
      return `h${Math.floor(ts / 3_600_000)}`;
    case "day": {
      const p = dateParts(ts, tz);
      return `${p.year}-${p.month}-${p.day}`;
    }
    case "month": {
      const p = dateParts(ts, tz);
      return `${p.year}-${p.month}`;
    }
  }
}

/** Epoch ms when the cycle containing `ts` ends. */
export function nextReset(window: Window, ts: number, tz = "UTC"): number {
  if (window === "minute") return (Math.floor(ts / 60_000) + 1) * 60_000;
  if (window === "hour") return (Math.floor(ts / 3_600_000) + 1) * 3_600_000;
  // Day/month boundaries depend on the time zone (incl. DST): walk forward coarsely, then refine to the minute.
  const current = periodId(window, ts, tz);
  const step = window === "day" ? 900_000 : 3_600_000;
  let t = Math.floor(ts / 60_000) * 60_000;
  while (periodId(window, t + step, tz) === current) t += step;
  while (periodId(window, t + 60_000, tz) === current) t += 60_000;
  return t + 60_000;
}
