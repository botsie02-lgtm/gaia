import {
  ABSOLUTE_ZERO_C, getMaterial, thermalEquilibriumC, validateQuantity, validateSample,
} from '../materials/index.js';
import type { MaterialSample } from '../materials/index.js';

export interface ThermalContact {
  /** Effective pair conductance (W/K), not bulk thermal conductivity. */
  readonly conductanceWPerK: number;
  /** Duration of one logical tick in modeled seconds, never wall-clock time. */
  readonly tickDurationSeconds: number;
}

export interface ThermalStep {
  readonly a: MaterialSample;
  readonly b: MaterialSample;
  /** Signed nominal sensible heat in joules: positive a -> b, negative b -> a. */
  readonly transferredEnergyJ: number;
}

function capacity(sample: MaterialSample): number {
  validateSample(sample);
  const value = sample.massKg * getMaterial(sample.materialId).specificHeatJPerKgK;
  validateQuantity(value);
  if (sample.massKg > 0 && value === 0) throw new RangeError('Heat capacity underflow');
  return value;
}

function energy(sample: MaterialSample, heatCapacity: number): number {
  const value = heatCapacity * (sample.temperatureC - ABSOLUTE_ZERO_C);
  validateQuantity(value);
  return value === 0 ? 0 : value;
}

/** Constant-specific-heat bookkeeping relative to absolute zero, not enthalpy. */
export function sensibleEnergyJ(sample: MaterialSample): number {
  return energy(sample, capacity(sample));
}

function snapshot(sample: MaterialSample, temperatureC: number): MaterialSample {
  return Object.freeze({
    materialId: sample.materialId, phase: sample.phase, massKg: sample.massKg, temperatureC,
  });
}

/** Advance an isolated pair by exactly one tick. No phase change or external
 * energy. Both samples must have catalog properties; different materials and
 * supported phases may exchange heat without mixing. Commit both outputs together.
 */
export function stepThermalContact(
  a: MaterialSample, b: MaterialSample, contact: ThermalContact,
): ThermalStep {
  const ca = capacity(a);
  const cb = capacity(b);
  if (!contact || typeof contact !== 'object') throw new TypeError('Expected thermal contact');
  const { conductanceWPerK: g, tickDurationSeconds: dt } = contact;
  validateQuantity(g);
  validateQuantity(dt);
  const before = energy(a, ca) + energy(b, cb);
  validateQuantity(before);

  const result = (ta: number, tb: number, q: number): ThermalStep => Object.freeze({
    a: snapshot(a, ta), b: snapshot(b, tb), transferredEnergyJ: q === 0 ? 0 : q,
  });
  const unchanged = () => result(a.temperatureC, b.temperatureC, 0);
  if (ca === 0 || cb === 0 || g === 0 || dt === 0 || a.temperatureC === b.temperatureC) {
    return unchanged();
  }

  const aHot = a.temperatureC > b.temperatureC;
  const hot = aHot ? a : b;
  const cold = aHot ? b : a;
  const ch = aHot ? ca : cb;
  const cc = aHot ? cb : ca;
  const delta = hot.temperatureC - cold.temperatureC;
  validateQuantity(delta);

  // Reduced capacity = Ch*Cc/(Ch+Cc), avoiding overflow of products/sums.
  const small = Math.min(ch, cc);
  const large = Math.max(ch, cc);
  const reduced = small / (1 + small / large);
  // Exact solution of d(delta)/dt = -G*delta/reduced for constant G and C.
  // Fall back to log space only when the intermediate G*dt is unrepresentable.
  const exposure = g * dt;
  const x = Number.isFinite(exposure) && exposure > 0
    ? exposure / reduced
    : Math.exp(Math.log(g) + Math.log(dt) - Math.log(reduced));
  const fraction = -Math.expm1(-x);
  const q = (reduced * delta) * fraction;
  validateQuantity(q);
  if (q === 0) return unchanged();

  // Clamp only floating-point roundoff to the catalog equilibrium interval.
  const equilibrium = thermalEquilibriumC(hot, cold);
  const th = Math.max(equilibrium, hot.temperatureC - q / ch);
  const tc = Math.min(equilibrium, cold.temperatureC + q / cc);
  if (th === hot.temperatureC && tc === cold.temperatureC) return unchanged();
  const next = aHot ? result(th, tc, q) : result(tc, th, -q);
  validateSample(next.a);
  validateSample(next.b);
  const after = energy(next.a, ca) + energy(next.b, cb);
  validateQuantity(after);
  const tolerance = Math.max(8 * Number.MIN_VALUE, 16 * Number.EPSILON * Math.max(before, after));
  if (Math.abs(after - before) > tolerance) {
    throw new RangeError('Thermal energy conservation exceeds floating-point tolerance');
  }
  return next;
}
