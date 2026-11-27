import test from 'node:test';
import { runInventoryBenchmark } from '../scripts/benchmark-inventory.mjs';

test('inventory performance scenarios preserve deterministic outcomes and conservation', runInventoryBenchmark);
