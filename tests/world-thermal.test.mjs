import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createWorld, stepWorld, snapshot, executeAgentAction } from '../.sim-test/world.js';
import { thermalContacts, processThermalContacts } from '../.sim-test/environment/index.js';
import { resourceOwnerId } from '../.sim-test/resource-actions/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';

const opts = { resourceMode:'physical', initialTemperatureC:{wood:90,stone:10} };
const run = (w,n) => {for(let i=0;i<n;i++)stepWorld(w);};
const energy = w => w.physicalInventory.snapshot().samples.reduce((a,s)=>a+sensibleEnergyJ(s),0);
const mass = w => w.physicalInventory.snapshot().samples.reduce((a,s)=>a+s.massKg,0);
const owner = w => resourceOwnerId('hub',w.hub.id);
const samples = w => w.physicalInventory.forOwner(owner(w));
const close = (a,b) => assert.ok(Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(a),Math.abs(b)), `${a} != ${b}`);
function fill(w, materials) {
  const a=w.agents[0];
  for (const material of materials) {
    const d=w.deposits.find(x=>x.material===material && x.amount>0);
    Object.assign(a,{x:d.x,y:d.y,energy:100,resting:false});
    executeAgentAction(w,a,{kind:'harvest',targetId:d.id});
    Object.assign(a,{x:w.hub.x,y:w.hub.y,energy:100,resting:false});
    executeAgentAction(w,a,{kind:'deliver',targetId:w.hub.id});
  }
  w.agents=[];
}
test('thermal is opt-in, requires physical mode, and validates configuration',()=>{
  const a=createWorld(42,opts), b=createWorld(42,{...opts,thermal:false});
  run(a,10);run(b,10);assert.equal(snapshot(a),snapshot(b));assert.equal(a.thermal,undefined);
  assert.throws(()=>createWorld(42,{thermal:true}));
  for(const thermal of [{tickDurationSeconds:0},{conductanceWPerK:-1},{maxContactsPerTick:0},
    {maxContactsPerTick:257},{eventThresholdJ:NaN}]) assert.throws(()=>createWorld(42,{...opts,thermal}));
});
test('two samples equilibrate over real World ticks with conserved identity, mass and energy',()=>{
  const w=createWorld(42,{...opts,thermal:true});
  fill(w,['wood','stone']);
  const initial=samples(w), e=energy(w), m=mass(w);
  const strip=s=>s.map(({temperatureC,...rest})=>rest);
  let gap=Math.abs(initial[0].temperatureC-initial[1].temperatureC);
  const trace=[];
  for(let i=0;i<30;i++){
    stepWorld(w);
    const s=samples(w), next=Math.abs(s[0].temperatureC-s[1].temperatureC);
    assert.ok(next<=gap);gap=next;
    if([0,4,9,29].includes(i)) trace.push({tick:w.tick,temperatures:s.map(x=>x.temperatureC)});
  }
  assert.ok(gap<5);assert.deepEqual(strip(samples(w)),strip(initial));close(e,energy(w));assert.equal(mass(w),m);
  assert.ok(w.history.query({kind:'thermal.contact'}).length>0);
  const first=w.history.query({kind:'thermal.contact'})[0];
  assert.equal(first.tick,1);assert.ok(Math.abs(first.details.contacts[0].transferredEnergyJ)>0);
  console.log('GAIA_THERMAL_TRACE '+JSON.stringify({initial:initial.map(s=>s.temperatureC),trace,energyErrorJ:energy(w)-e}));
});
test('eligibility excludes distinct owners and invalid positions; sparse ring has no duplicate edges',()=>{
  const w=createWorld(42,{...opts,thermal:true});
  assert.equal(thermalContacts(w).length,0);
  fill(w,['wood','stone','wood','stone','wood']);
  const edges=thermalContacts(w);
  assert.equal(edges.length,5);
  assert.equal(new Set(edges.map(x=>[x.a,x.b].sort((a,b)=>a-b).join(':'))).size,5);
  assert.ok(edges.every(x=>x.ownerId===owner(w)));
  w.hub.x=-1;assert.equal(thermalContacts(w).length,0);
});
test('budget one rotates through all static ring edges, including equal pairs',()=>{
  const w=createWorld(42,{...opts,thermal:{maxContactsPerTick:1,eventThresholdJ:0}});
  fill(w,['wood','stone','wood','wood','stone']);
  const expected=thermalContacts(w).map(x=>x.a), actual=[];
  const e=energy(w);
  for(let i=0;i<expected.length*2;i++){
    w.tick++;const r=processThermalContacts(w);
    assert.equal(r.considered,1);actual.push(w.thermal.cursor);
  }
  assert.deepEqual(actual,[...expected,...expected]);close(energy(w),e);
});
test('failed heat transaction publishes no success and advances scheduling',()=>{
  const w=createWorld(42,{...opts,thermal:{maxContactsPerTick:1}});
  fill(w,['wood','stone','wood']);
  const inv=w.physicalInventory, before=inv.snapshot(), count=w.history.size;
  const transact=inv.transact;
  inv.transact=()=>{throw new RangeError('injected rejection');};
  w.tick++;assert.equal(processThermalContacts(w).rejected,1);
  assert.deepEqual(inv.snapshot(),before);assert.equal(w.history.size,count);
  const cursor=w.thermal.cursor;inv.transact=transact;
  w.tick++;processThermalContacts(w);assert.notEqual(w.thermal.cursor,cursor);
});
test('zero conductance and event threshold do not generate spurious events',()=>{
  for(const thermal of [{conductanceWPerK:0},{eventThresholdJ:1e20}]){
    const w=createWorld(42,{...opts,thermal});fill(w,['wood','stone']);
    const before=samples(w).map(s=>s.temperatureC);
    run(w,5);
    assert.equal(w.history.query({kind:'thermal.contact'}).length,0);
    if(thermal.conductanceWPerK===0)assert.deepEqual(samples(w).map(s=>s.temperatureC),before);
    else assert.notDeepEqual(samples(w).map(s=>s.temperatureC),before);
  }
});
for(const agentMode of ['legacy','knowledge']){
  test(agentMode+' thermal world deterministic, conserves energy and heats built structure',()=>{
    const options={...opts,agentMode,thermal:true};
    const a=createWorld(12345,options), b=createWorld(12345,options);
    const e=energy(a), m=mass(a);
    run(a,200);run(b,200);
    assert.equal(snapshot(a),snapshot(b));close(energy(a),e);assert.equal(mass(a),m);
    assert.ok(a.structures.length);
    const holdings=a.physicalInventory.forOwner(resourceOwnerId('structure',a.structures[0].id));
    assert.ok(holdings.some(s=>s.temperatureC!==opts.initialTemperatureC[s.materialId]));
    assert.ok(a.history.query({kind:'thermal.contact'}).length<=a.tick);
    assert.equal(a.history.query({kind:'hearth.fuel_consumed'}).length,0);
  });
}
test('diagnostic paired timing, not a performance assertion',()=>{
  const results=[];
  for(const agentMode of ['legacy','knowledge']){
    const times={off:[],on:[]};
    for(let r=0;r<4;r++)for(const enabled of (r%2?[true,false]:[false,true])){
      const w=createWorld(42,{...opts,agentMode,thermal:enabled});
      const e=energy(w), t=performance.now();run(w,100);const elapsed=performance.now()-t;
      close(energy(w),e);
      if(r>0)times[enabled?'on':'off'].push(elapsed);
    }
    const median=a=>a.sort((a,b)=>a-b)[1];
    results.push({agentMode,offMs:median(times.off),onMs:median(times.on)});
  }
  console.log('GAIA_THERMAL_BENCH '+JSON.stringify(results));
});
