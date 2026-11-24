# Generic batch process engine

The engine is deliberately independent of the material registry and world. Import from
`src/sim/processes/index.ts` (use `.js` import specifiers in TypeScript).

- A rule describes a fixed batch of input material IDs/phases/masses (kg), output
  samples with explicit temperatures (Celsius), optional inclusive input temperature
  bounds, positive duration in ticks, and external energy required per successful tick
  (joules). Rule quantities must be positive; inventory samples may have zero mass.
- `createProcess(rule)` validates and snapshots the rule. `stepProcess(state, samples,
  availableEnergyJ)` attempts one tick and returns status, state, inventory and energy
  consumed. It never mutates its arguments. Retain the returned state, and commit the
  returned inventory and energy debit together. Paused/completed no-op steps debit zero.
- Inputs are checked on every tick; only the final successful tick exchanges mass for
  products. No input reservation or identity tracking exists; the caller must serialize
  competing processes, define batch boundaries, and keep the relevant inventory isolated
  if input continuity matters. No energy is refunded if progress is abandoned.
- Input samples are selected in inventory order; only samples within the input bounds
  count. An input key is a unique material ID/phase pair. Outputs are appended in rule
  order, and unused samples retain their temperatures. No merging or heat transfer.
- Rule mass balance allows a relative floating-point tolerance of 8 machine epsilons,
  not a physical mass loss allowance. Availability uses strict arithmetic; tiny
  rounding shortfalls may pause a process. Unrepresentable subtractions are rejected.
- Energy is an explicit external budget: the caller provides available joules and
  debits the reported amount. Total nominal requirement is energyPerTickJ times
  durationTicks. Temperature is a condition and authored output property, not an
  energy reservoir or a thermodynamic solver. No pressure, reaction stoichiometry,
  heat losses, released energy, or material-specific phase validation is modeled.
- Material IDs are opaque; the future material registry must validate IDs and phase
  compatibility. The water phase-change test uses illustrative thresholds/energy,
  not a calibrated scientific model. No crafting unlocks or world integration here.
