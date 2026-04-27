import { GRID_H, GRID_W, TILE, tileToPxX, tileToPxY } from './constants.js';
import { LIGHTING, clamp01 } from './lighting.js';
import { cam, ctx } from './canvas.js';
import { clamp, irnd, rnd } from './rng.js';
import { DAWN_AMBIENT_THRESHOLD, isNightAmbient } from './simulation.js';

export function createNocturnalSystem(_opts) {
  const nocturnalEntities = new Array(28).fill(null).map(() => ({
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 0.45,
    alpha: 0,
    energy: 1,
    fade: 0,
    wanderTicks: 0,
  }));
  let nocturnalSpawnCooldown = 0;

  function nocturnalAmbientStrength(ambient) {
    const usableRange = Math.max(0.0001, 1 - LIGHTING.nightFloor);
    return clamp01((1 - ambient) / usableRange);
  }

  function spawnNocturnalEntity(nightStrength) {
    const slot = nocturnalEntities.find((entity) => !entity.active);
    if (!slot) return false;

    const margin = 1.25;
    slot.active = true;
    slot.x = rnd(margin, GRID_W - margin);
    slot.y = rnd(margin, GRID_H - margin);
    const angle = rnd(0, Math.PI * 2);
    const speed = rnd(0.004, 0.018);
    slot.vx = Math.cos(angle) * speed;
    slot.vy = Math.sin(angle) * speed;
    slot.radius = rnd(0.35, 0.65);
    slot.energy = 0.5 + nightStrength * 0.45 + rnd(0, 0.15);
    slot.fade = 0;
    slot.wanderTicks = irnd(28, 90);
    return true;
  }

  function updateNocturnalEntities(ambient) {
    const nightActive = isNightAmbient(ambient);
    const nightStrength = nocturnalAmbientStrength(ambient);
    const dawnFade = clamp01((DAWN_AMBIENT_THRESHOLD - ambient) / DAWN_AMBIENT_THRESHOLD);
    let activeCount = 0;

    for (const entity of nocturnalEntities) {
      if (!entity.active) continue;

      entity.wanderTicks--;
      if (entity.wanderTicks <= 0) {
        const angle = rnd(0, Math.PI * 2);
        const speed = rnd(0.0035, 0.015);
        entity.vx = Math.cos(angle) * speed;
        entity.vy = Math.sin(angle) * speed;
        entity.wanderTicks = irnd(30, 120);
      }

      entity.x = clamp(entity.x + entity.vx, 1.25, GRID_W - 1.25);
      entity.y = clamp(entity.y + entity.vy, 1.25, GRID_H - 1.25);
      if (entity.x <= 1.3 || entity.x >= GRID_W - 1.3) entity.vx *= -0.6;
      if (entity.y <= 1.3 || entity.y >= GRID_H - 1.3) entity.vy *= -0.6;

      const targetFade = nightActive ? 1 : dawnFade * 0.65;
      const fadeDelta = targetFade - entity.fade;
      entity.fade = clamp(entity.fade + fadeDelta * 0.08 - (nightActive ? 0 : 0.01), 0, 1);
      entity.alpha = clamp(entity.energy * entity.fade * (0.45 + nightStrength * 0.6), 0, 1);

      if (entity.alpha <= 0.02) {
        entity.active = false;
        continue;
      }
      activeCount++;
    }

    if (nightActive) {
      if (nocturnalSpawnCooldown > 0) nocturnalSpawnCooldown--;
      const targetPopulation = Math.max(4, Math.floor(nightStrength * nocturnalEntities.length * 0.8));
      while (activeCount < targetPopulation && nocturnalSpawnCooldown <= 0) {
        if (!spawnNocturnalEntity(nightStrength)) break;
        nocturnalSpawnCooldown = irnd(12, 26);
        activeCount++;
      }
    } else {
      nocturnalSpawnCooldown = Math.max(nocturnalSpawnCooldown, 6);
    }
  }

  function drawNocturnalEntities(ambient) {
    const nightStrength = nocturnalAmbientStrength(ambient);
    if (nightStrength <= 0 && !nocturnalEntities.some((e) => e.active)) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const entity of nocturnalEntities) {
      if (!entity.active || entity.alpha <= 0) continue;
      const gx = tileToPxX(entity.x, cam);
      const gy = tileToPxY(entity.y, cam);
      const radiusPx = entity.radius * TILE * cam.z * (1.2 + nightStrength * 0.8);
      const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, radiusPx);
      const alpha = entity.alpha;
      grd.addColorStop(0, `rgba(170,210,255,${0.6 * alpha})`);
      grd.addColorStop(0.45, `rgba(140,190,255,${0.35 * alpha})`);
      grd.addColorStop(1, 'rgba(120,170,240,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(gx, gy, radiusPx, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  return {
    nocturnalEntities,
    nocturnalAmbientStrength,
    spawnNocturnalEntity,
    updateNocturnalEntities,
    drawNocturnalEntities,
  };
}
