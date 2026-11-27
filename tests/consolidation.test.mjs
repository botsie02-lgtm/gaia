import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { consolidateSamples, MAX_CONSOLIDATION_PAIRS } from '../.sim-test/inventory/consolidation/index.js';
import { transferResources } from '../.sim-test/resource-actions/index.js';
import { thermalContacts } from '../.sim-test/environment/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';

const hub='hub:1',agent='agent:2';
const sample=(massKg=2, temperatureC=20, materialId='wood', ownerId=hub,phase=materialId==='water'?'liquid':'solid')=>
  ({ownerId,materialId,phase,massKg,temperatureC});
const run=(store,maxPairs=256,excludedSampleIds=[],ownerId=hub,revision=store.revision)=>
  consolidateSamples(store,revision,{ownerId,maxPairs,excludedSampleIds});
const energy=store=>store.snapshot().samples.reduce((a,s)=>a+sensibleEnergyJ(s),0);
const mass=store=>store.snapshot().samples.reduce((a,s)=>a+s.massKg,0);
function fails(store,fn){
  const before=store.snapshot(), owners=[hub,agent,'hub:3'];
  const views=owners.map(o=>store.forOwner(o));
  assert.throws(fn);assert.deepEqual(store.snapshot(),before);
  assert.deepEqual(owners.map(o=>store.forOwner(o)),views);
  assert.equal(store.nextSampleId,before.nextSampleId);
  assert.equal(store.revision,before.revision);
}

test('exact compatibility preserves owner, material, phase and distinct temperatures',()=>{
  const store=PhysicalInventory.initialize([
    sample(2,20),sample(4,20),sample(3,20+Number.EPSILON*16),
    sample(3,20,'stone'),sample(2,20,'wood',agent),
    sample(2,20,'water'),sample(3,20,'water'),sample(2,20,'water',agent),
  ]);
  const before=mass(store),e=energy(store);
  const r=run(store);
  assert.deepEqual(r.retiredIds,[1,2,6,7]);assert.deepEqual(r.createdIds,[9,10]);
  assert.deepEqual(r.lineage.map(x=>[x.sourceIds,x.resultId,x.sourceMassKg,x.resultMassKg]),
    [[[1,2],9,[2,4],6],[[6,7],10,[2,3],5]]);
  assert.equal(store.get(9).temperatureC,20);assert.equal(store.get(10).phase,'liquid');
  assert.equal(store.get(3).temperatureC,20+Number.EPSILON*16);
  assert.equal(store.get(4).materialId,'stone');assert.equal(store.get(5).ownerId,agent);
  assert.equal(mass(store),before);assert.ok(Math.abs(energy(store)-e)<=1e-12*e);
  assert.deepEqual(store.forOwner(hub).map(s=>s.sampleId),[3,4,9,10]);
  assert.equal(r.previousRevision,0);assert.equal(r.revision,1);
  for(const x of [r,r.lineage,r.lineage[0],r.lineage[0].sourceIds,r.lineage[0].sourceMassKg,r.createdIds,r.retiredIds])
    assert.ok(Object.isFrozen(x));
  assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
});

test('stable second-ID ordering, disjoint pairs, bounded budgets and no-op semantics',()=>{
  const store=PhysicalInventory.initialize([sample(1,20),sample(1,80),sample(1,80),sample(1,20),
    sample(1,20),sample(1,20)]);
  const r=run(store,2);
  assert.deepEqual(r.retiredIds,[2,3,1,4]);assert.deepEqual(r.createdIds,[7,8]);
  assert.deepEqual(store.forOwner(hub).map(s=>s.sampleId),[5,6,7,8]);
  const r2=run(store,1);
  assert.deepEqual(r2.retiredIds,[5,6]);assert.deepEqual(r2.createdIds,[9]);
  assert.deepEqual(run(store,1).retiredIds,[8,9]);
  const before=store.snapshot(),noop=run(store);
  assert.equal(noop.revision,before.revision);assert.deepEqual(noop.lineage,[]);
  assert.deepEqual(store.snapshot(),before);
  assert.deepEqual(run(store,1,[],'empty:1').createdIds,[]);
  const large=PhysicalInventory.initialize(Array.from({length:MAX_CONSOLIDATION_PAIRS*2+2},()=>sample()));
  assert.equal(run(large).lineage.length,MAX_CONSOLIDATION_PAIRS);
});

