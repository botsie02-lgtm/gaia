import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemory } from '../.sim-test/memory/index.js';
import { observeAgent } from '../.sim-test/perception/index.js';
import { decideAgent } from '../.sim-test/agents/index.js';
import { createWorld, stepWorld, executeAgentAction, CARGO_LIMIT, snapshot } from '../.sim-test/world.js';
import { runDiagnostics } from '../.sim-test/diagnostics/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';

function corridor(capacity = 32) {
  const w = createWorld(42, { agentMode:'knowledge', perceptionRange:2, memoryCapacity:capacity });
  const a = w.agents[0]; w.agents = [a];
  w.terrain.fill('water');
  for (let x = 10; x <= 24; x++) w.terrain[10*w.width+x] = 'grass';
  Object.assign(w.hub, { x:10, y:10 });
  Object.assign(a, { x:10, y:10, energy:100, resting:false });
  w.deposits = [];
  return { w,a };
}
function deposit(w, x) {
  const d = { id:w.nextEntityId++,kind:'deposit',material:'wood',x,y:10,amount:CARGO_LIMIT };
  w.deposits.push(d); return d;
}
const run = (w,n) => { for(let i=0;i<n;i++) stepWorld(w); };

test('constrained memory preserves a connected observed home corridor and round-trips visit metadata', () => {
  const {w,a} = corridor();
  for (let x=10;x<=20;x++) {
    a.x=x; w.tick++;
    a.memory.update(observeAgent(w,a.id,{range:2}));
  }
  assert.equal(a.memory.query({kind:'hub'})[0].status,'stale');
  for(let x=10;x<=20;x++) {
    const e=a.memory.query({kind:'terrain',x,y:10})[0];
    assert.equal(e.value.terrain,'grass');
    assert.equal(e.lastVisitedTick,x-9);
  }
  assert.ok(a.memory.size<=32);
  const restored=AgentMemory.fromSnapshot(JSON.parse(JSON.stringify(a.memory)));
  assert.deepEqual(restored.snapshot(),a.memory.snapshot());
  w.tick++;
  const obs=observeAgent(w,a.id,{range:2});
  assert.deepEqual(restored.update(obs),a.memory.update(obs));
});

test('agent discovers, harvests and returns along a corridor with bounded memory', () => {
  const {w,a}=corridor();
  deposit(w,20);
  run(w,65);
  assert.ok(w.history.query({kind:'stockpile.delivered'}).length>0);
  assert.equal(w.inventory.wood,CARGO_LIMIT);
  assert.equal(a.skills.gathering.attempts,CARGO_LIMIT);
  assert.ok(a.memory.size<=32);
});

test('full cargo can reconnect a forgotten home route without hidden terrain or hub information', () => {
  const {w,a}=corridor(12);
  // Set up a sequence of genuine local observations on a long known corridor.
  // These fixture positions are not policy moves.
  for(let x=10;x<=22;x++) {
    a.x=x; w.tick++;
    a.memory.update(observeAgent(w,a.id,{range:2}));
  }
  const d=deposit(w,22);
  for(let i=0;i<CARGO_LIMIT;i++) executeAgentAction(w,a,{kind:'harvest',targetId:d.id});
  assert.equal(a.cargo.wood,CARGO_LIMIT);
  assert.equal(a.memory.query({kind:'hub'})[0].status,'stale');
  assert.ok(a.memory.query({kind:'terrain',y:10}).length<13);
  run(w,100);
  assert.equal(w.inventory.wood,CARGO_LIMIT);
  assert.equal(a.cargo.wood,0);
  assert.ok(a.memory.size<=12);
});

test('new observations supersede prioritized hub and terrain evidence', () => {
  const {w,a}=corridor();
  w.tick++;
  a.memory.update(observeAgent(w,a.id,{range:2}));
  w.hub.x=24;
  w.terrain[10*w.width+11]='water';
  w.tick++;
  const obs=observeAgent(w,a.id,{range:2});
  const mem=a.memory.update(obs);
  assert.ok(a.memory.query({kind:'hub'}).every(e=>e.status==='absent'));
  assert.equal(a.memory.query({kind:'terrain',x:11,y:10})[0].value.terrain,'water');
  const d=decideAgent(obs,mem,{energy:100,resting:false,cargo:{wood:CARGO_LIMIT,stone:0}},
    {width:w.width,height:w.height,cargoLimit:CARGO_LIMIT});
  assert.equal(d.action.kind,'idle');
});

test('low-capacity navigation remains deterministic and returns material on original failure seed', () => {
  const config={seed:12345,ticks:200,agentMode:'knowledge',perceptionRange:2,memoryCapacity:32};
  const a=runDiagnostics(config), b=runDiagnostics(config);
  assert.deepEqual(a,b);
  assert.ok(a.delivered.wood+a.delivered.stone>0);
  assert.ok(a.memory.peakPerAgent<=32);
});

test('constrained navigation works with physical resources and genuine action accounting', () => {
  const options={agentMode:'knowledge',resourceMode:'physical',perceptionRange:2,memoryCapacity:32};
  const a=createWorld(42,options), b=createWorld(42,options);
  const totals=w=>Object.fromEntries(['wood','stone'].map(m=>[m,w.physicalInventory.snapshot().samples
    .filter(s=>s.materialId===m).reduce((sum,s)=>sum+s.massKg,0)]));
  const energy=w=>w.physicalInventory.snapshot().samples.reduce((sum,s)=>sum+sensibleEnergyJ(s),0);
  const initial=totals(a), initialEnergy=energy(a);
  run(a,120); run(b,120);
  assert.equal(snapshot(a),snapshot(b));
  assert.deepEqual(totals(a),initial);
  assert.ok(Math.abs(energy(a)-initialEnergy)/initialEnergy<1e-12);
  assert.ok(a.history.query({kind:'stockpile.delivered'}).length>0);
  assert.equal(a.agents.reduce((s,x)=>s+x.skills.gathering.attempts,0),a.stats.woodHarvested+a.stats.stoneHarvested);
  assert.ok(a.agents.every(x=>x.memory.size<=32 && x.cargo.wood+x.cargo.stone<=CARGO_LIMIT));
});
