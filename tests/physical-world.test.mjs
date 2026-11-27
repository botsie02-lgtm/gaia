import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld, stepWorld, snapshot, executeAgentAction, CARGO_LIMIT, HEARTH_COST } from '../.sim-test/world.js';
import { resourceOwnerId } from '../.sim-test/resource-actions/index.js';
import { PhysicalInventory } from '../.sim-test/inventory/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';

const run = (w, n) => { for (let i = 0; i < n; i++) stepWorld(w); };
const samples = w => w.physicalInventory.snapshot().samples;
const totals = w => Object.fromEntries(['wood','stone'].map(m => [m,
  samples(w).filter(s => s.materialId === m).reduce((sum,s) => sum+s.massKg,0)]));
const energy = w => samples(w).reduce((sum,s) => sum+sensibleEnergyJ(s),0);
const at = (a, p) => Object.assign(a, { x:p.x, y:p.y, energy:100, resting:false });
const harvest = (w,a,d) => executeAgentAction(w,a,{kind:'harvest',targetId:d.id});
const deliver = (w,a) => executeAgentAction(w,a,{kind:'deliver',targetId:w.hub.id});

test('resource mode independent of agent mode; calibrated initialization and readonly projections', () => {
  for (const agentMode of ['legacy','knowledge']) {
    assert.equal(createWorld(42,{agentMode}).physicalInventory,null);
    const w = createWorld(42,{agentMode,resourceMode:'physical',kgPerUnit:{wood:0.5,stone:4},
      initialTemperatureC:{wood:25,stone:30}});
    assert.equal(w.agentMode,agentMode);
    assert.ok(w.physicalInventory instanceof PhysicalInventory);
    for (const d of w.deposits) {
      const [s] = w.physicalInventory.forOwner(resourceOwnerId('deposit',d.id));
      assert.equal(s.massKg,d.amount*(d.material==='wood'?0.5:4));
      assert.equal(s.temperatureC,d.material==='wood'?25:30);
      assert.throws(()=>{d.amount=99});
    }
    assert.throws(()=>{w.inventory.wood=1});
    assert.throws(()=>{w.agents[0].cargo={wood:1,stone:0}});
    assert.throws(()=>{w.agents[0].cargo.wood=1});
    assert.throws(()=>{w.physicalInventory=null});
  }
  assert.throws(()=>createWorld(1,{resourceMode:'unknown'}));
  assert.throws(()=>createWorld(1,{resourceMode:'physical',kgPerUnit:{wood:0,stone:1}}));
  assert.throws(()=>createWorld(1,{resourceMode:'physical',initialTemperatureC:{wood:-274,stone:1}}));
});

for (const agentMode of ['legacy','knowledge']) {
  test(agentMode+' physical mode conserves matter and sensible energy and reproduces snapshots', () => {
    const a=createWorld(12345,{agentMode,resourceMode:'physical'});
    const b=createWorld(12345,{agentMode,resourceMode:'physical'});
    const initial=totals(a), e=energy(a);
    run(a,180); run(b,180);
    assert.deepEqual(totals(a),initial);
    assert.ok(Math.abs(energy(a)-e)/e<1e-12);
    assert.equal(snapshot(a),snapshot(b));
    assert.ok(a.history.query({kind:'resource.harvested'}).length>0);
    assert.ok(a.history.query({kind:'stockpile.delivered'}).length>0);
    assert.equal(a.history.query({kind:'hearth.fuel_consumed'}).length,0);
    assert.ok(a.agents.every(x=>x.cargo.wood+x.cargo.stone<=CARGO_LIMIT));
    const ids=new Set(samples(a).map(s=>s.sampleId));
    assert.equal(ids.size,samples(a).length);
    const validOwners=new Set([resourceOwnerId('hub',a.hub.id),
      ...a.deposits.map(d=>resourceOwnerId('deposit',d.id)),
      ...a.agents.map(d=>resourceOwnerId('agent',d.id)),
      ...a.structures.map(d=>resourceOwnerId('structure',d.id))]);
    assert.ok(samples(a).every(s=>validOwners.has(s.ownerId)));
    assert.deepEqual(PhysicalInventory.restore(JSON.parse(snapshot(a)).physicalInventory).snapshot(),a.physicalInventory.snapshot());
    assert.equal(a.agents.reduce((s,x)=>s+x.skills.gathering.attempts,0),a.stats.woodHarvested+a.stats.stoneHarvested);
  });
}

