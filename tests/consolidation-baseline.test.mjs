import test from 'node:test';
import { fragment, scenarios } from '../scripts/benchmark-consolidation.mjs';
test('physical World fragmentation baseline',()=>{
  for(const config of scenarios) console.log('GAIA_CONSOLIDATION_BASELINE '+JSON.stringify(fragment(config).row));
});
