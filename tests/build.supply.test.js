import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { BUILDINGS, buildingSupplyStatus } from '../src/app/world.js';

function makeBuilding(kind, overrides = {}) {
  return { id: 1, kind, x: 0, y: 0, built: 0, ...overrides };
}

test('partial store + matching pending is hasAllReserved but not fullyDelivered', () => {
  const b = makeBuilding('hunterLodge', {
    store: { wood: 4, stone: 1, food: 0 },
    pending: { wood: 6, stone: 1 },
    spent: { wood: 0, stone: 0 },
    progress: 0,
  });
  const status = buildingSupplyStatus(b);
  assert.equal(status.woodNeed, BUILDINGS.hunterLodge.wood);
  assert.equal(status.stoneNeed, BUILDINGS.hunterLodge.stone);
  assert.equal(status.hasAllReserved, true, 'store + pending covers need');
  assert.equal(status.fullyDelivered, false, 'pending material not yet on site');
});

test('full store on both resources is fullyDelivered', () => {
  const b = makeBuilding('hunterLodge', {
    store: { wood: 10, stone: 2, food: 0 },
    pending: { wood: 0, stone: 0 },
    spent: { wood: 0, stone: 0 },
    progress: 0,
  });
  const status = buildingSupplyStatus(b);
  assert.equal(status.fullyDelivered, true);
  assert.equal(status.hasAllReserved, true);
});

test('store covers wood but stone is only pending → not fullyDelivered', () => {
  const b = makeBuilding('hunterLodge', {
    store: { wood: 10, stone: 0, food: 0 },
    pending: { wood: 0, stone: 2 },
    spent: { wood: 0, stone: 0 },
    progress: 0,
  });
  const status = buildingSupplyStatus(b);
  assert.equal(status.hasAllReserved, true);
  assert.equal(status.fullyDelivered, false);
});

test('zero-cost building (campfire) is fullyDelivered with empty stores', () => {
  const b = makeBuilding('campfire', {
    store: { wood: 0, stone: 0, food: 0 },
    pending: { wood: 0, stone: 0 },
    spent: { wood: 0, stone: 0 },
    progress: 0,
  });
  const status = buildingSupplyStatus(b);
  assert.equal(status.woodNeed, 0);
  assert.equal(status.stoneNeed, 0);
  assert.equal(status.fullyDelivered, true);
});

test('partially spent + remaining store covering the rest is fullyDelivered', () => {
  // A build mid-progress: 4 wood spent, 6 wood still in store, no stone needed.
  const b = makeBuilding('hut', {
    store: { wood: 6, stone: 0, food: 0 },
    pending: { wood: 0, stone: 0 },
    spent: { wood: 4, stone: 0 },
    progress: 4,
  });
  const status = buildingSupplyStatus(b);
  assert.equal(status.woodNeed, 6, 'remaining need accounts for spent');
  assert.equal(status.fullyDelivered, true);
});
