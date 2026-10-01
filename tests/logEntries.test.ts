import test from 'node:test';
import assert from 'node:assert/strict';
import { LOG_LIMIT, mergeLogs, prependLog } from '../src/logEntries';
import type { LogEntry } from '../src/types';

const entry = (id: number): LogEntry => ({ id, at: new Date(id * 1000).toISOString(), level: 'info', scope: 'watch', message: `line ${id}` });
const ids = (logs: LogEntry[]) => logs.map((log) => log.id);

test('live lines received while GET /api/logs was in flight survive its response', () => {
  // The response was built at line 10; lines 11 and 12 arrived over SSE first.
  const fetched = [10, 9, 8].map(entry);
  assert.deepEqual(ids(mergeLogs([12, 11].map(entry), fetched)), [12, 11, 10, 9, 8]);
  // A line already in the response is not duplicated.
  assert.deepEqual(ids(mergeLogs([11, 10].map(entry), fetched)), [11, 10, 9, 8]);
  assert.equal(mergeLogs([], fetched), fetched);
});

test('after a server restart the ids start over and the live lines still come first', () => {
  assert.deepEqual(ids(mergeLogs([3].map(entry), [2, 1].map(entry))), [3, 2, 1]);
});

test('merged and prepended logs stay within the server buffer size', () => {
  const fetched = Array.from({ length: LOG_LIMIT }, (_, index) => entry(LOG_LIMIT - index));
  const merged = mergeLogs([entry(LOG_LIMIT + 2), entry(LOG_LIMIT + 1)], fetched);
  assert.equal(merged.length, LOG_LIMIT);
  assert.deepEqual(ids(merged).slice(0, 3), [LOG_LIMIT + 2, LOG_LIMIT + 1, LOG_LIMIT]);
  const prepended = prependLog(fetched, entry(LOG_LIMIT + 1));
  assert.equal(prepended.length, LOG_LIMIT);
  assert.equal(prepended[0].id, LOG_LIMIT + 1);
  assert.equal(prependLog(prepended, entry(LOG_LIMIT + 1)), prepended, 'a repeated line is ignored');
});
