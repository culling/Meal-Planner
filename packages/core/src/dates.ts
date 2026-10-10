/** Date helpers. Dates are plain "YYYY-MM-DD" strings (local calendar dates), weeks are ISO 8601 "YYYY-Www". */

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0); // noon avoids DST edge cases
}

export function addDays(ymd: string, n: number): string {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return toYmd(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseYmd(a).getTime() - parseYmd(b).getTime()) / 86_400_000);
}

export function todayYmd(): string {
  return toYmd(new Date());
}

// ----- weeks -----
// A "week" runs from the configured start day for 7 days (Monday by default; some households plan from Saturday).
// Its id is the ISO week (YYYY-Www) that contains its start day, so every id names exactly one week and the default
// (Monday) gives the usual ISO week numbers. This is a setting, shared by the server and the web app, so it lives here.

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type WeekdayName = (typeof WEEKDAYS)[number];

let weekStart = 0; // 0 = Monday … 6 = Sunday

export function setWeekStart(day: WeekdayName | number): void {
  const n = typeof day === "number" ? day : WEEKDAYS.indexOf(day);
  if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error(`Not a day of the week: ${day}`);
  weekStart = n;
}

export function getWeekStart(): WeekdayName {
  return WEEKDAYS[weekStart];
}

/** Plain ISO 8601 week label of a date (weeks start on Monday). */
function isoLabel(ymd: string): string {
  const d = parseYmd(ymd);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day + 3); // Thursday of this week decides the year
  const year = d.getFullYear();
  const jan4 = new Date(year, 0, 4, 12);
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${year}-W${pad(week)}`;
}

/** The first day of the (configured) week that contains this date. */
export function weekStartOf(ymd: string): string {
  const dow = (parseYmd(ymd).getDay() + 6) % 7; // Monday = 0
  return addDays(ymd, -((dow - weekStart + 7) % 7));
}

/** Week id for a date, e.g. "2026-W42". With the default Monday start this is the ISO week. */
export function isoWeekOf(ymd: string): string {
  return isoLabel(weekStartOf(ymd));
}

/** First day of a week: the configured start day within that ISO week. */
export function weekStartDate(week: string): string {
  const m = week.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`Invalid ISO week: ${week}`);
  const year = Number(m[1]);
  const w = Number(m[2]);
  const jan4 = new Date(year, 0, 4, 12);
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  mondayOfWeek1.setDate(mondayOfWeek1.getDate() + (w - 1) * 7 + weekStart);
  return toYmd(mondayOfWeek1);
}

export function weekDates(week: string): string[] {
  const start = weekStartDate(week);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function shiftWeek(week: string, delta: number): string {
  return isoWeekOf(addDays(weekStartDate(week), delta * 7));
}

export function isValidWeek(week: string): boolean {
  return /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(week);
}

export function isValidYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && toYmd(parseYmd(s)) === s;
}

/** "PT1H15M" -> 75. Returns null when it can't be read. */
export function parseIsoDuration(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return null;
  const [, d, h, min, sec] = m;
  const total = Math.round(Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(min ?? 0) + Number(sec ?? 0) / 60);
  return total > 0 ? total : null;
}
