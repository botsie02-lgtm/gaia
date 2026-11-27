// Compile using tsc -p tsconfig.sim.json before executing.
import { performance } from 'node:perf_hooks';
import { baselineScenarios, runDiagnostics } from '../.sim-test/diagnostics/index.js';

const configs = process.argv.length > 2 ? [JSON.parse(process.argv[2])] : baselineScenarios();
const runs = configs.map(config => {
  const start = performance.now();
  const report = runDiagnostics(config);
  const elapsedMs = performance.now() - start;
  return { report, benchmark: { elapsedMs, heapUsedBytesAfter: process.memoryUsage().heapUsed,
    node: process.version } };
});
console.log(JSON.stringify(runs, null, 2));
