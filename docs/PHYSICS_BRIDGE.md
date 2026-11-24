# Physics compatibility bridge (v0.2)

This headless adapter connects the existing materials catalog and fixed-tick batch engine.
It does not change World, resource counts, crafting, or hearth behaviour.

## Contract

- Import from `src/sim/physics/index.ts` using .js import specifiers.
- `validatePhysicalRule(rule)` delegates generic validation to the process engine and
  sample validation to the material registry. Every input and output must have
  catalog properties for its phase. Water gas and ice are unsupported; liquid
  density and heat capacity are never substituted for vapour or ice.
- The current bridge additionally requires mass conservation per material ID,
  not just total mass, within the engine's relative floating-point tolerance.
  This intentionally excludes chemical reactions and material transmutation until
  a chemical model exists. Fixed-phase subdivision, reassembly and heating can
  be described by a rule; no crafting unlock tree is present.
- `createResourceConverter([{ resourceId, materialId, kgPerUnit }])` takes explicit
  scenario-specific positive mass calibration. `toSample(id, units, temperatureC)`
  returns a validated catalog-phase sample; `toUnits(id, sample)` reverses mass
  accounting only. No default mapping or silent rounding to whole resource units.
  Reverse conversion does not preserve temperature in legacy counts; keep physical
  state separately once migrated. These calibrations are game policy, not density
  measurements. Store the chosen mapping alongside future world saves.
- `createPhysicalBatch(rule, samples, availableEnergyJ)` creates an immutable
  detached snapshot of process state, inventory and available external energy.
  `stepPhysicalBatch(batch)` returns an immutable result with `next`, status,
  optional pause reason and the tick's energy debit. Commit the whole next
  snapshot exactly once, including progress and energy, not separate field writes.
  Serialize competing batches; replaying the old snapshot is deterministic but
  is not an authorization to commit twice. Inputs are checked every tick and
  consumed on completion; no reservation or exclusive sample identity is provided.
  Pauses and repeated completion cost zero, and spent energy is not refunded.
  For replenishment or inventory changes, the owner supplies a new combined
  snapshot and must account for the external change itself.
- The bridge does not calculate heat transfer or validate arbitrary authored
  output temperatures against enthalpy. External joules are explicitly debited
  on successful ticks; callers must choose physically justified rules and account
  for work, losses and heat reservoirs separately. Floating-point arithmetic is
  approximate; a debit too small to change the energy balance is rejected.

## Demonstration: sensible heating

The tests warm 1 kg liquid water from 20 to 30 degrees Celsius in two ticks.
Using catalog heat capacity 4182 J/(kg K), the nominal sensible heat is
1 × 4182 × 10 = 41820 J, or 20910 J per tick. Inputs are constrained to 20 C;
unconsumed water and stone are untouched. This is an ideal insulated, constant
specific-heat approximation, at pressure where water remains liquid. No mass
vanishes, no phase transition occurs, and the exact supplied external energy
budget covers the nominal sensible heat. Partial ticks represent process work,
not a continuously updated sample temperature; heat storage during a partial
batch is abstract and not independently modeled.

## Missing data before forge or combustion

A forge requires identified ore/metal/alloy and refractory materials, composition,
temperature-dependent heat capacities, density, solidus/liquidus, latent heats,
thermal conductivity, pressure and atmosphere, emissivity, geometry, heat-transfer
and loss models, and mechanical/workability properties. Stone is not a generic
substitute for ore or metal. Actual fuel combustion requires fuel composition and
moisture, oxygen/air supply, carbon dioxide, carbon monoxide, water vapour and
other relevant products, ash composition, balanced elemental stoichiometry,
heats of reaction, ignition/kinetics, oxygen transport and heat losses.
Gas-phase density/heat capacity and pressure dependence, including water vapour,
must be modeled explicitly. A fuel-potential flag is not a reaction rule.

Future integration should atomically commit material inventory, energy and
process state at a logical world tick, then emit an event. The existing world
still uses abstract units; this bridge does not depend on history or skill modules.
