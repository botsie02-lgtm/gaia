import {
  getMaterial, validateQuantity, validateSample,
} from '../materials/index.js';
import type { MaterialId, MaterialSample } from '../materials/index.js';
import { createProcess, stepProcess, validateRule } from '../processes/index.js';
import type {
  MaterialSample as ProcessSample, ProcessState, ProcessStep, TransformationRule,
} from '../processes/index.js';

// The engine accepts arbitrary strings; narrow them only after registry validation.
function checkedSample(sample: ProcessSample): MaterialSample {
  validateSample(sample as MaterialSample);
  return Object.freeze({ ...sample, materialId: sample.materialId as MaterialId });
}

function inventory(samples: readonly ProcessSample[]): readonly MaterialSample[] {
  if (!Array.isArray(samples)) throw new TypeError('Expected sample inventory');
  return Object.freeze(samples.map(checkedSample));
}

/** In addition to generic rule validation, require catalog properties and no
 * change of material identity. Chemistry needs a separate validated model. */
export function validatePhysicalRule(rule: TransformationRule): void {
  validateRule(rule);
  const inputMass = new Map<string, number>();
  const outputMass = new Map<string, number>();
  for (const input of rule.inputs) {
    checkedSample({ ...input, temperatureC: 0 });
    inputMass.set(input.materialId, input.massKg);
  }
  for (const output of rule.outputs) {
    checkedSample(output);
    outputMass.set(output.materialId, (outputMass.get(output.materialId) ?? 0) + output.massKg);
  }
  for (const id of new Set([...inputMass.keys(), ...outputMass.keys()])) {
    const before = inputMass.get(id) ?? 0;
    const after = outputMass.get(id) ?? 0;
    // Same relative roundoff allowance as the generic engine, per material.
    if (Math.abs(before - after) > 8 * Number.EPSILON * Math.max(before, after)) {
      throw new RangeError('Unsupported material transformation: ' + id);
    }
  }
}

export interface ResourceCalibration {
  readonly resourceId: string;
  readonly materialId: MaterialId;
  readonly kgPerUnit: number;
}

/** Explicit scenario calibration; no default resource-to-mass mapping. */
export function createResourceConverter(calibrations: readonly ResourceCalibration[]) {
  if (!Array.isArray(calibrations)) throw new TypeError('Expected resource calibrations');
  const mappings = new Map<string, ResourceCalibration>();
  for (const calibration of calibrations) {
    if (typeof calibration.resourceId !== 'string' || !calibration.resourceId.trim()) {
      throw new TypeError('Invalid resource ID');
    }
    getMaterial(calibration.materialId);
    validateQuantity(calibration.kgPerUnit);
    if (calibration.kgPerUnit === 0 || mappings.has(calibration.resourceId)) {
      throw new RangeError('Zero or duplicate resource calibration');
    }
    mappings.set(calibration.resourceId, Object.freeze({ ...calibration }));
  }
  function lookup(resourceId: string): ResourceCalibration {
    const mapping = mappings.get(resourceId);
    if (!mapping) throw new RangeError('No mass calibration for resource: ' + resourceId);
    return mapping;
  }
  function converted(result: number, original: number): number {
    validateQuantity(result);
    if (original > 0 && result === 0) throw new RangeError('Conversion underflow');
    return result === 0 ? 0 : result;
  }
  return Object.freeze({
    toSample(resourceId: string, units: number, temperatureC: number): MaterialSample {
      const mapping = lookup(resourceId);
      validateQuantity(units);
      return checkedSample({
        materialId: mapping.materialId,
        phase: getMaterial(mapping.materialId).phase,
        massKg: converted(units * mapping.kgPerUnit, units),
        temperatureC,
      });
    },
    toUnits(resourceId: string, sample: MaterialSample): number {
      const mapping = lookup(resourceId);
      validateSample(sample);
      if (sample.materialId !== mapping.materialId) throw new RangeError('Resource material mismatch');
      return converted(sample.massKg / mapping.kgPerUnit, sample.massKg);
    },
  });
}

/** Commit this complete snapshot, not its individual fields. */
export interface PhysicalBatch {
  readonly process: ProcessState;
  readonly samples: readonly MaterialSample[];
  readonly availableEnergyJ: number;
}

export interface PhysicalStep {
  readonly next: PhysicalBatch;
  readonly status: ProcessStep['status'];
  readonly pauseReason?: ProcessStep['pauseReason'];
  readonly energyConsumedJ: number;
}

function snapshot(process: ProcessState, samples: readonly ProcessSample[], energy: number): PhysicalBatch {
  validateQuantity(energy);
  return Object.freeze({
    process: Object.freeze(process),
    samples: inventory(samples),
    availableEnergyJ: energy,
  });
}

export function createPhysicalBatch(
  rule: TransformationRule, samples: readonly MaterialSample[], availableEnergyJ: number,
): PhysicalBatch {
  validatePhysicalRule(rule);
  return snapshot(createProcess(rule), samples, availableEnergyJ);
}

/** Pure single-tick transaction. Replace the entire previous snapshot exactly
 * once; serialize competing owners. A pause or repeated completion spends zero.
 * This accounts for external joules, not full thermodynamic enthalpy. */
export function stepPhysicalBatch(batch: PhysicalBatch): PhysicalStep {
  validatePhysicalRule(batch.process.rule);
  const process = { ...createProcess(batch.process.rule), completedTicks: batch.process.completedTicks };
  const samples = inventory(batch.samples);
  const result = stepProcess(process, samples, batch.availableEnergyJ);
  const remaining = batch.availableEnergyJ - result.energyConsumedJ;
  // A successful engine tick must not become free through numerical rounding.
  if (result.energyConsumedJ > 0 && remaining === batch.availableEnergyJ) {
    throw new RangeError('Energy resolution insufficient for debit');
  }
  return Object.freeze({
    next: snapshot(result.state, result.samples, remaining),
    status: result.status,
    ...(result.pauseReason ? { pauseReason: result.pauseReason } : {}),
    energyConsumedJ: result.energyConsumedJ,
  });
}
