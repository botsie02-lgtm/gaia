/** Simulation types. This directory must not import browser/UI code. */
import type { EventLedger } from './history/events.js';
import type { SkillConfig, SkillRecord } from './skills/index.js';

import type { AgentMemory } from './memory/index.js';
import type { Observation } from './perception/index.js';
import type { AgentMode, Decision } from './agents/index.js';

import type { PhysicalInventory } from './inventory/index.js';
import type { PhysicalResourceConfig, ResourceMode } from './physical-world.js';

export type Material = 'wood' | 'stone';
export type Terrain = 'grass' | 'dirt' | 'water';
export type Faction = 'settler' | 'neutral' | 'hostile';
export type Position = { x: number; y: number };
export type Inventory = Record<Material, number>;

export interface Agent extends Position {
  id: number;
  kind: 'agent';
  faction: Faction;
  energy: number;
  resting: boolean;
  cargo: Inventory;
  skills: { gathering: SkillRecord };
  readonly memory: AgentMemory;
  observation?: Observation;
  decision?: Decision;
}

export interface Deposit extends Position {
  id: number;
  kind: 'deposit';
  material: Material;
  amount: number;
}

export interface Hearth extends Position {
  id: number;
  kind: 'structure';
  structure: 'hearth';
  /** In prototype units, the amount of wood awaiting combustion. */
  fuel: number;
  /** Abstract heat units, not degrees Celsius yet. */
  heat: number;
  stoneUsed: number;
}

import type { ThermalState } from './environment/index.js';

export interface World {
  readonly thermal?: ThermalState;
  readonly resourceMode: ResourceMode;
  readonly physicalConfig: PhysicalResourceConfig | null;
  readonly physicalInventory: PhysicalInventory | null;
  readonly agentMode: AgentMode;
  readonly perceptionRange: number;
  readonly memoryCapacity: number;
  seed: number;
  randomState: number;
  tick: number;
  nextEntityId: number;
  width: number;
  height: number;
  terrain: Terrain[];
  hub: Position & { id: number };
  readonly history: EventLedger;
  readonly gatheringSkillConfig: SkillConfig;
  inventory: Inventory;
  agents: Agent[];
  deposits: Deposit[];
  structures: Hearth[];
  stats: { woodHarvested: number; stoneHarvested: number; hearthsBuilt: number };
}
