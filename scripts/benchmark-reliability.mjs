import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runDiagnosticSession } from '../.sim-test/diagnostics/index.js';

export const shortScenarios = [
  { seed: 42, ticks: 200, agentMode: 'knowledge', resourceMode: 'physical', thermal: false },
  { seed: 42, ticks: 200, agentMode: 'knowledge', resourceMode: 'physical', thermal: true },
  { seed: 12345, ticks: 200, agentMode: 'knowledge', perceptionRange: 2, memoryCapacity: 32, resourceMode: 'physical', thermal: true },
  { seed: 2026, ticks: 200, agentMode: 'legacy', resourceMode: 'physical', thermal: true, kgPerUnit: { wood: 0.5, stone: 1.25 }, initialTemperatureC: { wood: 90, stone: 10 } },
];
export const extendedScenarios = [
  { seed: 7, ticks: 1000, agentCount: 3, agentMode: 'knowledge', perceptionRange: 2, memoryCapacity: 32, resourceMode: 'physical', thermal: false },
  { seed: 7, ticks: 1000, agentCount: 3, agentMode: 'knowledge', perceptionRange: 2, memoryCapacity: 32, resourceMode: 'physical', thermal: true },
  { seed: 2026, ticks: 5000, agentCount: 1, agentMode: 'legacy', resourceMode: 'physical', thermal: true },
  { seed: 42, ticks: 1000, agentMode: 'knowledge', perceptionRange: 0, resourceMode: 'physical', thermal: true },
];
const sum = o => o.wood + o.stone;
export function measure(config) {
  const before = process.memoryUsage(), start = performance.now();
  const { report: r, finalSnapshot } = runDiagnosticSession(config);
  const elapsedMs = performance.now() - start, after = process.memoryUsage();
  const row = { config: r.config, physical: r.physical, harvested: sum(r.harvested), delivered: sum(r.delivered),
    firstConstructionTick: r.firstConstructionTick, resources: r.resources, fullCargo: r.fullCargo,
    outcomes: r.outcomes, movement: r.movement, maxIdleRun: Math.max(...r.agents.map(a => a.movement.maxIdleRun)),
    snapshotSha256: createHash('sha256').update(finalSnapshot).digest('hex') };
  return { row, timing: { elapsedMs, heapUsedBefore: before.heapUsed, heapUsedAfter: after.heapUsed, rssAfter: after.rss, node: process.version } };
}
export function printMeasurement(config) {
  const result = measure(config);
  console.log('GAIA_RELIABILITY ' + JSON.stringify(result.row));
  console.log('GAIA_RELIABILITY_TIMING ' + JSON.stringify({ seed: config.seed, ticks: config.ticks, thermal: config.thermal, ...result.timing }));
  return result.row;
}
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  const configs = arg === '--extended' ? extendedScenarios : arg ? [JSON.parse(arg)] : shortScenarios;
  let failed = false;
  for (const c of configs) {
    const row = printMeasurement(c);
    if (row.physical && Object.values(row.physical.failures).some(n => n !== 0)) failed = true;
  }
  if (failed) process.exitCode = 1;
}
