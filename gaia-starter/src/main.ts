import './style.css';
import { createWorld, stepWorld } from './sim/world.js';
import { drawWorld, TILE } from './ui/draw.js';
import type { World } from './sim/model.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

app.innerHTML = `
  <header class="topbar"><div><p class="eyebrow">GAIA / EXPERIMENT 001</p>
    <h1>A world that runs itself.</h1><p class="subhead">Seeded agents · finite resources · emergent construction</p></div>
    <div class="state-pill" id="mode">RUNNING</div></header>
  <main class="shell"><section class="world-panel">
    <div class="panel-head"><strong>World view</strong><span id="readout">Tick 0</span></div>
    <canvas id="world" aria-label="Top-down simulated world"></canvas>
    <div class="controls">
      <button id="pause">Pause</button><button id="step">Step +1</button>
      <label>Ticks / second <select id="speed"><option value="5">5</option><option value="10" selected>10</option><option value="30">30</option><option value="60">60</option></select></label>
      <label>World seed <input id="seed" type="number" value="12345" /></label>
      <button id="reset" class="secondary">Regenerate</button>
    </div>
  </section><aside class="sidebar">
    <section class="panel"><div class="section-label">SIMULATION</div><div id="stats" class="stats"></div></section>
    <section class="panel"><div class="section-label">INSPECTOR</div><div id="inspector" class="inspector">Click a tile to inspect its terrain and entities.</div></section>
    <section class="panel"><div class="section-label">RULES IN EFFECT</div><p>Agents choose resources, gather finite deposits, return cargo to the hub, rest when tired, and construct a hearth from wood and stone.</p><p>Once built, the hearth burns wood to generate and lose heat over time.</p><p class="small">This is an abstract material process, not atomic physics or a learned intelligence system yet.</p></section>
    <section class="panel legend"><div class="section-label">LEGEND</div><div><span class="mark wood"></span>Wood <span class="mark stone"></span>Stone <span class="mark agent"></span>Agent <span class="mark hearth"></span>Hearth</div></section>
  </aside></main>
  <footer>GAIA simulation prototype 0.1 · deterministic fixed-step core · browser is a viewer</footer>`;

const get = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element as T;
};
const canvas = get<HTMLCanvasElement>('world');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D unavailable');
const pauseButton = get<HTMLButtonElement>('pause');
const mode = get<HTMLDivElement>('mode');
const readout = get<HTMLSpanElement>('readout');
const stats = get<HTMLDivElement>('stats');
const inspector = get<HTMLDivElement>('inspector');
const speed = get<HTMLSelectElement>('speed');
const seedInput = get<HTMLInputElement>('seed');
let world: World = createWorld();
let running = true;
let selected: { x: number; y: number } | null = null;
let lastTime = performance.now();
let accumulatedMs = 0;

function inspect(): void {
  if (!selected) return;
  const { x, y } = selected;
  const terrain = world.terrain[y * world.width + x];
  const deposits = world.deposits.filter((p) => p.x === x && p.y === y);
  const agents = world.agents.filter((p) => p.x === x && p.y === y);
  const structures = world.structures.filter((p) => p.x === x && p.y === y);
  const lines = [`Tile (${x}, ${y}) · ${terrain}`];
  for (const deposit of deposits) lines.push(`${deposit.material} deposit #${deposit.id}: ${deposit.amount} remaining`);
  for (const agent of agents) lines.push(`Settler #${agent.id}: energy ${agent.energy.toFixed(0)}, cargo ${agent.cargo.wood} wood / ${agent.cargo.stone} stone${agent.resting ? ' (resting)' : ''}`);
  for (const structure of structures) lines.push(`Hearth #${structure.id}: heat ${structure.heat.toFixed(1)}, fuel ${structure.fuel}`);
  if (lines.length === 1) lines.push('No entities on this tile.');
  inspector.textContent = lines.join('\n');
}

function render(): void {
  canvas.width = world.width * TILE;
  canvas.height = world.height * TILE;
  drawWorld(context!, world);
  readout.textContent = `Tick ${world.tick.toLocaleString()} · ${world.width} × ${world.height}`;
  mode.textContent = running ? 'RUNNING' : 'PAUSED';
  mode.classList.toggle('paused', !running);
  pauseButton.textContent = running ? 'Pause' : 'Resume';
  const average = world.agents.reduce((sum, agent) => sum + agent.energy, 0) / world.agents.length;
  stats.innerHTML = [
    ['Agents', world.agents.length], ['Average energy', `${average.toFixed(0)} / 100`],
    ['Wood stored', world.inventory.wood], ['Stone stored', world.inventory.stone],
    ['Wood harvested', world.stats.woodHarvested], ['Stone harvested', world.stats.stoneHarvested],
    ['Hearths', world.stats.hearthsBuilt],
    ['Hearth heat', world.structures[0] ? world.structures[0].heat.toFixed(1) : '—'],
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
  inspect();
}

function frame(now: number): void {
  const dt = Math.min(now - lastTime, 200);
  lastTime = now;
  if (running) {
    accumulatedMs += dt;
    const tickMs = 1000 / Number(speed.value);
    let steps = 0;
    while (accumulatedMs >= tickMs && steps < 10) {
      stepWorld(world);
      accumulatedMs -= tickMs;
      steps++;
    }
    if (steps === 10) accumulatedMs = 0; // Never spiral when the tab is inactive.
  }
  render();
  requestAnimationFrame(frame);
}

pauseButton.addEventListener('click', () => { running = !running; accumulatedMs = 0; });
get<HTMLButtonElement>('step').addEventListener('click', () => {
  running = false;
  accumulatedMs = 0;
  stepWorld(world);
  render();
});
get<HTMLButtonElement>('reset').addEventListener('click', () => {
  const seed = Number(seedInput.value);
  if (!Number.isFinite(seed)) { seedInput.value = '12345'; return; }
  world = createWorld(Math.trunc(seed));
  selected = null;
  inspector.textContent = 'Click a tile to inspect its terrain and entities.';
  accumulatedMs = 0;
  render();
});
canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) * canvas.width / rect.width / TILE);
  const y = Math.floor((event.clientY - rect.top) * canvas.height / rect.height / TILE);
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;
  selected = { x, y };
  inspect();
});
render();
requestAnimationFrame(frame);