test('explicit exclusions protect reservations across requests and validate live IDs',()=>{
  const store=PhysicalInventory.initialize([sample(),sample(),sample(),sample(),sample(2,20,'wood',agent)]);
  const protectedSample=store.get(1);
  const r=run(store,256,[5,1]);
  assert.deepEqual(r.retiredIds,[2,3]);assert.deepEqual(store.get(1),protectedSample);
  assert.deepEqual(run(store,256,[1,4,5]).lineage,[]);
  for(const ids of [[0],[99],[1,1],[2],[NaN],null])fails(store,()=>run(store,1,ids));
  fails(store,()=>consolidateSamples(store,store.revision,{ownerId:hub,maxPairs:1}));
  assert.equal(store.get(5).ownerId,agent);
});

test('invalid and stale requests are rejected before mutation, including no-op',()=>{
  const store=PhysicalInventory.initialize([sample(),sample()]);
  for(const n of [0,-1,1.5,NaN,Infinity,MAX_CONSOLIDATION_PAIRS+1])fails(store,()=>run(store,n));
  for(const owner of ['',null,'  '])fails(store,()=>run(store,1,[],owner));
  for(const rev of [-1,1,NaN])fails(store,()=>run(store,1,[],hub,rev));
  run(store);fails(store,()=>run(store,1,[],hub,0));
});

test('late numerical failure rolls back earlier staged pairs and allocation cursor',()=>{
  const store=PhysicalInventory.initialize([sample(),sample(),sample(1e16),sample(.25)]);
  fails(store,()=>run(store,2));
  const r=run(store,1);assert.deepEqual(r.createdIds,[5]);assert.equal(store.revision,1);
  assert.equal(store.get(3).massKg,1e16);assert.equal(store.get(4).massKg,.25);
  const extreme=PhysicalInventory.initialize([sample(5e302,0,'stone'),sample(5e302,0,'stone')]);
  fails(extreme,()=>run(extreme));
  const saved=PhysicalInventory.initialize([sample(),sample()]).snapshot();
  const exhausted=PhysicalInventory.restore({...saved,nextSampleId:Number.MAX_SAFE_INTEGER});
  fails(exhausted,()=>run(exhausted));
  const revisionLimit=PhysicalInventory.restore({...saved,revision:Number.MAX_SAFE_INTEGER});
  fails(revisionLimit,()=>run(revisionLimit));
});

test('snapshot continuation reproduces lineage, receipts, and monotonic IDs',()=>{
  const store=PhysicalInventory.initialize(Array.from({length:9},()=>sample()));
  run(store,2,[1]);
  const restored=PhysicalInventory.restore(JSON.parse(JSON.stringify(store.snapshot())));
  for(let i=0;i<4;i++){
    assert.deepEqual(run(store,2,[1]),run(restored,2,[1]));
    assert.deepEqual(store.snapshot(),restored.snapshot());
  }
  assert.ok(store.snapshot().nextSampleId>10);
  assert.equal(store.get(1).massKg,2);
  assert.deepEqual(store.forOwner(hub).map(x=>x.massKg).sort((a,b)=>a-b),[2,16]);
});

test('retirement changes transfer selection and thermal ring anchors explicitly',()=>{
  const a=PhysicalInventory.initialize([sample(2,20),sample(2,20),sample(2,80)]);
  const b=PhysicalInventory.restore(a.snapshot());
  const fixture=physicalInventory=>({physicalInventory,resourceMode:'physical',
    hub:{id:1,x:0,y:0},structures:[],width:1,height:1,terrain:['grass']});
  assert.deepEqual(thermalContacts(fixture(a)).map(e=>[e.a,e.b]),[[1,2],[2,3],[3,1]]);
  run(b,1);
  assert.deepEqual(thermalContacts(fixture(b)).map(e=>[e.a,e.b]),[[3,4]]);
  const cursor=1;
  assert.equal(thermalContacts(fixture(a)).find(e=>e.a>cursor).a,2);
  assert.equal(thermalContacts(fixture(b)).find(e=>e.a>cursor).a,3);
  const move=store=>transferResources(store,store.revision,[hub,agent],hub,agent,[{materialId:'wood',massKg:2}]);
  assert.equal(move(a).materials[0].samples[0].sourceSampleId,1);
  assert.equal(move(b).materials[0].samples[0].sourceSampleId,3);
  assert.equal(a.forOwner(agent)[0].temperatureC,20);
  assert.equal(b.forOwner(agent)[0].temperatureC,80);
  assert.equal(mass(a),mass(b));assert.ok(Math.abs(energy(a)-energy(b))<=1e-12*energy(a));
});