test('failed remote, wrong-target, over-capacity and exhausted actions publish no success', () => {
  const w=createWorld(42,{resourceMode:'physical'});
  const a=w.agents[0], d=w.deposits.find(d=>d.amount>=4);
  at(a,w.hub);
  const before=w.physicalInventory.snapshot();
  harvest(w,a,d); deliver(w,a);
  assert.deepEqual(w.physicalInventory.snapshot(),before);
  assert.equal(w.history.size,0);
  at(a,d);
  for(let i=0;i<CARGO_LIMIT;i++) harvest(w,a,d);
  const full=w.physicalInventory.snapshot(), count=w.history.size;
  harvest(w,a,d); deliver(w,a);
  assert.deepEqual(w.physicalInventory.snapshot(),full);
  assert.equal(w.history.size,count);
  assert.equal(a.skills.gathering.attempts,CARGO_LIMIT);
  at(a,w.hub);
  executeAgentAction(w,a,{kind:'deliver',targetId:d.id});
  assert.deepEqual(w.physicalInventory.snapshot(),full);
  deliver(w,a);
  assert.equal(a.cargo.wood+a.cargo.stone,0);
});

test('contested final unit resolves by stable ID, with no duplicate samples or skill awards', () => {
  const w=createWorld(42,{agentMode:'knowledge',resourceMode:'physical',perceptionRange:0});
  const [a,b]=w.agents;
  const d=w.deposits.find(d=>d.amount>=3);
  while(d.amount>1){at(a,d); harvest(w,a,d); at(a,w.hub); deliver(w,a);}
  at(a,d); at(b,d);
  w.agents.reverse();
  const oldA=a.skills.gathering.attempts, oldB=b.skills.gathering.attempts;
  const before=totals(w);
  stepWorld(w);
  assert.equal(a.skills.gathering.attempts,oldA+1);
  assert.equal(b.skills.gathering.attempts,oldB);
  assert.equal(d.amount,0);
  assert.ok(!w.deposits.includes(d));
  assert.equal(w.physicalInventory.forOwner(resourceOwnerId('deposit',d.id)).length,0);
  assert.deepEqual(totals(w),before);
  assert.equal(w.history.query({kind:'resource.depleted',entityId:d.id}).length,1);
});

test('deposit to agent to hub to hearth preserves sample IDs, mass, temperature and fuel', () => {
  const w=createWorld(42,{resourceMode:'physical',agentMode:'knowledge'});
  const initial=totals(w), a=w.agents[0];
  for(const m of ['wood','stone']){
    for(let i=0;i<HEARTH_COST[m];i++){
      const d=w.deposits.find(d=>d.material===m&&d.amount>0);
      at(a,d); harvest(w,a,d);
      const cargo=w.physicalInventory.forOwner(resourceOwnerId('agent',a.id));
      assert.equal(cargo.length,1);
      const sample=cargo[0];
      at(a,w.hub); deliver(w,a);
      assert.deepEqual(w.physicalInventory.get(sample.sampleId),{...sample,ownerId:resourceOwnerId('hub',w.hub.id)});
    }
  }
  const hubOwner=resourceOwnerId('hub',w.hub.id);
  const allocated=w.physicalInventory.forOwner(hubOwner);
  const buildTile=w.hub.y*w.width+w.hub.x+2;
  w.terrain[buildTile]='water';
  const next=w.nextEntityId;
  // All agents rest; a blocked construction site cannot allocate material.
  for(const ag of w.agents) Object.assign(ag,{energy:0,resting:true});
  const before=w.physicalInventory.snapshot();
  stepWorld(w);
  assert.deepEqual(w.physicalInventory.snapshot(),before);
  assert.equal(w.nextEntityId,next);
  assert.equal(w.structures.length,0);
  w.terrain[buildTile]='grass';
  stepWorld(w);
  const h=w.structures[0], owner=resourceOwnerId('structure',h.id);
  assert.equal(h.id,next);
  assert.equal(h.stoneUsed,HEARTH_COST.stone);
  assert.equal(h.fuel,HEARTH_COST.wood);
  assert.deepEqual(w.physicalInventory.forOwner(owner),allocated.map(s=>({...s,ownerId:owner})));
  const built=w.history.query({kind:'structure.built'})[0];
  assert.equal(built.details.physical.toOwnerId,owner);
  assert.equal(built.details.physical.materials.length,2);
  run(w,90);
  assert.equal(h.heat,0);
  assert.equal(h.fuel,HEARTH_COST.wood);
  assert.deepEqual(totals(w),initial);
});
