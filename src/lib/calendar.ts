/**
 * calendar.ts — the US equity market calendar.
 *
 * Settlement is T+1 in TRADING days, not calendar days. A trade on the Friday
 * before a long weekend settles on Tuesday. Getting this wrong makes settled
 * cash wrong for exactly the days a customer is most likely to notice, and it
 * makes every reconciliation against the custodian disagree by a day.
 *
 * Holidays are computed from the rules rather than hardcoded as a list, so the
 * calendar does not silently expire at the end of a year someone forgot to
 * extend. Rules implemented:
 *
 *   New Year's Day        1 Jan            observed
 *   MLK Day               3rd Mon Jan
 *   Presidents' Day       3rd Mon Feb
 *   Good Friday           Easter - 2       (the only lunar one)
 *   Memorial Day          last Mon May
 *   Juneteenth            19 Jun           observed
 *   Independence Day      4 Jul            observed
 *   Labor Day             1st Mon Sep
 *   Thanksgiving          4th Thu Nov
 *   Christmas             25 Dec           observed
 *
 * "Observed" means: a holiday falling on Saturday is taken on the Friday
 * before, one falling on Sunday is taken on the Monday after. That is the NYSE
 * rule, and it is why 4 July 2026 (a Saturday) is observed on Friday 3 July.
 *
 * Everything here works on YYYY-MM-DD strings in US Eastern terms. Dates in
 * this system are market dates, not instants, and treating them as instants is
 * how you get off-by-one-day bugs at 8pm Pacific.
 */

export type MarketDate = string; // YYYY-MM-DD

function toUTC(date: MarketDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fmt(d: Date): MarketDate {
  return d.toISOString().slice(0, 10);
}

function addDays(date: MarketDate, days: number): MarketDate {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: MarketDate): number {
  return toUTC(date).getUTCDay();
}

export function isWeekend(date: MarketDate): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

/** nth (1-based) given weekday of a month; n = -1 means the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): MarketDate {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const shift = (weekday - first.getUTCDay() + 7) % 7;
    return fmt(new Date(Date.UTC(year, month - 1, 1 + shift + (n - 1) * 7)));
  }
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return fmt(new Date(Date.UTC(year, month - 1, last.getUTCDate() - shift)));
}

/** Anonymous Gregorian ("Meeus/Jones/Butcher") algorithm. */
function easterSunday(year: number): MarketDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return fmt(new Date(Date.UTC(year, month - 1, day)));
}

/** NYSE observation rule: Sat -> Friday before, Sun -> Monday after. */
function observed(date: MarketDate): MarketDate {
  const dow = dayOfWeek(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

const holidayCache = new Map<number, Set<MarketDate>>();

export function marketHolidays(year: number): Set<MarketDate> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const pad = (n: number) => String(n).padStart(2, '0');
  const fixed = (month: number, day: number) =>
    observed(`${year}-${pad(month)}-${pad(day)}`);

  const holidays = new Set<MarketDate>([
    fixed(1, 1), // New Year's Day
    nthWeekday(year, 1, 1, 3), // MLK Day
    nthWeekday(year, 2, 1, 3), // Presidents' Day
    addDays(easterSunday(year), -2), // Good Friday
    nthWeekday(year, 5, 1, -1), // Memorial Day
    fixed(6, 19), // Juneteenth
    fixed(7, 4), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    fixed(12, 25), // Christmas
  ]);

  holidayCache.set(year, holidays);
  return holidays;
}

export function isTradingDay(date: MarketDate): boolean {
  if (isWeekend(date)) return false;
  return !marketHolidays(Number(date.slice(0, 4))).has(date);
}

/** The next trading day strictly after `date`. */
export function nextTradingDay(date: MarketDate): MarketDate {
  let cursor = addDays(date, 1);
  // A guard rather than while(true): a calendar bug should fail loudly.
  for (let i = 0; i < 15; i++) {
    if (isTradingDay(cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new Error(`no trading day found within 15 days of ${date}`);
}

export function previousTradingDay(date: MarketDate): MarketDate {
  let cursor = addDays(date, -1);
  for (let i = 0; i < 15; i++) {
    if (isTradingDay(cursor)) return cursor;
    cursor = addDays(cursor, -1);
  }
  throw new Error(`no trading day found within 15 days before ${date}`);
}

/**
 * Settlement date for a trade. T+1 in TRADING days.
 *
 * US equities moved to T+1 in May 2024, which is why this is +1 and not +2. A
 * Friday trade settles Monday; a Friday-before-Memorial-Day trade settles
 * Tuesday.
 */
export function settlementDate(tradeDate: MarketDate, t = 1): MarketDate {
  let cursor = tradeDate;
  for (let i = 0; i < t; i++) cursor = nextTradingDay(cursor);
  return cursor;
}

/** Every trading day in [from, to], inclusive. */
export function tradingDaysBetween(from: MarketDate, to: MarketDate): MarketDate[] {
  const days: MarketDate[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 4000) {
    if (isTradingDay(cursor)) days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Every calendar day in [from, to], inclusive. Valuation runs daily. */
export function calendarDaysBetween(from: MarketDate, to: MarketDate): MarketDate[] {
  const days: MarketDate[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 4000) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export { addDays, fmt as formatMarketDate };

/** Market date for an instant, in US Eastern terms. */
export function marketDateOf(instant: Date): MarketDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * Whether US equity regular trading hours are open at `instant`.
 *
 * 09:30–16:00 Eastern on a trading day. Deliberately ignores early closes
 * (the 1pm half-days around Thanksgiving and Christmas): they change when an
 * order fills, not whether the ledger is correct, and pretending to model them
 * precisely would be a bigger lie than omitting them. Noted rather than hidden.
 */
export function isMarketOpen(instant: Date): boolean {
  const date = marketDateOf(instant);
  if (!isTradingDay(date)) return false;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
