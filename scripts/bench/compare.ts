/**
 * Diffs two scout-bench JSON reports of the same benchmark.
 *
 *   node --import tsx scripts/bench/compare.ts before.json after.json [--threshold=5]
 *
 * Prints every metric present in either report with its change. A change past
 * --threshold percent in the metric's "worse" direction is a regression; the
 * exit code is 1 when there is at least one.
 */

import { readFileSync } from 'node:fs';
import { formatValue, parseArgs, type BenchReport, type Metric } from './lib';

const args = parseArgs();
const [beforePath, afterPath] = args.positional;
if (!beforePath || !afterPath) {
  console.error('usage: compare.ts before.json after.json [--threshold=5]');
  process.exit(2);
}
const threshold = Number(args.flags.get('threshold') ?? 5);
const before = JSON.parse(readFileSync(beforePath, 'utf8')) as BenchReport;
const after = JSON.parse(readFileSync(afterPath, 'utf8')) as BenchReport;
if (before.bench !== after.bench) console.warn(`warning: comparing ${before.bench} with ${after.bench}`);

const beforeById = new Map(before.metrics.map((m) => [m.id, m]));
const afterById = new Map(after.metrics.map((m) => [m.id, m]));
const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];

let regressions = 0;
let improvements = 0;
console.log(`# ${after.bench}: ${before.export.exportedAt ?? beforePath} → ${after.export.exportedAt ?? afterPath} (threshold ${threshold}%)\n`);
for (const id of ids) {
  const a = beforeById.get(id);
  const b = afterById.get(id);
  const metric = (b ?? a) as Metric;
  const va = a?.value ?? null;
  const vb = b?.value ?? null;
  let change = '';
  let verdict = '';
  if (va !== null && vb !== null) {
    const pct = va === 0 ? (vb === 0 ? 0 : Infinity) : ((vb - va) / Math.abs(va)) * 100;
    change = Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : 'new≠0';
    if (metric.better !== 'info' && Math.abs(pct) > threshold) {
      const worse = metric.better === 'lower' ? vb > va : vb < va;
      verdict = worse ? 'REGRESSION' : 'improved';
      if (worse) regressions += 1;
      else improvements += 1;
    }
  } else if (!a) {
    change = 'added';
  } else if (!b) {
    change = 'removed';
  }
  console.log(`${id.padEnd(60)} ${formatValue(va).padStart(12)} → ${formatValue(vb).padStart(12)} ${metric.unit.padEnd(8)} ${change.padStart(8)} ${verdict}`);
}
console.log(`\n${improvements} improved, ${regressions} regressed past ${threshold}%`);
process.exit(regressions ? 1 : 0);
