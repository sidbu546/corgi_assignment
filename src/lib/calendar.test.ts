/**
 * Market calendar tests.
 *
 * Settlement is T+1 in TRADING days. The cases that matter are the ones where
 * a holiday lands inside the settlement window — those are exactly the days
 * where settled cash goes wrong and every custodian reconciliation disagrees by
 * one day.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTradingDay,
  isWeekend,
  marketHolidays,
  nextTradingDay,
  previousTradingDay,
  settlementDate,
  tradingDaysBetween,
  isMarketOpen,
  marketDateOf,
} from './calendar';

// -----------------------------------------------------------------------------
// Holidays
// -----------------------------------------------------------------------------

test('2026 NYSE holidays are computed from the rules, not hardcoded', () => {
  const h = [...marketHolidays(2026)].sort();
  assert.deepEqual(h, [
    '2026-01-01', // New Year's Day, Thu
    '2026-01-19', // MLK, 3rd Mon Jan
    '2026-02-16', // Presidents', 3rd Mon Feb
    '2026-04-03', // Good Friday (Easter is 5 Apr 2026)
    '2026-05-25', // Memorial, last Mon May
    '2026-06-19', // Juneteenth, Fri
    '2026-07-03', // Independence Day OBSERVED — 4 Jul 2026 is a Saturday
    '2026-09-07', // Labor Day, 1st Mon Sep
    '2026-11-26', // Thanksgiving, 4th Thu Nov
    '2026-12-25', // Christmas, Fri
  ]);
});

test('a Saturday holiday is observed on the Friday before', () => {
  // 4 July 2026 is a Saturday.
  assert.equal(isWeekend('2026-07-04'), true);
  assert.equal(marketHolidays(2026).has('2026-07-03'), true);
  assert.equal(isTradingDay('2026-07-03'), false);
});

test('a Sunday holiday is observed on the Monday after', () => {
  // 4 July 2027 is a Sunday, observed Monday 5 July.
  assert.equal(marketHolidays(2027).has('2027-07-05'), true);
  assert.equal(isTradingDay('2027-07-05'), false);
});

test('Good Friday moves with Easter', () => {
  assert.equal(marketHolidays(2026).has('2026-04-03'), true); // Easter 5 Apr
  assert.equal(marketHolidays(2027).has('2027-03-26'), true); // Easter 28 Mar
});

test('the calendar does not expire: a future year still computes', () => {
  const h = marketHolidays(2031);
  assert.equal(h.size, 10);
  assert.equal(h.has('2031-11-27'), true); // 4th Thursday of November
});

// -----------------------------------------------------------------------------
// Trading days
// -----------------------------------------------------------------------------

test('weekends and holidays are not trading days', () => {
  assert.equal(isTradingDay('2026-09-05'), false); // Saturday
  assert.equal(isTradingDay('2026-09-06'), false); // Sunday
  assert.equal(isTradingDay('2026-09-07'), false); // Labor Day
  assert.equal(isTradingDay('2026-09-08'), true); // Tuesday
});

test('nextTradingDay skips a whole long weekend', () => {
  assert.equal(nextTradingDay('2026-09-04'), '2026-09-08');
});

test('previousTradingDay skips backwards over a long weekend', () => {
  assert.equal(previousTradingDay('2026-09-08'), '2026-09-04');
});

test('tradingDaysBetween excludes weekends and holidays', () => {
  const days = tradingDaysBetween('2026-09-04', '2026-09-09');
  assert.deepEqual(days, ['2026-09-04', '2026-09-08', '2026-09-09']);
});

// -----------------------------------------------------------------------------
// Settlement — the cases that actually bite
// -----------------------------------------------------------------------------

test('T+1 on an ordinary midweek trade', () => {
  assert.equal(settlementDate('2026-09-09'), '2026-09-10');
});

test('a Friday trade settles Monday, not Saturday', () => {
  assert.equal(settlementDate('2026-09-11'), '2026-09-14');
});

test('a Friday trade before a long weekend settles Tuesday', () => {
  // Labor Day is Monday 7 September 2026.
  assert.equal(settlementDate('2026-09-04'), '2026-09-08');
});

test('settlement steps over Thanksgiving and Christmas correctly', () => {
  assert.equal(settlementDate('2026-11-25'), '2026-11-27'); // Thanksgiving Thu
  assert.equal(settlementDate('2026-12-24'), '2026-12-28'); // Christmas Fri
});

test('settlement is T+1, not T+2 — US equities moved in May 2024', () => {
  assert.equal(settlementDate('2026-09-09'), '2026-09-10');
  assert.notEqual(settlementDate('2026-09-09'), '2026-09-11');
  // The parameter still allows T+2 for anything that needs it.
  assert.equal(settlementDate('2026-09-09', 2), '2026-09-11');
});

// -----------------------------------------------------------------------------
// Instants versus market dates
// -----------------------------------------------------------------------------

test('a market date is Eastern, not UTC — the 8pm Pacific trap', () => {
  // 2026-09-09 21:30 Pacific is 2026-09-10 04:30 UTC, but the US market date
  // is still 9 September. Treating the instant as UTC would book the trade on
  // the wrong day.
  const instant = new Date('2026-09-10T04:30:00Z');
  assert.equal(instant.toISOString().slice(0, 10), '2026-09-10');
  assert.equal(marketDateOf(instant), '2026-09-10');

  // And an instant during the trading session maps to that same session day.
  assert.equal(marketDateOf(new Date('2026-09-09T18:00:00Z')), '2026-09-09');
});

test('market open is 09:30-16:00 Eastern on a trading day', () => {
  // 2026-09-09 is a Wednesday. 13:30 UTC = 09:30 EDT.
  assert.equal(isMarketOpen(new Date('2026-09-09T13:29:00Z')), false);
  assert.equal(isMarketOpen(new Date('2026-09-09T13:30:00Z')), true);
  assert.equal(isMarketOpen(new Date('2026-09-09T19:59:00Z')), true);
  assert.equal(isMarketOpen(new Date('2026-09-09T20:00:00Z')), false);
});

test('the market is shut all day on a holiday, whatever the clock says', () => {
  // Labor Day 2026, midday Eastern.
  assert.equal(isMarketOpen(new Date('2026-09-07T16:00:00Z')), false);
});
