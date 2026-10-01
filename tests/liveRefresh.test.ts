import test from 'node:test';
import assert from 'node:assert/strict';
import { allLiveResources, eventResources, planFlush, streamDecidesConnection, type LiveResource } from '../src/liveRefresh';
import type { View } from '../src/types';

const views: View[] = ['overview', 'search', 'watches', 'market-research', 'analytics', 'listings', 'connectors', 'logs', 'settings'];
const dirtyAfter = (...events: string[]) => new Set<LiveResource>(events.flatMap((event) => eventResources[event] ?? []));

test('a scan refetches only what the visible view renders', () => {
  const fetched = Object.fromEntries(views.map((view) => {
    const plan = planFlush(view, dirtyAfter('scan'), true, false);
    return [view, [plan.dashboard && 'dashboard', plan.connectors && 'connectors', plan.page].filter(Boolean)];
  }));
  assert.deepEqual(fetched, {
    overview: ['dashboard'],
    search: [],
    watches: [],
    'market-research': [],
    analytics: ['analytics'],
    listings: ['listings'],
    connectors: ['connectors'],
    logs: [],
    settings: [],
  });
});

test('flags stay dirty for views that are not shown, except pages that fetch on mount', () => {
  const plan = planFlush('settings', dirtyAfter('scan', 'market-watch'), true, false);
  assert.deepEqual(plan.clear.sort(), ['analytics', 'listings', 'market']);
  const overview = planFlush('overview', dirtyAfter('scan'), true, false);
  assert.deepEqual(overview.clear.sort(), ['analytics', 'connectors', 'dashboard', 'listings', 'watchList']);
});

test('analytics and watches load the dashboard for watch names only when needed', () => {
  assert.equal(planFlush('analytics', dirtyAfter('scan'), true, false).dashboard, false);
  assert.equal(planFlush('analytics', dirtyAfter('watch'), true, false).dashboard, true);
  assert.equal(planFlush('watches', dirtyAfter('watch'), true, false).dashboard, false);
  assert.equal(planFlush('watches', new Set(allLiveResources), false, false).dashboard, true);
  assert.equal(planFlush('analytics', new Set(allLiveResources), false, false).dashboard, true);
});

test('deep links load only their own data', () => {
  for (const view of ['listings', 'logs', 'settings', 'search', 'market-research', 'connectors'] as View[]) {
    assert.equal(planFlush(view, new Set(allLiveResources), false, false).dashboard, false, view);
  }
  assert.equal(planFlush('overview', new Set(allLiveResources), false, false).dashboard, true);
});

test('an in-flight dashboard request defers the refetch and keeps it dirty', () => {
  const plan = planFlush('overview', dirtyAfter('scan'), true, true);
  assert.equal(plan.dashboard, false);
  assert.ok(!plan.clear.includes('dashboard'));
});

test('verification events and research scans never touch the dashboard', () => {
  assert.equal(eventResources['ai-description-verification'], undefined);
  assert.deepEqual(eventResources['market-watch'], ['market']);
  assert.equal(planFlush('overview', dirtyAfter('market-watch'), true, false).dashboard, false);
});

test('outside Overview, a failed dashboard fetch does not keep the offline banner', () => {
  // After a failure the dashboard resources are dirty again.
  const dirty = new Set<LiveResource>(['dashboard', 'connectors', 'watchList']);
  const decides = (view: View) => streamDecidesConnection(view, planFlush(view, dirty, true, false));
  assert.equal(decides('overview'), false);
  assert.equal(decides('analytics'), false, 'Analytics refetches the dashboard, and its result decides');
  for (const view of ['listings', 'watches', 'logs', 'settings', 'search', 'market-research', 'connectors'] as View[]) {
    assert.equal(decides(view), true, view);
  }
});
