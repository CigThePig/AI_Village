import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { createMaterials } from '../src/app/materials.js';
import { ITEM } from '../src/app/constants.js';

function makeSystem({ totals = {}, buildings = [], jobs = [] } = {}) {
  const storageBuilding = { id: 99, kind: 'storage', x: 0, y: 0, built: 1 };
  const allBuildings = [storageBuilding, ...buildings];
  const state = {
    units: { buildings: allBuildings, jobs, villagers: [] },
    time: { tick: 0 },
    stocks: { totals: { wood: 0, stone: 0, food: 0, ...totals }, reserved: {} },
  };
  const policy = { sliders: { build: 0.5 }, style: {} };

  function addJob(job) {
    job.id = state.units.jobs.length + 1;
    job.assigned = 0;
    state.units.jobs.push(job);
    return job;
  }
  function noteJobRemoved() {}
  function findNearestBuilding(_x, _y, kind) {
    return allBuildings.find(b => b.kind === kind && b.built >= 1) || null;
  }
  function detachVillagersFromJob() {}

  const mats = createMaterials({
    state,
    policy,
    addJob,
    noteJobRemoved,
    findNearestBuilding,
    detachVillagersFromJob,
  });
  return { state, mats, storageBuilding };
}

test('requestBuildHauls schedules wood and stone hauls covering exact shortfall', () => {
  const lodge = { id: 1, kind: 'hunterLodge', x: 5, y: 5, built: 0 };
  const { state, mats } = makeSystem({
    totals: { wood: 50, stone: 50 },
    buildings: [lodge],
  });

  mats.requestBuildHauls(lodge);

  const hauls = state.units.jobs.filter(j => j.type === 'haul' && j.bid === lodge.id);
  const woodJob = hauls.find(j => j.resource === ITEM.WOOD);
  const stoneJob = hauls.find(j => j.resource === ITEM.STONE);
  assert.ok(woodJob, 'wood haul scheduled');
  assert.ok(stoneJob, 'stone haul scheduled');
  assert.equal(woodJob.qty, 10, 'hunter lodge needs 10 wood');
  assert.equal(stoneJob.qty, 2, 'hunter lodge needs 2 stone');
  assert.equal(state.stocks.reserved.wood, 10);
  assert.equal(state.stocks.reserved.stone, 2);
  assert.equal(lodge.pending.wood, 10);
  assert.equal(lodge.pending.stone, 2);
});

test('requestBuildHauls accounts for material already in store and pending', () => {
  const lodge = {
    id: 1,
    kind: 'hunterLodge',
    x: 5,
    y: 5,
    built: 0,
    store: { wood: 4, stone: 0, food: 0 },
    pending: { wood: 3, stone: 1 },
    spent: { wood: 0, stone: 0 },
  };
  const { state, mats } = makeSystem({
    totals: { wood: 50, stone: 50 },
    buildings: [lodge],
  });

  mats.requestBuildHauls(lodge);

  const hauls = state.units.jobs.filter(j => j.type === 'haul' && j.bid === lodge.id);
  const woodJob = hauls.find(j => j.resource === ITEM.WOOD);
  const stoneJob = hauls.find(j => j.resource === ITEM.STONE);
  assert.ok(woodJob, 'wood haul still needed: 10 - (4 store + 3 pending) = 3');
  assert.equal(woodJob.qty, 3);
  assert.ok(stoneJob, 'stone haul still needed: 2 - (0 store + 1 pending) = 1');
  assert.equal(stoneJob.qty, 1);
});

test('requestBuildHauls is a no-op when reservation already covers the need', () => {
  const lodge = {
    id: 1,
    kind: 'hunterLodge',
    x: 5,
    y: 5,
    built: 0,
    store: { wood: 4, stone: 1, food: 0 },
    pending: { wood: 6, stone: 1 },
    spent: { wood: 0, stone: 0 },
  };
  const { state, mats } = makeSystem({
    totals: { wood: 50, stone: 50 },
    buildings: [lodge],
  });

  mats.requestBuildHauls(lodge);

  const hauls = state.units.jobs.filter(j => j.type === 'haul' && j.bid === lodge.id);
  assert.equal(hauls.length, 0, 'no haul should be scheduled');
});

test('requestBuildHauls is a no-op once the building is built', () => {
  const lodge = { id: 1, kind: 'hunterLodge', x: 5, y: 5, built: 1 };
  const { state, mats } = makeSystem({
    totals: { wood: 50, stone: 50 },
    buildings: [lodge],
  });

  mats.requestBuildHauls(lodge);

  assert.equal(state.units.jobs.length, 0);
});

test('requestBuildHauls caps haul qty at availableToReserve', () => {
  const lodge = { id: 1, kind: 'hunterLodge', x: 5, y: 5, built: 0 };
  const { state, mats } = makeSystem({
    totals: { wood: 4, stone: 50 }, // only 4 wood available, lodge needs 10
    buildings: [lodge],
  });

  mats.requestBuildHauls(lodge);

  const woodJob = state.units.jobs.find(j => j.type === 'haul' && j.resource === ITEM.WOOD);
  assert.ok(woodJob);
  assert.equal(woodJob.qty, 4, 'cannot reserve more than is available');
  assert.equal(state.stocks.reserved.wood, 4);
});
