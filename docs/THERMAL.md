# Isolated thermal contact (v0.2)

This independent primitive advances two distinct homogeneous physical material
samples through one logical tick. It does not modify World, legacy resources,
the process engine or the physics bridge. Import from
`src/sim/thermal/index.ts` (use .js import specifiers).

## API and units

- `stepThermalContact(a, b, { conductanceWPerK, tickDurationSeconds })`
  returns a frozen snapshot containing fresh frozen samples `a` and `b`,
  plus signed `transferredEnergyJ`. Positive means a loses and b gains
  heat; negative means b loses and a gains. The value is the nominal
  modeled exchange, subject to floating-point temperature resolution.
- `sensibleEnergyJ(sample)` returns the modeled sensible energy relative
  to absolute zero: massKg * specificHeatJPerKgK * (temperatureC + 273.15).
  This arbitrary reference and constant heat capacity are bookkeeping, not
  a measurement of actual internal energy or enthalpy down to absolute zero.
- Sample validation and material properties come from the existing registry.
  Different material IDs and supported phases can exchange heat without
  mixing. Material ID, phase and mass are preserved. Gas (including water
  vapour), ice and other unsupported phases are rejected.
- Conductance (W/K = J/(s K)) and duration (modeled seconds per logical tick)
  must be finite and non-negative. Equal temperatures, zero conductance,
  zero duration or either zero-mass sample are no-ops. An empty sample has
  no thermal reservoir. Both inputs and configuration are validated even
  for no-ops. Temperatures must be finite and at least -273.15 C.

## Model

Let Ca and Cb denote the catalog specific heats multiplied by the sample
masses (J/K). For two positive capacities and constant effective
conductance G, instantaneous heat flow from a to b is G*(Ta-Tb).
For a duration dt, the exact solution of this simplified two-reservoir
model is:

    R = Ca*Cb/(Ca+Cb)
    Q = R*(Ta-Tb)*(1 - exp(-G*dt/R))
    Ta' = Ta - Q/Ca
    Tb' = Tb + Q/Cb

Temperature differences in Celsius and kelvin are identical. R is the
reduced heat capacity. The transfer is bounded by the amount needed
to reach equilibrium; unlike an unclamped explicit Euler update, it
cannot overshoot for long ticks or large conductance. Repeated ticks with
unchanged parameters approach the catalog's heat-capacity-weighted
equilibrium. The same Q is debited and credited; no external energy
is created. The implementation normalizes the reduced capacity,
uses expm1 for small rates, and uses log space if G*dt overflows or
underflows to zero. Rounding is clamped to the equilibrium interval.

For example, 2 kg of stone at 90 C and 1 kg of water at 20 C have heat
capacities of 1580 and 4182 J/K, respectively. Their final ideal
equilibrium is about 39.2 C; the rate of approach depends on the
explicit conductance and tick duration, not on rendering or frame time.

## Numerical boundaries

All quantities are IEEE-754 doubles. Non-finite capacity, energy, pair
energy totals and transfer amounts are rejected. A computed exchange
below both samples' temperature resolution is a no-op; when only one
side can resolve the change, its difference from the nominal Q is
floating-point roundoff, not a physical source/sink. An update that
cannot conserve modeled pair energy within 16 machine epsilons of its
energy scale (with a subnormal floor) is rejected, rather than silently
committing a nonconservative result. Very near absolute zero or with
extreme mass/temperature ratios, the representability of temperatures
can limit useful precision. This is not a high-precision solver.

## Scientific limits and future integration

The catalog contains approximate bulk heat capacities and densities.
Density is not needed for mass-based lumped heat capacity; it cannot
supply conductivity or contact area. G is an explicit scenario parameter,
not a derived material constant. The model assumes each body is internally
isothermal and the pair isolated, with fixed mass, phase and constant
specific heat. It excludes geometry, temperature gradients, conductivity,
contact resistance, radiation, convection, environmental heat loss,
pressure, phase stability, latent heat, boiling, combustion and chemistry.
A fixed-phase sample can exceed real phase-stability ranges without
changing phase. Catalog reference properties are not reliable at arbitrary
temperatures, especially near absolute zero.

Future World integration must establish modeled seconds per tick,
calibrated kilograms per legacy resource unit via the physics bridge,
persistent sample identities and temperature state, and a deterministic
schedule of actual contacts. Commit both samples together exactly once,
serialize competing contacts/processes in stable order, and publish any
event only after commit using stable entity IDs and world ticks. Do not
also debit an external energy budget for the same internal exchange.
Process heating, fuel energy and environmental reservoirs must be
accounted separately. Pairwise ordering affects a multi-body approximation;
a coupled solver, geometry and measured conductivity/contact properties
are future work. Forge and combustion require additional materials and
physical/chemical data described in PHYSICS_BRIDGE.md.
