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
