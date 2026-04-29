import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { BUILDINGS, ensureBuildingData } from '../src/app/world.js';

// Phase 7 (B3/S6): each kind declares a per-build labor budget so
// construction takes felt time. Campfire stays at 0 (no felt construction
// for cost-0 emitter init).
test('BUILDINGS expose buildLaborTicks per kind', () => {
  assert.equal(BUILDINGS.hut.buildLaborTicks, 60);
  assert.equal(BUILDINGS.storage.buildLaborTicks, 80);
  assert.equal(BUILDINGS.farmplot.buildLaborTicks, 30);
  assert.equal(BUILDINGS.well.buildLaborTicks, 100);
  assert.equal(BUILDINGS.hunterLodge.buildLaborTicks, 80);
  assert.equal(BUILDINGS.campfire.buildLaborTicks, 0);
});

test('ensureBuildingData initializes laborProgress to 0 on a new build', () => {
  const b = { id: 1, kind: 'hut', x: 0, y: 0, built: 0 };
  ensureBuildingData(b);
  assert.equal(b.laborProgress, 0);
});

test('ensureBuildingData preserves an existing laborProgress', () => {
  const b = { id: 1, kind: 'hut', x: 0, y: 0, built: 0, laborProgress: 42 };
  ensureBuildingData(b);
  assert.equal(b.laborProgress, 42);
});

test('ensureBuildingData treats already-built buildings as having full labor', () => {
  // Old saves from before Phase 7 will have built=1 with no laborProgress.
  // Initializing to the kind's full budget keeps the labor accounting
  // consistent (the building is already standing).
  const b = { id: 1, kind: 'hut', x: 0, y: 0, built: 1 };
  ensureBuildingData(b);
  assert.equal(b.laborProgress, BUILDINGS.hut.buildLaborTicks);
});
