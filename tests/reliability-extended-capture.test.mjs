// One-time extended baseline capture. Removed from default CI after measuring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extendedScenarios, printMeasurement } from '../scripts/benchmark-reliability.mjs';
test('capture extended reliability scenarios', () => {
  for (const c of extendedScenarios) {
    const row = printMeasurement(c);
    assert.ok(Object.values(row.physical.failures).every(n => n === 0), JSON.stringify(row.physical));
  }
});
