import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { transferResources, resourceMassKg } from '../.sim-test/resource-actions/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';

const owners=['deposit:1','agent:2','hub:3','structure:4','agent:5'];
const sample=(ownerId,massKg=8,temperatureC=20)=>({ownerId,massKg,temperatureC,materialId:'wood',phase:'solid'});
const transfer=(sampleId,fromOwnerId,toOwnerId)=>({kind:'transfer',sampleId,fromOwnerId,toOwnerId});
const heat=(a,b)=>({kind:'heat',a,b,contact:{conductanceWPerK:5,tickDurationSeconds:1}});
const check=store=>{
  const snapshot=store.snapshot();
  assert.equal(store.nextSampleId,snapshot.nextSampleId);
  assert.equal(store.revision,snapshot.revision);
  for(const ownerId of [...owners,'empty:never']){
    const expected=snapshot.samples.filter(s=>s.ownerId===ownerId).sort((a,b)=>a.sampleId-b.sampleId);
    const actual=store.forOwner(ownerId);
    assert.deepEqual(actual,expected);
    assert.ok(Object.isFrozen(actual));
    for(const s of actual) assert.equal(s,store.get(s.sampleId));
  }
  assert.equal(new Set(snapshot.samples.map(s=>s.sampleId)).size,snapshot.samples.length);
  return snapshot;
};
const sum=(snapshot,f)=>snapshot.samples.reduce((n,s)=>n+f(s),0);

test('seeded mixed transactions and shuffled restores match independent full scans',()=>{
  function run(){
    let state=0x16ccecae;
    const pick=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/2**32*n);};
    let store=PhysicalInventory.initialize(Array.from({length:20},(_,i)=>sample(owners[i%4],8,10+i*3)));
    const initial=check(store);
    const initialMass=sum(initial,s=>s.massKg), initialEnergy=sum(initial,sensibleEnergyJ);
    const counts={transfer:0,split:0,combine:0,heat:0,rollback:0,restore:0};
    for(let i=0;i<600;i++){
      const before=check(store), samples=before.samples;
      const a=samples[pick(samples.length)], b=samples[(samples.indexOf(a)+1+pick(samples.length-1))%samples.length];
      const others=owners.filter(o=>o!==a.ownerId), to=others[pick(others.length)];
      const kind=pick(5);
      if(kind===0){
        store.transact(store.revision,[transfer(a.sampleId,a.ownerId,to)]);counts.transfer++;
      }else if(kind===1){
        const candidates=samples.filter(s=>s.massKg>=2);
        if(candidates.length){
          const parent=candidates[pick(candidates.length)], target=owners.find(o=>o!==parent.ownerId);
          const child=store.nextSampleId;
          const receipt=store.transact(store.revision,[{kind:'split',sampleId:parent.sampleId,massKg:1},transfer(child,parent.ownerId,target)]);
          assert.deepEqual(receipt.createdIds,[child]);counts.split++;
        }
      }else if(kind===2){
        const same=samples.filter(s=>s.ownerId===a.ownerId&&s.sampleId!==a.sampleId);
        if(same.length){
          const peer=same[pick(same.length)];
          const receipt=store.transact(store.revision,[{kind:'combine',a:a.sampleId,b:peer.sampleId}]);
          assert.deepEqual(receipt.retiredIds,[a.sampleId,peer.sampleId]);counts.combine++;
        }
      }else if(kind===3&&samples.length>1){
        store.transact(store.revision,[heat(a.sampleId,b.sampleId)]);counts.heat++;
      }else{
        assert.throws(()=>store.transact(store.revision,[transfer(a.sampleId,a.ownerId,to),
          transfer(a.sampleId,a.ownerId,to)]));
        assert.deepEqual(check(store),before);counts.rollback++;
      }
      const after=check(store);
      assert.equal(sum(after,s=>s.massKg),initialMass);
      assert.ok(Math.abs(sum(after,sensibleEnergyJ)-initialEnergy)<=1e-12*initialEnergy);
      if(i%37===0){
        const shuffled=JSON.parse(JSON.stringify(after));shuffled.samples.reverse();
        store=PhysicalInventory.restore(shuffled);
        assert.deepEqual(check(store),after);counts.restore++;
      }
    }
    for(const [kind,count] of Object.entries(counts))assert.ok(count>0,kind);
    return store.snapshot();
  }
  assert.deepEqual(run(),run());
});

test('index publication respects final staged records and rollback after split, heat, retire and transfer',()=>{
  const store=PhysicalInventory.initialize([sample(owners[0],8,80),sample(owners[1],4,20)]);
  const before=check(store), oldView=store.forOwner(owners[0]);
  const ops=[{kind:'split',sampleId:1,massKg:2},transfer(3,owners[0],owners[1]),
    heat(2,3),{kind:'combine',a:2,b:3},transfer(4,owners[1],owners[2]),
    transfer(4,owners[2],owners[3])];
  assert.throws(()=>store.transact(0,[...ops,transfer(3,owners[1],owners[0])]));
  assert.deepEqual(check(store),before);
  assert.equal(store.nextSampleId,3);
  const receipt=store.transact(0,ops);
  assert.deepEqual(receipt.createdIds,[3,4]);assert.deepEqual(receipt.retiredIds,[2,3]);
  assert.equal(store.forOwner(owners[1]).length,0);
  assert.equal(store.forOwner(owners[2]).length,0);
  assert.equal(store.forOwner(owners[3])[0].sampleId,4);
  assert.equal(store.nextSampleId,5);
  assert.equal(oldView[0].massKg,8);
  check(store);
  assert.throws(()=>store.transact(0,[transfer(1,owners[0],owners[1])]));
  check(store);
});

test('resource planning uses allocation metadata without snapshotting or merging thermal samples',()=>{
  const store=PhysicalInventory.initialize([sample(owners[0],2,10),sample(owners[0],4,80)]);
  const snapshot=store.snapshot.bind(store);
  store.snapshot=()=>{throw Error('full snapshot must not be used for transfer planning');};
  const receipt=transferResources(store,0,owners,owners[0],owners[1],[{materialId:'wood',massKg:3}]);
  assert.deepEqual(receipt.createdSampleIds,[3]);
  assert.equal(resourceMassKg(store,owners,owners[1],'wood'),3);
  assert.deepEqual(store.forOwner(owners[1]).map(s=>[s.sampleId,s.temperatureC]),[[1,10],[3,80]]);
  assert.equal(store.nextSampleId,4);
  store.snapshot=snapshot;
  check(store);
  const restored=PhysicalInventory.restore(store.snapshot());
  assert.deepEqual(check(restored),check(store));
});
