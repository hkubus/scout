import test from 'node:test';
import assert from 'node:assert/strict';
import { dayMonth, dayMonthYear, formatDate, mediumDateShortTime, monthDayTime, timeOfDay, timeWithSeconds } from '../src/format';

// The old per-call forms each formatter replaces (the oracle).
const oracle: Array<[Intl.DateTimeFormat, (date: Date) => string]> = [
  [timeWithSeconds, (date) => date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })],
  [timeOfDay, (date) => date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })],
  [dayMonth, (date) => date.toLocaleDateString('pl-PL', { day: '2-digit', month: 'short' })],
  [dayMonthYear, (date) => date.toLocaleDateString('pl-PL', { day: '2-digit', month: 'short', year: 'numeric' })],
  [monthDayTime, (date) => date.toLocaleString('pl-PL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })],
  [mediumDateShortTime, (date) => date.toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })],
];

test('shared formatters match the per-call toLocale*String output', () => {
  const samples = [
    '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z',
    '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z', '2026-05-05T09:08:07.123Z',
  ];
  for (let i = 0; i < 400; i++) samples.push(new Date(Date.UTC(2025, 0, 1) + i * 23 * 3_600_000 + i * 61_007).toISOString());
  for (const value of samples) {
    for (const [format, legacy] of oracle) assert.equal(formatDate(format, value), legacy(new Date(value)), value);
  }
  // Numbers, Date objects and local calendar dates (formatAnalyticsDate) go through the same path.
  const local = new Date(2026, 9, 3);
  assert.equal(formatDate(dayMonth, local), local.toLocaleDateString('pl-PL', { day: '2-digit', month: 'short' }));
  assert.equal(formatDate(timeOfDay, local.getTime()), local.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }));
});

test('invalid dates read "Invalid Date" as before instead of throwing', () => {
  for (const [format, legacy] of oracle) assert.equal(formatDate(format, 'not a date'), legacy(new Date('not a date')));
});
