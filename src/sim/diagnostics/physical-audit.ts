/** Independent tick-boundary checks. No writes to World or inventory. */
import type { World, Inventory } from '../model.js';
import type { PersistentSample } from '../inventory/index.js';
import { getMaterial } from '../materials/index.js';

const materials = ['wood', 'stone'] as const;
const zeros = (): Inventory => ({ wood: 0, stone: 0 });
/** Global numerical audit threshold, not the production pair solver's tolerance. */
export const ENERGY_RELATIVE_TOLERANCE = 1e-12;
type Issue = 'mass' | 'energy' | 'owner' | 'projection' | 'index' | 'identity' | 'sample' | 'temperature';
const issues = (): Record<Issue, number> => ({ mass: 0, energy: 0, owner: 0, projection: 0, index: 0, identity: 0, sample: 0, temperature: 0 });
function same(a: PersistentSample, b: PersistentSample | undefined) {
  return !!b && a.sampleId === b.sampleId && a.ownerId === b.ownerId &&
    a.materialId === b.materialId && a.phase === b.phase && a.massKg === b.massKg && a.temperatureC === b.temperatureC;
}
function energySum(samples: readonly PersistentSample[]) {
  // Compensated accumulation; independently reconstruct the documented constant-cp energy.
  let sum = 0, correction = 0;
  for (const s of samples) {
    const value = s.massKg * getMaterial(s.materialId).specificHeatJPerKgK * (s.temperatureC + 273.15);
    const y = value - correction, next = sum + y;
    correction = (next - sum) - y; sum = next;
  }
  return sum;
}
export function createPhysicalAudit(initial: World) {
  if (!initial.physicalInventory || !initial.physicalConfig || initial.tick !== 0) throw new RangeError('Expected fresh physical World');
  const inventory = initial.physicalInventory;
  const config = initial.physicalConfig;
  const calibration = zeros();
  for (const c of config.calibration) {
    if (c.materialId === 'wood' || c.materialId === 'stone') calibration[c.materialId] = c.kgPerUnit;
  }
  const baseline = inventory.snapshot();
  const initialMassKg = zeros();
  for (const s of baseline.samples) {
    if (s.materialId !== 'wood' && s.materialId !== 'stone') throw new Error('Unexpected baseline material');
    initialMassKg[s.materialId] += s.massKg;
  }
  const initialEnergyJ = energySum(baseline.samples);
  const energyToleranceJ = Math.abs(initialEnergyJ) * ENERGY_RELATIVE_TOLERANCE;
  const minInitialTemperatureC = Math.min(...baseline.samples.map(s => s.temperatureC));
  const maxInitialTemperatureC = Math.max(...baseline.samples.map(s => s.temperatureC));
  const failures = issues();
  const firstFailureTick: Partial<Record<Issue, number>> = {};
  let previous = new Map<number, PersistentSample>();
  let previousCursor = 1, previousRevision = 0, checkedTicks = 0, lastTick = -1;
  let finalMassKg = zeros(), finalEnergyJ = initialEnergyJ, maxAbsEnergyErrorJ = 0, maxAbsStepEnergyErrorJ = 0;
  let finalCount = 0, peakCount = 0, peakOwnerSamples = 0, finalHubSamples = 0;
  let temperatureChangedExistingSamples = 0, ownerChanges = 0, newSamples = 0, finalRevision = 0;
  let finalCursor = 1, maxTemperatureShiftC = 0;
  const maxAbsMassErrorKg = zeros();
  function sample(world: World) {
    if (world.physicalInventory !== inventory || world.physicalConfig !== config || world.tick !== lastTick + 1) {
      throw new Error('Audit requires consecutive ticks of the same physical World');
    }
    const tick = world.tick;
    const bad = (issue: Issue) => { failures[issue]++; firstFailureTick[issue] ??= tick; };
    const snap = inventory.snapshot();
    const current = new Map<number, PersistentSample>();
    const ownerMass = new Map<string, Inventory>();
    const ownerSamples = new Map<string, PersistentSample[]>();
    const expected = new Map<string, Inventory>();
    const ids = new Set<number>();
    const register = (kind: string, id: number, balance: Inventory) => {
      if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) bad('owner');
      ids.add(id); expected.set(kind + ':' + id, balance);
    };
    register('hub', world.hub.id, world.inventory);
    for (const a of world.agents) register('agent', a.id, a.cargo);
    for (const d of world.deposits) register('deposit', d.id, { ...zeros(), [d.material]: d.amount });
    for (const h of world.structures) register('structure', h.id, { wood: h.fuel, stone: h.stoneUsed });
    const mass = zeros();
    let lastId = 0;
    for (const s of snap.samples) {
      const id = s.sampleId;
      if (!Number.isSafeInteger(id) || id <= lastId || id >= snap.nextSampleId || current.has(id)) bad('identity');
      lastId = id;
      current.set(id, s);
      if (!expected.has(s.ownerId)) bad('owner');
      if (!same(s, inventory.get(id))) bad('index');
      if (s.materialId !== 'wood' && s.materialId !== 'stone') { bad('sample'); continue; }
      const m = s.materialId;
      if (s.phase !== 'solid' || !Number.isFinite(s.massKg) || s.massKg <= 0 ||
        !Number.isSafeInteger(s.massKg * 1024) || !Number.isFinite(s.temperatureC) || s.temperatureC < -273.15) bad('sample');
      if (world.thermal) {
        if (s.temperatureC < minInitialTemperatureC || s.temperatureC > maxInitialTemperatureC) bad('temperature');
      } else if (s.temperatureC !== config.initialTemperatureC[m]) bad('temperature');
      maxTemperatureShiftC = Math.max(maxTemperatureShiftC, Math.abs(s.temperatureC - config.initialTemperatureC[m]));
      const old = previous.get(id);
      if (old) {
        if (old.materialId !== m || old.phase !== s.phase || s.massKg > old.massKg) bad('identity');
        if (old.ownerId !== s.ownerId) ownerChanges++;
        if (old.temperatureC !== s.temperatureC) temperatureChangedExistingSamples++;
      } else if (tick > 0) {
        newSamples++;
        if (id < previousCursor) bad('identity');
      }
      const totals = ownerMass.get(s.ownerId) ?? zeros();
      totals[m] += s.massKg; ownerMass.set(s.ownerId, totals);
      const group = ownerSamples.get(s.ownerId) ?? [];
      group.push(s); ownerSamples.set(s.ownerId, group);
      mass[m] += s.massKg;
    }
    // Split-only world: no retired IDs, no cursor gaps, no reuse; old IDs must persist.
    if (snap.nextSampleId !== snap.samples.length + 1 || snap.nextSampleId < previousCursor ||
      snap.revision < previousRevision) bad('identity');
    for (const id of previous.keys()) if (!current.has(id)) bad('identity');
    for (const [owner, balance] of expected) {
      const totals = ownerMass.get(owner) ?? zeros();
      const group = ownerSamples.get(owner) ?? [];
      const indexed = inventory.forOwner(owner);
      if (indexed.length !== group.length || indexed.some((s,i) => !same(s, group[i]))) bad('index');
      peakOwnerSamples = Math.max(peakOwnerSamples, group.length);
      for (const m of materials) {
        if (!Number.isSafeInteger(balance[m]) || balance[m] < 0 || balance[m] * calibration[m] !== totals[m]) bad('projection');
      }
    }
    for (const m of materials) {
      const error = Math.abs(mass[m] - initialMassKg[m]);
      maxAbsMassErrorKg[m] = Math.max(maxAbsMassErrorKg[m], error);
      if (error !== 0) bad('mass');
    }
    const e = energySum(snap.samples);
    const absError = Math.abs(e - initialEnergyJ);
    maxAbsEnergyErrorJ = Math.max(maxAbsEnergyErrorJ, absError);
    maxAbsStepEnergyErrorJ = Math.max(maxAbsStepEnergyErrorJ, Math.abs(e - finalEnergyJ));
    if (!Number.isFinite(e) || absError > energyToleranceJ) bad('energy');
    finalMassKg = mass; finalEnergyJ = e;
    finalCount = snap.samples.length; peakCount = Math.max(peakCount, finalCount);
    finalHubSamples = ownerSamples.get('hub:' + world.hub.id)?.length ?? 0;
    finalCursor = snap.nextSampleId; finalRevision = snap.revision;
    previous = current; previousCursor = finalCursor; previousRevision = finalRevision;
    checkedTicks++; lastTick = tick;
  }
  sample(initial);
  return {
    sample,
    report() {
      return { checkedTicks, initialMassKg: { ...initialMassKg }, finalMassKg: { ...finalMassKg },
        initialTotalMassKg: initialMassKg.wood + initialMassKg.stone, finalTotalMassKg: finalMassKg.wood + finalMassKg.stone,
        maxAbsMassErrorKg: { ...maxAbsMassErrorKg }, initialEnergyJ, finalEnergyJ,
        signedEnergyErrorJ: finalEnergyJ - initialEnergyJ, maxAbsEnergyErrorJ, maxAbsStepEnergyErrorJ, energyToleranceJ,
        initialSamples: baseline.samples.length, finalSamples: finalCount, peakSamples: peakCount,
        newSamples, finalHubSamples, peakOwnerSamples, finalCursor, finalRevision, ownerChanges,
        temperatureChangedExistingSamples, maxTemperatureShiftC,
        failures: { ...failures }, firstFailureTick: { ...firstFailureTick } };
    },
  };
}
