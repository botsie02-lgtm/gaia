import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { resourceUnits, transferResources } from '../.sim-test/resource-actions/index.js';
import { createWorld, stepWorld, snapshot } from '../.sim-test/world.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
const sample = (ownerId, massKg=8, temperatureC=20) =>
  ({ ownerId, massKg, temperatureC, materialId:'wood', phase:'solid' });
const owners = ['deposit:1','agent:2', ...Array.from({length:64},(_,i)=>'hub:'+(i+3))];
const calibration = [{resourceId:'wood', materialId:'wood', kgPerUnit:2}];
const time = fn => { const start=performance.now(); const result=fn(); return [performance.now()-start,result]; };
function synthetic(n) {
  const store = PhysicalInventory.initialize([sample(owners[0]), sample(owners[0],8,60),
    ...Array.from({length:n-2},(_,i)=>sample(owners[2+i%64],8,10+i%40))]);
  const start=store.snapshot();
  let sum=0;
  const [lookupMs]=time(()=>{for(let i=0;i<2000;i++) sum+=store.forOwner(owners[i%2]).length;});
  assert.equal(sum,2000);
  sum=0;
  const [projectionMs]=time(()=>{for(let i=0;i<1000;i++) sum+=resourceUnits(store,owners,owners[i%2],'wood',calibration);});
  assert.equal(sum,4000);
  let commitMs=0;
  const original=store.transact.bind(store);
  // Instrument only this benchmark instance; no clocks enter simulation state.
  store.transact=(...args)=>{const [ms,result]=time(()=>original(...args));commitMs+=ms;return result;};
  const receipts=[];
  const [transferMs]=time(()=>{for(let i=0;i<200;i++) {
    const from=owners[i%2],to=owners[1-i%2];
    receipts.push(transferResources(store,store.revision,owners,from,to,[{materialId:'wood',massKg:2}]));
  }});
  const end=store.snapshot();
  const total = s=>s.samples.reduce((a,b)=>a+b.massKg,0);
  const energy = s=>s.samples.reduce((a,b)=>a+sensibleEnergyJ(b),0);
  assert.equal(total(start),total(end));
  assert.ok(Math.abs(energy(start)-energy(end))<=1e-12*energy(start));
  return {lookupMs,projectionMs,transferMs,commitMs,nonCommitMs:transferMs-commitMs,
    deterministic:{digest:hash([receipts,end]),initialSamples:n,finalSamples:end.samples.length}};
}
function world(seed,agentMode) {
  const w=createWorld(seed,{agentMode,resourceMode:'physical'});
  const initial=w.physicalInventory.snapshot();
  const [tickMs]=time(()=>{for(let i=0;i<200;i++)stepWorld(w);});
  const end=w.physicalInventory.snapshot();
  for(const materialId of ['wood','stone']) {
    const total=s=>s.samples.filter(x=>x.materialId===materialId).reduce((a,b)=>a+b.massKg,0);
    assert.equal(total(initial),total(end));
  }
  const energy=s=>s.samples.reduce((a,b)=>a+sensibleEnergyJ(b),0);
  assert.ok(Math.abs(energy(initial)-energy(end))<=1e-12*energy(initial));
  return {tickMs,deterministic:{digest:hash(snapshot(w)),inventoryDigest:hash(end),
    initialSamples:initial.samples.length,finalSamples:end.samples.length}};
}
function report(name,fn) {
  const warmup=fn();
  const runs=Array.from({length:3},fn);
  for(const r of runs)assert.deepEqual(r.deterministic,warmup.deterministic);
  const timings=Object.fromEntries(Object.keys(warmup).filter(k=>k!=='deterministic')
    .map(k=>[k,median(runs.map(r=>r[k]))]));
  console.log('GAIA_INVENTORY_BENCH '+JSON.stringify({name,timings,deterministic:warmup.deterministic}));
}
export function runInventoryBenchmark() {
  console.log('GAIA_INVENTORY_ENV '+JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
    repetitions:3,warmups:1,heapBeforeBytes:process.memoryUsage().heapUsed}));
  for(const n of [100,1000,10000])report('synthetic:'+n,()=>synthetic(n));
  for(const seed of [42,12345,2026])for(const mode of ['legacy','knowledge'])
    report('world:'+seed+':'+mode,()=>world(seed,mode));
  console.log('GAIA_INVENTORY_HEAP_AFTER '+process.memoryUsage().heapUsed);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) runInventoryBenchmark();
