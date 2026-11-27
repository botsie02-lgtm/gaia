import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemory, searchBucket } from '../.sim-test/memory/index.js';
import { observeAgent } from '../.sim-test/perception/index.js';
import { decideAgent } from '../.sim-test/agents/index.js';
import { createWorld, stepWorld, executeAgentAction, CARGO_LIMIT } from '../.sim-test/world.js';

const position = (x,y) => ({x,y});
function fixture() {
  const world = createWorld(42,{agentMode:'knowledge',perceptionRange:2,memoryCapacity:32});
  const a=world.agents[0];world.agents=[a];world.deposits=[];world.terrain.fill('grass');
  Object.assign(world.hub,{x:50,y:32});
  Object.assign(a,{x:5,y:5,energy:100,resting:false});
  return {world,a};
}
function sample(w,a) {
  w.tick++;
  return a.memory.update(observeAgent(w,a.id,{range:2}));
}
test('regional pressure records local motion, survives forgetting, and remains bounded and restorable',()=>{
  const {world:w,a}=fixture();
  const first=sample(w,a);
  const bucket=searchBucket(a,32);
  assert.equal(first.searchPressure.length,32);
  assert.ok(first.searchPressure[bucket]>0);
  assert.equal(first.entries.filter(e=>e.searchOrigin).length,1);
  assert.deepEqual(sample(w,a).searchPressure,first.searchPressure);
  for(let x=6;x<=32;x++){a.x=x;sample(w,a);}
  const m=a.memory.snapshot();
  assert.ok(m.entries.length<=32);
  assert.equal(m.entries.filter(e=>e.searchOrigin).length,1);
  assert.deepEqual(m.entries.find(e=>e.searchOrigin).value,{kind:'terrain',x:5,y:5,terrain:'grass'});
  assert.equal(a.memory.query({kind:'terrain',x:6,y:4}).length,0);
  assert.ok(m.searchPressure[bucket]>0);
  assert.ok(Object.isFrozen(m.searchPressure));
  const restored=AgentMemory.fromSnapshot(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(restored.snapshot(),m);
  w.tick++;a.x=33;
  const o=observeAgent(w,a.id,{range:2});
  assert.deepEqual(restored.update(o),a.memory.update(o));
  assert.throws(()=>AgentMemory.fromSnapshot({...m,searchPressure:[0]}));
  assert.throws(()=>AgentMemory.fromSnapshot({...m,searchPressure:m.searchPressure.map(()=>256)}));
  assert.throws(()=>AgentMemory.fromSnapshot({...m,entries:m.entries.map(e=>e.value.kind==='terrain'?{...e,searchOrigin:true}:e)}));
});
test('approximate regional pressure steers a frontier choice without granting hidden traversability',()=>{
  const {world:w,a}=fixture();
  w.terrain.fill('water');
  for(let x=0;x<w.width;x++)w.terrain[5*w.width+x]='grass';
  Object.assign(a,{x:7,y:5});
  w.tick++;
  const o=observeAgent(w,a.id,{range:2});
  const m=a.memory.update(o);
  const west=searchBucket(position(5,5),32),east=searchBucket(position(9,5),32);
  assert.notEqual(west,east);
  const p={width:w.width,height:w.height,cargoLimit:3},own={energy:100,resting:false,cargo:{wood:0,stone:0}};
  const decide=(low)=>{
    const searchPressure=Array(32).fill(200);searchPressure[low]=0;
    return decideAgent(o,{...m,searchPressure},own,p);
  };
  assert.deepEqual(decide(west).action,{kind:'move',to:{x:6,y:5}});
  assert.deepEqual(decide(east).action,{kind:'move',to:{x:8,y:5}});
});
test('a disconnected known home corridor can be reacquired with the same capacity',()=>{
  const {world:w,a}=fixture();
  w.terrain.fill('water');
  for(let x=4;x<=46;x++)w.terrain[5*w.width+x]='grass';
  Object.assign(w.hub,{x:4,y:5});
  for(let x=4;x<=42;x++){a.x=x;a.y=5;sample(w,a);}
  assert.equal(a.memory.query({kind:'hub'})[0].value.x,4);
  assert.equal(a.memory.query({kind:'terrain',x:20,y:5}).length,0);
  const d={id:w.nextEntityId++,kind:'deposit',material:'wood',x:42,y:5,amount:CARGO_LIMIT};
  w.deposits.push(d);
  for(let i=0;i<CARGO_LIMIT;i++)executeAgentAction(w,a,{kind:'harvest',targetId:d.id});
  for(let i=0;i<150&&w.inventory.wood<CARGO_LIMIT;i++)stepWorld(w);
  assert.equal(w.inventory.wood,CARGO_LIMIT);
  assert.equal(a.cargo.wood,0);
  assert.ok(a.memory.size<=32);
});
