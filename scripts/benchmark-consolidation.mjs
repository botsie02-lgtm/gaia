import { createWorld, stepWorld } from '../.sim-test/world.js';
import { resourceOwnerId } from '../.sim-test/resource-actions/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

export const scenarios = [
  {seed:2026,ticks:5000,agentCount:1,agentMode:'legacy',thermal:true},
  {seed:42,ticks:200,agentCount:14,agentMode:'knowledge',thermal:false},
  {seed:42,ticks:200,agentCount:14,agentMode:'knowledge',thermal:true},
];
export function totals(snapshot) {
  const mass={}; let energy=0;
  for(const s of snapshot.samples){mass[s.materialId]=(mass[s.materialId]??0)+s.massKg;energy+=sensibleEnergyJ(s);}
  return {mass,energy};
}
export function assertConserved(before,after){
  assert.deepEqual(after.mass,before.mass);
  assert.ok(Math.abs(after.energy-before.energy)<=1e-12*Math.max(before.energy,after.energy));
}
export function fragment(config){
  const {seed,ticks,agentCount,...options}=config;
  const w=createWorld(seed,{...options,resourceMode:'physical',eventCapacity:1});
  w.agents.splice(agentCount);
  const initial=w.physicalInventory.snapshot();
  const start=performance.now();
  for(let i=0;i<ticks;i++)stepWorld(w);
  const elapsedMs=performance.now()-start;
  const end=w.physicalInventory.snapshot(),hub=resourceOwnerId('hub',w.hub.id);
  assertConserved(totals(initial),totals(end));
  return {snapshot:end,hub, row:{config,initial:initial.samples.length,final:end.samples.length,
    hub:w.physicalInventory.forOwner(hub).length,elapsedMs}};
}

import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { consolidateSamples } from '../.sim-test/inventory/consolidation/index.js';
import { transferResources } from '../.sim-test/resource-actions/index.js';
import { pathToFileURL } from 'node:url';

const time=fn=>{const start=performance.now();const value=fn();return {ms:performance.now()-start,value};};
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const ownerMass=(store,owner,material)=>store.forOwner(owner).filter(s=>s.materialId===material).reduce((sum,s)=>sum+s.massKg,0);
function compact(snapshot,hub){
  const store=PhysicalInventory.restore(snapshot);
  let pairs=0,batches=0;
  const {ms}=time(()=>{
    for(let i=0;i<=snapshot.samples.length;i++){
      const r=consolidateSamples(store,store.revision,{ownerId:hub,maxPairs:64,excludedSampleIds:[]});
      if(!r.lineage.length)return;
      pairs+=r.lineage.length;batches++;
    }
    throw Error('Consolidation did not terminate');
  });
  const end=store.snapshot();
  assertConserved(totals(snapshot),totals(end));
  assert.equal(end.samples.length,snapshot.samples.length-pairs);
  assert.equal(end.nextSampleId,snapshot.nextSampleId+pairs);
  assert.equal(end.revision,snapshot.revision+batches);
  for(const material of Object.keys(totals(snapshot).mass)){
    const before=snapshot.samples.filter(s=>s.ownerId===hub&&s.materialId===material).reduce((a,s)=>a+s.massKg,0);
    assert.equal(ownerMass(store,hub,material),before);
  }
  return {snapshot:end,pairs,batches,ms,hub:store.forOwner(hub).length};
}
function workload(snapshot,hub){
  const store=PhysicalInventory.restore(snapshot);
  let count=0;
  const lookup=time(()=>{for(let i=0;i<2000;i++)count+=store.forOwner(hub).length;});
  assert.equal(count,2000*store.forOwner(hub).length);
  // Detached benchmark recipient; no live World is modified or advanced.
  const recipient='agent:9007199254740000', owners=[...new Set(snapshot.samples.map(s=>s.ownerId)),recipient];
  assert.ok(!snapshot.samples.some(s=>s.ownerId===recipient));
  assert.ok(ownerMass(store,hub,'wood')>=8);
  let operations=0;
  const before=totals(snapshot);
  const transfer=time(()=>{
    for(let i=0;i<200;i++){
      const from=i%2?recipient:hub, to=i%2?hub:recipient;
      const r=transferResources(store,store.revision,owners,from,to,[{materialId:'wood',massKg:8}]);
      operations+=r.materials[0].samples.length+r.createdSampleIds.length;
    }
  });
  assertConserved(before,totals(store.snapshot()));
  assert.equal(store.forOwner(recipient).length,0);
  assert.equal(ownerMass(store,hub,'wood'),snapshot.samples.filter(s=>s.ownerId===hub&&s.materialId==='wood').reduce((a,s)=>a+s.massKg,0));
  return {lookupMs:lookup.ms,transferMs:transfer.ms,operations,finalHub:store.forOwner(hub).length};
}
export function compareConsolidation(config){
  const {snapshot,hub,row}=fragment(config);
  const warm=compact(snapshot,hub);
  const compacted=Array.from({length:3},()=>compact(snapshot,hub));
  for(const r of compacted)assert.deepEqual(r.snapshot,warm.snapshot);
  workload(snapshot,hub);workload(warm.snapshot,hub);
  const before=[],after=[];
  for(let i=0;i<3;i++){
    if(i%2){after.push(workload(warm.snapshot,hub));before.push(workload(snapshot,hub));}
    else{before.push(workload(snapshot,hub));after.push(workload(warm.snapshot,hub));}
  }
  const summary=xs=>({lookupMs:median(xs.map(x=>x.lookupMs)),transferMs:median(xs.map(x=>x.transferMs)),
    operations:xs[0].operations,finalHub:xs[0].finalHub});
  return {...row,consolidated:warm.snapshot.samples.length,consolidatedHub:warm.hub,pairs:warm.pairs,batches:warm.batches,
    consolidationMs:median(compacted.map(x=>x.ms)),before:summary(before),after:summary(after),
    energyDeltaJ:totals(warm.snapshot).energy-totals(snapshot).energy};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  for(const config of scenarios)console.log('GAIA_CONSOLIDATION '+JSON.stringify(compareConsolidation(config)));
}
