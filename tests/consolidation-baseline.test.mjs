import test from 'node:test';
import { compareConsolidation, scenarios } from '../scripts/benchmark-consolidation.mjs';
test('physical World fragmentation and detached consolidation performance',()=>{
  for(const config of scenarios) console.log('GAIA_CONSOLIDATION '+JSON.stringify(compareConsolidation(config)));
});
