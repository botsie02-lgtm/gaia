import type { Agent, World } from '../sim/model.js';
import { indexOf } from '../sim/world.js';

export const TILE = 14;

function agentColor(agent: Agent): string {
  if (agent.faction === 'neutral') return '#bca5e2';
  if (agent.faction === 'hostile') return '#e66e6e';
  return '#f5d77b';
}

export function drawWorld(ctx: CanvasRenderingContext2D, world: World): void {
  const { width, height } = world;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width * TILE, height * TILE);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const terrain = world.terrain[indexOf(world, x, y)];
      ctx.fillStyle = terrain === 'water' ? '#1f6170' : terrain === 'dirt' ? '#6f6549' : '#315a43';
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      if ((x * 43 + y * 17) % 11 === 0 && terrain === 'grass') {
        ctx.fillStyle = '#3e7552';
        ctx.fillRect(x * TILE + 4, y * TILE + 8, 2, 3);
      }
    }
  }

  // Settlement / central resource bank.
  const hx = world.hub.x * TILE;
  const hy = world.hub.y * TILE;
  ctx.fillStyle = '#ac8a67';
  ctx.fillRect(hx - 1, hy - 1, TILE + 2, TILE + 2);
  ctx.fillStyle = '#c5ae84';
  ctx.fillRect(hx + 3, hy + 3, TILE - 6, TILE - 6);

  for (const deposit of world.deposits) {
    const x = deposit.x * TILE;
    const y = deposit.y * TILE;
    if (deposit.material === 'wood') {
      ctx.fillStyle = '#1d3b2b';
      ctx.fillRect(x + 1, y + 7, 12, 5);
      ctx.fillStyle = '#77b56d';
      ctx.fillRect(x + 3, y + 1, 8, 9);
      ctx.fillStyle = '#4a8a54';
      ctx.fillRect(x + 1, y + 5, 12, 5);
    } else {
      ctx.fillStyle = '#a3adb1';
      ctx.fillRect(x + 2, y + 6, 11, 6);
      ctx.fillStyle = '#cbd3cc';
      ctx.fillRect(x + 5, y + 3, 5, 4);
    }
  }

  for (const structure of world.structures) {
    const x = structure.x * TILE;
    const y = structure.y * TILE;
    ctx.fillStyle = '#a7aaa4';
    ctx.fillRect(x + 1, y + 1, 12, 12);
    ctx.fillStyle = '#3d3835';
    ctx.fillRect(x + 4, y + 4, 6, 6);
    if (structure.heat > 0) {
      ctx.fillStyle = '#fcbe64';
      ctx.fillRect(x + 5, y + 2, 4, 8);
      ctx.fillStyle = '#f1784d';
      ctx.fillRect(x + 6, y + 5, 3, 5);
    }
  }

  for (const agent of world.agents) {
    const offset = agent.id % 3 - 1;
    const x = agent.x * TILE + 4 + offset * 2;
    const y = agent.y * TILE + 4 + (Math.floor(agent.id / 3) % 3 - 1);
    ctx.fillStyle = '#1c2426';
    ctx.fillRect(x - 1, y - 1, 8, 8);
    ctx.fillStyle = agent.resting ? '#92a2a5' : agentColor(agent);
    ctx.fillRect(x, y, 6, 6);
    if (agent.cargo.wood > 0) ctx.fillStyle = '#84bc71';
    else if (agent.cargo.stone > 0) ctx.fillStyle = '#c6cbca';
    else continue;
    ctx.fillRect(x + 3, y - 2, 4, 3);
  }
}
