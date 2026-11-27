import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld, stepWorld, snapshot, executeAgentAction } from '../.sim-test/world.js';
import { advanceBiology, rankMotivations } from '../.sim-test/biology/index.js';
import { sensibleEnergyJ } from '../.sim-test/thermal/index.js';
const run=(w,n)=>{for(let i=0;i<n;i++)stepWorld(w);};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10, `${a} != ${b}`);
const place=(a,p)=>Object.assign(a,{x:p.x,y:p.y,energy:100,resting:false});
const idleWorld=(options={})=>{
  const w=createWorld(42,{agentMode:'knowledge',perceptionRange:0,biology:true,tickDurationSeconds:3600,...options});
  w.agents=w.agents.slice(0,1);
  return w;
};
test('biology is opt-in; shared modeled time resolves explicit thermal settings',()=>{
  const a=createWorld(42), b=createWorld(42,{biology:false});
  run(a,30);run(b,30);assert.equal(snapshot(a),snapshot(b));
  assert.equal(a.biology,undefined);assert.ok(a.agents.every(x=>x.biology===undefined));
  assert.equal(a.tickDurationSeconds,1);
  const cases=[
    [{thermal:true},1], [{thermal:{tickDurationSeconds:7}},7],
    [{thermal:true,tickDurationSeconds:12},12],
    [{thermal:{tickDurationSeconds:12},tickDurationSeconds:12},12]
  ];
  for(const [opts,time] of cases){
    const w=createWorld(42,{resourceMode:'physical',biology:true,...opts});
    assert.equal(w.tickDurationSeconds,time);assert.equal(w.thermal.config.tickDurationSeconds,time);
    assert.throws(()=>{w.tickDurationSeconds=99});
  }
  assert.throws(()=>createWorld(42,{resourceMode:'physical',biology:true,thermal:{tickDurationSeconds:2},tickDurationSeconds:3}));
  for(const tickDurationSeconds of [0,-1,Infinity,NaN])assert.throws(()=>createWorld(42,{biology:true,tickDurationSeconds}));
  assert.throws(()=>createWorld(42,{biology:{exertion:{move:2}}}));
});
test('idle advances one interval per tick; direct execution returns outcome without advancing time',()=>{
  const w=idleWorld(), a=w.agents[0], start=a.biology;
  const direct=executeAgentAction(w,a,{kind:'idle'});
  assert.equal(direct.kind,'idle');assert.equal(direct.status,'succeeded');assert.ok(Object.isFrozen(direct));
  assert.equal(a.biology,start);assert.equal(a.lastOutcome,undefined);
  stepWorld(w);assert.equal(a.lastOutcome.tick,1);assert.equal(a.lastOutcome.kind,'idle');
  assert.deepEqual(a.biology,advanceBiology(start,3600,{kind:'idle',status:'succeeded'}));
  stepWorld(w);close(a.biology.hunger,.08);close(a.biology.thirst,.16);close(a.biology.fatigue,.12);
});
test('executor reports actual movement, harvest, delivery, rejection and forced rest',()=>{
  const w=createWorld(42,{biology:true}), a=w.agents[0], d=w.deposits[0];
  place(a,w.hub);
  const rejected=executeAgentAction(w,a,{kind:'move',to:{x:a.x+2,y:a.y}});
  assert.equal(rejected.kind,'rejected');assert.equal(rejected.status,'failed');
  const moved=executeAgentAction(w,a,{kind:'move',to:{x:a.x+1,y:a.y}});
  assert.equal(moved.kind,'move');assert.equal(a.x,w.hub.x+1);
  assert.equal(executeAgentAction(w,a,{kind:'harvest',targetId:d.id}).kind,'rejected');
  place(a,d);
  assert.equal(executeAgentAction(w,a,{kind:'harvest',targetId:d.id}).kind,'harvest');
  assert.equal(a.cargo[d.material],1);
  assert.equal(executeAgentAction(w,a,{kind:'deliver',targetId:w.hub.id}).kind,'rejected');
  place(a,w.hub);
  assert.equal(executeAgentAction(w,a,{kind:'deliver',targetId:w.hub.id}).kind,'deliver');
  assert.equal(a.cargo[d.material],0);
  assert.equal(executeAgentAction(w,a,{kind:'rest'}).kind,'rejected');
  a.energy=69;a.resting=true;
  const rested=executeAgentAction(w,a,{kind:'move',to:{x:a.x+1,y:a.y}});
  assert.equal(rested.requested,'move');assert.equal(rested.kind,'rest');assert.equal(a.resting,false);
  assert.equal(a.x,w.hub.x);
  assert.equal(w.tick,0);assert.equal(a.biology.hunger,0);
});
test('committed harvest, movement and delivery use actual exertion; rejected harvest uses awake baseline',()=>{
  const w=createWorld(42,{agentMode:'knowledge',perceptionRange:1,biology:true,tickDurationSeconds:3600});
  const [a,b]=w.agents;w.agents=[b,a];w.terrain.fill('grass');w.hub.x=10;w.hub.y=10;
  const d={id:w.nextEntityId++,kind:'deposit',material:'wood',amount:1,x:11,y:10};
  w.deposits=[d];place(a,d);place(b,d);
  const start=a.biology;assert.notEqual(start,b.biology);
  stepWorld(w);
  assert.equal(a.lastOutcome.kind,'harvest');assert.equal(b.lastOutcome.kind,'rejected');
  assert.equal(b.lastOutcome.requested,'harvest');assert.equal(d.amount,0);
  close(a.biology.fatigue,.18);close(b.biology.fatigue,.06);
  assert.equal(a.skills.gathering.attempts,1);assert.equal(b.skills.gathering.attempts,0);
  stepWorld(w);assert.equal(a.lastOutcome.kind,'move');close(a.biology.fatigue,.30);
  stepWorld(w);assert.equal(a.lastOutcome.kind,'deliver');close(a.biology.fatigue,.39);
  assert.equal(a.cargo.wood,0);assert.equal(w.inventory.wood,1);
  close(a.biology.hunger,.12);close(a.biology.thirst,.24);
});
test('rest recovery is independent; hunger and thirst continue even on final rest tick',()=>{
  const w=idleWorld({biology:{initial:{hunger:.2,thirst:.3,fatigue:.8,condition:1}}});
  const a=w.agents[0];a.energy=69;a.resting=true;
  stepWorld(w);assert.equal(a.lastOutcome.kind,'rest');assert.equal(a.resting,false);
  close(a.biology.fatigue,.6);close(a.biology.hunger,.24);close(a.biology.thirst,.38);
  stepWorld(w);assert.equal(a.lastOutcome.kind,'idle');close(a.biology.fatigue,.66);
});
test('idle deprivation trace damages condition without death or fictitious consumption',()=>{
  const w=idleWorld(),a=w.agents[0],trace=[];
  for(let i=1;i<=48;i++){
    stepWorld(w);
    if([4,12,24,48].includes(i))trace.push({hour:i,...a.biology,motives:rankMotivations(a.biology).map(m=>m.kind)});
  }
  close(trace[1].hunger,.48);close(trace[1].thirst,.96);close(trace[1].fatigue,.72);close(trace[1].condition,.927925);
  assert.equal(a.biology.condition,0);assert.equal(w.agents.length,1);
  assert.equal(a.biology.hunger,1);assert.equal(a.biology.thirst,1);assert.equal(a.biology.fatigue,1);
  a.resting=true;a.energy=10;stepWorld(w);
  assert.equal(a.biology.hunger,1);assert.equal(a.biology.thirst,1);close(a.biology.fatigue,.8);assert.equal(a.biology.condition,0);
  console.log('GAIA_WORLD_BIOLOGY_TRACE '+JSON.stringify(trace));
});
test('failed physical transaction does not confer exertion or experience',()=>{
  const w=createWorld(42,{resourceMode:'physical',agentMode:'knowledge',perceptionRange:0,biology:true,tickDurationSeconds:3600});
  const a=w.agents[0],d=w.deposits[0];place(a,d);
  for(const other of w.agents.slice(1)){other.energy=0;other.resting=true;}
  const inv=w.physicalInventory,before=inv.snapshot(),transact=inv.transact;
  inv.transact=()=>{throw new RangeError('injected failure');};
  try{stepWorld(w);}finally{inv.transact=transact;}
  assert.equal(a.lastOutcome.kind,'rejected');assert.equal(a.lastOutcome.reason,'transaction-failed');
  close(a.biology.fatigue,.06);assert.equal(a.skills.gathering.attempts,0);
  assert.deepEqual(inv.snapshot(),before);assert.equal(w.history.query({kind:'resource.harvested'}).length,0);
});
for(const agentMode of ['legacy','knowledge'])for(const resourceMode of ['legacy','physical']){
  test(agentMode+'/'+resourceMode+' biology preserves policy outcomes and deterministic simulation',()=>{
    const opts={agentMode,resourceMode,thermal:resourceMode==='physical',tickDurationSeconds:60};
    const a=createWorld(42,{...opts,biology:true}),b=createWorld(42,{...opts,biology:true}),off=createWorld(42,opts);
    const mass=w=>w.physicalInventory?.snapshot().samples.reduce((n,s)=>n+s.massKg,0);
    const energy=w=>w.physicalInventory?.snapshot().samples.reduce((n,s)=>n+sensibleEnergyJ(s),0);
    const m=mass(a),e=energy(a);
    run(a,100);run(b,100);run(off,100);
    assert.equal(snapshot(a),snapshot(b));
    const withoutBiology=w=>{const s=JSON.parse(snapshot(w));delete s.biology;for(const a of s.agents)delete a.biology;return s;};
    assert.deepEqual(withoutBiology(a),withoutBiology(off));
    assert.ok(a.agents.every(x=>x.lastOutcome.tick===100));
    assert.ok(a.agents.every(x=>x.biology.hunger>0&&x.biology.thirst>0));
    assert.equal(new Set(a.agents.map(x=>x.biology)).size,a.agents.length);
    if(resourceMode==='physical'){assert.equal(mass(a),m);assert.ok(Math.abs(energy(a)-e)/e<1e-12);}
    const states=a.agents.map(x=>x.biology);
    console.log('GAIA_WORLD_BIOLOGY_RUN '+JSON.stringify({agentMode,resourceMode,ticks:a.tick,seconds:a.tick*a.tickDurationSeconds,
      hunger:states[0].hunger,thirst:states[0].thirst,fatigueMin:Math.min(...states.map(x=>x.fatigue)),
      fatigueMax:Math.max(...states.map(x=>x.fatigue)),conditionMin:Math.min(...states.map(x=>x.condition)),
      harvest:a.stats.woodHarvested+a.stats.stoneHarvested}));
  });
}
