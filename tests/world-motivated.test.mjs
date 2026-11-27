import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld,stepWorld,snapshot,executeAgentAction} from '../.sim-test/world.js';
import {createBiologicalState,advanceBiology} from '../.sim-test/biology/index.js';
import {restoreGoalState,decideMotivatedAgent} from '../.sim-test/agents/motivations/index.js';
import {observeAgent} from '../.sim-test/perception/index.js';
import {sensibleEnergyJ} from '../.sim-test/thermal/index.js';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10, a+' != '+b);
const run=(w,n)=>{for(let i=0;i<n;i++)stepWorld(w);};
const place=(a,p)=>Object.assign(a,{x:p.x,y:p.y,energy:100,resting:false});
const needs=(a,hunger=0,thirst=0,fatigue=0)=>{a.biology=createBiologicalState({hunger,thirst,fatigue,condition:1});};
function fixture(options={}){
  const w=createWorld(42,{agentMode:'motivated',biology:true,tickDurationSeconds:3600,perceptionRange:2,...options});
  w.terrain.fill('grass');w.agents=w.agents.slice(0,1);w.deposits=[];
  const a=w.agents[0];place(a,{x:10,y:10});w.hub.x=11;w.hub.y=10;
  const d={id:w.nextEntityId++,kind:'deposit',material:'wood',x:10,y:10,amount:3};
  w.deposits=[d];return {w,a,d};
}
test('motivated mode validates explicit biology and configuration; existing policies remain unchanged',()=>{
  assert.throws(()=>createWorld(42,{agentMode:'motivated'}));
  assert.throws(()=>createWorld(42,{agentMode:'motivated',biology:false}));
  assert.throws(()=>createWorld(42,{agentMode:'motivated',biology:true,motivations:{maxCommitmentTicks:0}}));
  assert.throws(()=>createWorld(42,{agentMode:'knowledge',motivations:{}}));
  const w=createWorld(42,{agentMode:'motivated',biology:true,memoryCapacity:32,motivations:{maxCommitmentTicks:4}});
  assert.equal(w.motivationConfig.maxCommitmentTicks,4);
  assert.ok(Object.isFrozen(w.motivationConfig));
  assert.equal(new Set(w.agents.map(a=>a.goalState)).size,w.agents.length);
  for(const a of w.agents){
    assert.equal(a.goalState.observerId,a.id);assert.equal(a.goalState.lastTick,0);
    assert.equal(a.goalState.goal,null);assert.ok(Object.isFrozen(a.goalState));
  }
  for(const agentMode of ['legacy','knowledge']){
    const old=createWorld(42,{agentMode,biology:true});stepWorld(old);
    assert.equal(old.motivationConfig,undefined);assert.ok(old.agents.every(a=>a.goalState===undefined&&a.motivation===undefined));
  }
});
test('voluntary rest is genuinely resolved and advances fatigue once without relieving hunger/thirst',()=>{
  const {w,a,d}=fixture();needs(a,.2,.3,.95);
  const old=a.biology;
  stepWorld(w);
  assert.equal(a.motivation.desiredGoal,'rest');assert.equal(a.motivation.selectedGoal,'rest');
  assert.equal(a.decision.action.kind,'rest');assert.equal(a.lastOutcome.kind,'rest');
  assert.equal(a.lastOutcome.reason,'voluntary-rest');assert.equal(a.resting,false);assert.equal(a.energy,100);
  assert.equal(d.amount,3);assert.equal(a.x,10);assert.equal(a.goalState.lastTick,1);
  assert.deepEqual(a.biology,advanceBiology(old,3600,{kind:'rest',status:'succeeded'}));
  close(a.biology.fatigue,.75);close(a.biology.hunger,.24);close(a.biology.thirst,.38);
  const prior=a.biology;const receipt=executeAgentAction(w,a,{kind:'rest'});
  assert.equal(receipt.reason,'voluntary-rest');assert.equal(a.biology,prior);assert.equal(a.lastOutcome.tick,1);
});
test('mandatory rest takes precedence and ends at the original abstract energy threshold',()=>{
  const {w,a}=fixture();needs(a,0,1,.7);a.energy=10;
  stepWorld(w);
  assert.equal(a.motivation.desiredGoal,'obtain-water');assert.equal(a.motivation.selectedGoal,'rest');
  assert.equal(a.motivation.reason,'legacy-rest');assert.equal(a.lastOutcome.reason,'mandatory-rest');
  assert.equal(a.energy,15);assert.equal(a.resting,true);
  run(w,11);assert.equal(a.energy,70);assert.equal(a.resting,false);
  assert.equal(a.lastOutcome.reason,'mandatory-rest');assert.equal(a.biology.thirst,1);
});
test('unknown food and water search uses only reachable observed terrain and never grants consumption',()=>{
  for(const [h,t,goal] of [[1,0,'obtain-food'],[0,1,'obtain-water']]){
    const {w,a,d}=fixture();needs(a,h,t,0);
    stepWorld(w);
    assert.equal(a.motivation.desiredGoal,goal);assert.equal(a.motivation.selectedGoal,goal);
    const e=a.motivation.evaluations.find(e=>e.goal===goal);
    assert.equal(e.opportunity,'unknown');assert.equal(e.feasibility,'search-only');assert.equal(e.targetId,null);
    assert.match(a.decision.intention,/availability unknown/);
    assert.equal(a.lastOutcome.kind,'move');
    assert.ok(a.observation.terrain.some(t=>t.x===a.x&&t.y===a.y&&t.terrain!=='water'));
    assert.equal(d.amount,3);assert.ok(a.biology.hunger>=h&&a.biology.thirst>=t);
  }
  const {w,a}=fixture({perceptionRange:0});needs(a,0,1,0);
  stepWorld(w);assert.equal(a.motivation.desiredGoal,'obtain-water');
  assert.equal(a.motivation.evaluations[0].feasibility,'blocked');assert.equal(a.motivation.selectedGoal,'gather');
  assert.equal(a.lastOutcome.kind,'harvest');
});
test('commitment and decisions match pure local engine; hidden resources cannot affect immediate arbitration',()=>{
  const x=fixture(),y=fixture();needs(x.a,0,.95,0);needs(y.a,0,.95,0);
  y.w.inventory.wood=999;
  y.w.deposits.push({id:y.w.nextEntityId++,kind:'deposit',material:'stone',x:40,y:20,amount:999});
  for(const f of [x,y]){
    const {w,a}=f;const before=a.goalState;const prior=a.biology;
    const own={energy:a.energy,resting:a.resting,cargo:{...a.cargo}};
    stepWorld(w);
    const expected=decideMotivatedAgent({observation:a.observation,memory:a.memory.snapshot(),own,
      biology:prior,policy:{width:w.width,height:w.height,cargoLimit:3},biologyConfig:w.biology.config,previous:before},w.motivationConfig);
    assert.deepEqual(a.decision,expected.decision);assert.deepEqual(a.goalState,expected.nextState);
    assert.deepEqual(a.motivation.evaluations,expected.evaluations);
    assert.deepEqual(restoreGoalState(JSON.parse(JSON.stringify(a.goalState))),a.goalState);
  }
  assert.deepEqual(x.a.observation,y.a.observation);assert.deepEqual(x.a.decision,y.a.decision);
  assert.deepEqual(x.a.motivation,y.a.motivation);
});
test('contested harvest uses resolved failure, independent physiology and bounded commitments',()=>{
  const {w,a,d}=fixture({perceptionRange:0});
  const original=createWorld(42,{agentMode:'motivated',biology:true});
  const b=original.agents[1];place(b,d);d.amount=1;w.agents=[b,a];
  stepWorld(w);
  assert.equal(a.decision.action.kind,'harvest');assert.equal(b.decision.action.kind,'harvest');
  assert.equal(a.lastOutcome.kind,'harvest');assert.equal(b.lastOutcome.kind,'rejected');
  assert.equal(b.lastOutcome.status,'failed');assert.equal(a.skills.gathering.attempts,1);assert.equal(b.skills.gathering.attempts,0);
  close(a.biology.fatigue,.18);close(b.biology.fatigue,.06);
  assert.notEqual(a.goalState,b.goalState);
  run(w,10);
  for(const agent of w.agents){assert.equal(agent.goalState.observerId,agent.id);
    assert.equal(agent.goalState.lastTick,w.tick);assert.ok(w.tick-agent.goalState.sinceTick<w.motivationConfig.maxCommitmentTicks);
    assert.equal(agent.motivation.evaluations.length,5);assert.equal(agent.lastOutcome.tick,w.tick);}
});
test('physical failed transaction is rejected without exertion or material changes',()=>{
  const w=createWorld(42,{agentMode:'motivated',biology:true,resourceMode:'physical',perceptionRange:0,tickDurationSeconds:3600});
  const a=w.agents[0];place(a,w.deposits[0]);for(const b of w.agents.slice(1)){b.energy=0;b.resting=true;}
  const inv=w.physicalInventory,before=inv.snapshot(),transact=inv.transact;
  inv.transact=()=>{throw new RangeError('injected');};
  try{stepWorld(w);}finally{inv.transact=transact;}
  assert.equal(a.motivation.selectedGoal,'gather');assert.equal(a.lastOutcome.kind,'rejected');
  close(a.biology.fatigue,.06);assert.deepEqual(inv.snapshot(),before);assert.equal(a.skills.gathering.attempts,0);
});
const totals=w=>{
  const s=w.physicalInventory.snapshot().samples;
  return {wood:s.filter(x=>x.materialId==='wood').reduce((n,x)=>n+x.massKg,0),
    stone:s.filter(x=>x.materialId==='stone').reduce((n,x)=>n+x.massKg,0),
    energy:s.reduce((n,x)=>n+sensibleEnergyJ(x),0)};
};
test('motivated thermal world reproduces full snapshots, preserves matter and modeled sensible energy',()=>{
  const opts={agentMode:'motivated',biology:true,resourceMode:'physical',thermal:true,tickDurationSeconds:60};
  const a=createWorld(42,opts),b=createWorld(42,opts),initial=totals(a);
  for(let i=0;i<120;i++){stepWorld(a);const t=totals(a);
    assert.equal(t.wood,initial.wood);assert.equal(t.stone,initial.stone);
    assert.ok(Math.abs(t.energy-initial.energy)/initial.energy<1e-12);}
  run(b,120);assert.equal(snapshot(a),snapshot(b));
  assert.equal(a.thermal.config.tickDurationSeconds,60);
  assert.ok(a.history.query({kind:'resource.harvested'}).length);
  assert.ok(a.history.query({kind:'thermal.contact'}).length);
  assert.ok(a.agents.every(x=>x.memory.snapshot().lastObservationTick===120&&x.lastOutcome.tick===120));
});
test('representative physical deprivation scenarios compare committed actions and goals',()=>{
  for(const [seed,tickDurationSeconds] of [[42,1],[42,300],[12345,300]])for(const agentMode of ['knowledge','motivated']){
    const w=createWorld(seed,{agentMode,biology:true,resourceMode:'physical',thermal:true,tickDurationSeconds,eventCapacity:4096});
    const initial=totals(w),actions={},goals={};let voluntary=0,mandatory=0,switches=0;
    for(let i=0;i<200;i++){
      const previous=w.agents.map(a=>a.goalState?.goal);
      stepWorld(w);
      for(const [j,a] of w.agents.entries()){
        const o=a.lastOutcome;actions[o.kind]=(actions[o.kind]??0)+1;
        if(o.reason==='voluntary-rest')voluntary++;
        if(o.kind==='rest'&&o.reason!=='voluntary-rest')mandatory++;
        if(a.motivation){const g=a.motivation.selectedGoal??'none';goals[g]=(goals[g]??0)+1;
          if(i>0&&previous[j]!==a.goalState.goal)switches++;}
      }
    }
    assert.equal(Object.values(actions).reduce((n,x)=>n+x,0),2800);
    assert.equal(w.agents.length,14);assert.ok(w.agents.every(a=>a.biology.thirst>0&&a.biology.hunger>0));
    const t=totals(w);assert.equal(t.wood,initial.wood);assert.equal(t.stone,initial.stone);
    assert.ok(Math.abs(t.energy-initial.energy)/initial.energy<1e-12);
    const mean=k=>w.agents.reduce((n,a)=>n+a.biology[k],0)/w.agents.length;
    console.log('GAIA_MOTIVATED_WORLD '+JSON.stringify({seed,agentMode,ticks:200,tickDurationSeconds,
      actions,goals,voluntary,mandatory,switches,harvest:w.stats.woodHarvested+w.stats.stoneHarvested,
      delivered:w.history.query({kind:'stockpile.delivered'}).reduce((n,e)=>n+e.details.wood+e.details.stone,0),
      hearths:w.structures.length,hunger:mean('hunger'),thirst:mean('thirst'),fatigue:mean('fatigue'),condition:mean('condition'),
      massErrorKg:t.wood+t.stone-initial.wood-initial.stone,energyErrorJ:t.energy-initial.energy}));
  }
});
