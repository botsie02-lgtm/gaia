import { getMaterial } from './catalog.js';
import type { MaterialId, MaterialPhase, MaterialSample } from './catalog.js';

export const ABSOLUTE_ZERO_C = -273.15;

/** Mass and volume quantities may be zero, but never negative or non-finite. */
export function validateQuantity(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Quantity must be finite and non-negative');
  }
}

function positiveResult(value: number, source: number): number {
  validateQuantity(value);
  if (source > 0 && value === 0) {
    throw new RangeError('Quantity underflow');
  }
  return value === 0 ? 0 : value;
}

function propertiesFor(materialId: MaterialId, phase?: MaterialPhase) {
  const material = getMaterial(materialId);
  if (phase !== undefined && phase !== material.phase) {
    throw new RangeError('Unsupported material phase');
  }
  return material;
}

export function massToVolumeM3(materialId: MaterialId, massKg: number, phase?: MaterialPhase): number {
  const material = propertiesFor(materialId, phase);
  validateQuantity(massKg);
  return positiveResult(massKg / material.densityKgPerM3, massKg);
}

export function volumeToMassKg(materialId: MaterialId, volumeM3: number, phase?: MaterialPhase): number {
  const material = propertiesFor(materialId, phase);
  validateQuantity(volumeM3);
  return positiveResult(volumeM3 * material.densityKgPerM3, volumeM3);
}

/** Validate data even when it came from untyped callers or serialized state. */
export function validateSample(sample: MaterialSample): void {
  if (sample === null || typeof sample !== 'object') {
    throw new TypeError('Expected a material sample');
  }
  const material = getMaterial(sample.materialId);
  if (sample.phase !== material.phase) {
    throw new RangeError('Unsupported material phase');
  }
  validateQuantity(sample.massKg);
  if (!Number.isFinite(sample.temperatureC) || sample.temperatureC < ABSOLUTE_ZERO_C) {
    throw new RangeError('Temperature must be finite and at or above absolute zero');
  }
}

function heatCapacity(sample: MaterialSample): number {
  return positiveResult(sample.massKg * getMaterial(sample.materialId).specificHeatJPerKgK, sample.massKg);
}

/**
 * Ideal insulated contact between two unchanged phases, with constant specific heats.
 * Returns a common temperature without merging materials or changing either input.
 */
export function thermalEquilibriumC(a: MaterialSample, b: MaterialSample): number {
  validateSample(a);
  validateSample(b);
  const ca = heatCapacity(a);
  const cb = heatCapacity(b);
  if (ca === 0 && cb === 0) {
    throw new RangeError('Thermal equilibrium requires positive total mass');
  }
  if (ca === 0) return b.temperatureC;
  if (cb === 0 || a.temperatureC === b.temperatureC) return a.temperatureC;

  // Normalize before summing to avoid overflow in the denominator or energy products.
  const scale = Math.max(ca, cb);
  const wa = ca / scale;
  const wb = cb / scale;
  const low = Math.min(a.temperatureC, b.temperatureC);
  const high = Math.max(a.temperatureC, b.temperatureC);
  const highWeight = (a.temperatureC > b.temperatureC ? wa : wb) / (wa + wb);
  const result = low + (high - low) * highWeight;
  // Clamp floating-point roundoff to the physical interval.
  return Math.min(high, Math.max(low, result));
}

/** Only homogeneous samples with the same material and phase can become one sample. */
export function combineSamples(a: MaterialSample, b: MaterialSample): MaterialSample {
  validateSample(a);
  validateSample(b);
  if (a.materialId !== b.materialId || a.phase !== b.phase) {
    throw new RangeError('Cannot combine different materials or phases');
  }
  const massKg = a.massKg + b.massKg;
  validateQuantity(massKg);
  // Do not silently discard a positive input that is below the sum's precision.
  if (a.massKg > 0 && b.massKg > 0 && (massKg === a.massKg || massKg === b.massKg)) {
    throw new RangeError('Combined mass loses an input to floating-point precision');
  }
  return {
    materialId: a.materialId,
    phase: a.phase,
    massKg,
    temperatureC: thermalEquilibriumC(a, b),
  };
}
