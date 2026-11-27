import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics } from '../.sim-test/diagnostics/index.js';
import { createWorld, stepWorld } from '../.sim-test/world.js';

const scenarios = [
  ...[false,true].map(thermal => ({seed:7,ticks:1000,agentCount:3,thermal})),
  {seed:12345,ticks:200,agentCount:14,thermal:true},
  ...[42,12345,2026,19].map(seed => ({seed,ticks:1000,agentCount:3,thermal:false})),
].map(c => ({agentMode:'knowledge',perceptionRange:2,memoryCapacity:32,resourceMode:'physical',...c}));

const sum = v => v.wood + v.stone;
test('long duration navigation comparison reports unchanged diagnostic metrics', () => {
  for (const c of scenarios) {
    const r = runDiagnostics(c);
    assert.ok(r.memory.peakPerAgent <= c.memoryCapacity);
    assert.ok(Object.values(r.physical.failures).every(n => n === 0));
    console.log('GAIA_RECOVERY ' + JSON.stringify({
      seed:c.seed,ticks:c.ticks,agents:c.agentCount,thermal:c.thermal,
      delivered:sum(r.delivered),harvested:sum(r.harvested),remaining:sum(r.resources.remaining),
      lastHarvest:r.resources.lastHarvestTick,lastDelivery:r.resources.lastDeliveryTick,
      maxGap:r.resources.maxNoDeliveryRun,maxFull:r.fullCargo.maxRun,fullTicks:r.fullCargo.ticks,
      idle:r.outcomes.idle,maxIdle:Math.max(...r.agents.map(a=>a.movement.maxIdleRun)),
      moves:r.movement.distance,revisits:r.movement.revisits,backtracks:r.movement.backtracks,
      visited:r.coverage.visitedTiles,observed:r.coverage.observedTiles,built:r.firstConstructionTick,
      peak:r.memory.peakPerAgent,mean:r.memory.meanPerAgent
    }));
  }
});
const key = p => p.x + ':' + p.y;
const near = p => [{x:p.x+1,y:p.y},{x:p.x,y:p.y+1},{x:p.x-1,y:p.y},{x:p.x,y:p.y-1}];
function evidence(a) {
  const o = a.observation, m = a.memory.snapshot();
  const terrain = new Map(m.entries.filter(e=>e.value.kind==='terrain').map(e=>[key(e.value),e.value.terrain]));
  for (const t of o.terrain) terrain.set(key(t),t.terrain);
  const reachable = new Set([key(o.observer)]), queue=[o.observer];
  for(let i=0;i<queue.length;i++) for(const p of near(queue[i])) {
    const k=key(p); if(reachable.has(k)||!terrain.has(k)||terrain.get(k)==='water')continue;
    reachable.add(k);queue.push(p);
  }
  const hub = o.hub ?? m.entries.find(e=>e.value.kind==='hub'&&e.status!=='absent')?.value;
  const deposits = m.entries.filter(e=>e.value.kind==='deposit'&&e.status!=='absent'&&e.value.amount>0);
  return {hub:hub?key(hub):null,homeReachable:!!hub&&reachable.has(key(hub)),
    reachable:reachable.size,seen:o.deposits.length,remembered:deposits.length,
    reachableDeposits:deposits.filter(e=>reachable.has(key(e.value))).length,
    retainedTerrain:m.entries.filter(e=>e.value.kind==='terrain').length};
}
test('inspect individual knowledge and repeated exploration after productive stall',()=>{
  const c=scenarios[0], w=createWorld(c.seed,{...c,eventCapacity:1});
  w.agents=w.agents.slice(0,c.agentCount);
  const track=w.agents.map(a=>({id:a.id,visits:new Set(),explore:0,repeatExplore:0,newSight:0,seen:new Set(),
    homeDisconnected:0,localDeposit:0,knownUnreachable:0,trace:[]}));
  for(let t=1;t<=c.ticks;t++){
    stepWorld(w);
    w.agents.forEach((a,i)=>{
      const z=track[i], e=evidence(a), pos=key(a);
      const novel=a.observation.terrain.filter(p=>!z.seen.has(key(p))).length;
      for(const p of a.observation.terrain)z.seen.add(key(p));
      if(t>435){
        z.newSight+=novel;
        if(a.lastOutcome.kind==='move'&&a.decision.intention.startsWith('Explore')){
          z.explore++;z.repeatExplore+=Number(z.visits.has(pos));
        }
        z.homeDisconnected+=Number(!!e.hub&&!e.homeReachable);
        z.localDeposit+=Number(e.seen>0);
        z.knownUnreachable+=Number(e.remembered>0&&e.reachableDeposits===0);
        if(t>=960&&a.lastOutcome.kind==='move')z.trace.push({t,pos,intent:a.decision.intention,...e});
      }
      z.visits.add(pos);
    });
  }
  for(const {visits,seen,trace,...z} of track)console.log('GAIA_RECOVERY_TRACE '+JSON.stringify({...z,visited:visits.size,observed:seen.size,trace:trace.slice(-16)}));
});
