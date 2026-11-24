# Development roadmap

## Milestone 0.1 — World heartbeat (this starter)
- [x] Seeded world with terrain
- [x] Autonomous agents with energy/rest
- [x] Finite wood and stone resources
- [x] Hub collection and hearth construction
- [x] Simplified fuel/heat cycle
- [x] Testable deterministic world ticks
- [x] Pixel-art debug view and tile inspection

## Milestone 0.2 — World substrate
- [ ] Materials with explicit state: amount, temperature, density and phase (as applicable)
- [ ] Generic transformations: inputs, outputs, conditions and time
- [ ] Resource bookkeeping and conservation checks where physically appropriate
- [ ] Event log showing why changes occurred

## Milestone 0.3 — Generic entity model
- [ ] Agent perception and local knowledge separate from omniscient world state
- [ ] Needs (energy, hydration, shelter) and explicit actions
- [ ] Neutral and hostile factions using the same agent systems
- [ ] Agent memories and observable action selection

## Milestone 0.4 — Discovery & building
- [ ] Multi-step actions: gather, transport, arrange, ignite, heat, craft
- [ ] Information acquisition and sharing; first experiments/learning
- [ ] Material-defined forge process with realistic approximation boundaries

## Beyond
- [ ] World serialization, replay, independent headless mode and performance benchmarks
- [ ] Chunking/LOD, larger populations and ecological systems
- [ ] Social memory, culture, persistent collective entities / deities
- [ ] Multiple worlds/universes only after single-world architecture is robust
