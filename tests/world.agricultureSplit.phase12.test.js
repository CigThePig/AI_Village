import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
  agricultureBonusesAt,
  agricultureGrowthAt,
  agricultureHarvestAt,
  agricultureMoodAt,
} from '../src/app/world.js';

function makeBuilding(kind, x, y, id) {
  return { id, kind, x, y, built: 1 };
}

function buildIndex(buildings) {
  const map = new Map();
  for (const b of buildings) {
    let arr = map.get(b.kind);
    if (!arr) { arr = []; map.set(b.kind, arr); }
    arr.push(b);
  }
  return map;
}

test('B25: split accessors agree with combined agricultureBonusesAt across a mixed village', () => {
  // Build a layout with one of each contributing kind plus a campfire (which
  // must NOT contribute via this path — Phase 4 (B26) explicitly removed it).
  const buildings = [
    makeBuilding('hut', 4, 4, 1),
    makeBuilding('farmplot', 10, 6, 2),
    makeBuilding('well', 7, 9, 3),
    makeBuilding('campfire', 2, 2, 4),
    makeBuilding('storage', 14, 14, 5),
  ];
  const index = buildIndex(buildings);

  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const combined = agricultureBonusesAt(buildings, x, y);
      const mood = agricultureMoodAt(index, x, y);
      const growth = agricultureGrowthAt(index, x, y);
      const harvest = agricultureHarvestAt(index, x, y);
      assert.ok(Math.abs(mood - combined.moodBonus) < 1e-9,
        `mood mismatch at ${x},${y}: ${mood} vs ${combined.moodBonus}`);
      assert.ok(Math.abs(growth - combined.growthBonus) < 1e-9,
        `growth mismatch at ${x},${y}: ${growth} vs ${combined.growthBonus}`);
      assert.ok(Math.abs(harvest - combined.harvestBonus) < 1e-9,
        `harvest mismatch at ${x},${y}: ${harvest} vs ${combined.harvestBonus}`);
    }
  }
});

test('B25: split accessors return 0 for missing index', () => {
  assert.equal(agricultureMoodAt(null, 0, 0), 0);
  assert.equal(agricultureGrowthAt(null, 0, 0), 0);
  assert.equal(agricultureHarvestAt(null, 0, 0), 0);
});

test('B25: unbuilt buildings do not contribute', () => {
  const buildings = [
    { id: 1, kind: 'hut', x: 0, y: 0, built: 0 },
    { id: 2, kind: 'farmplot', x: 0, y: 0, built: 0 },
    { id: 3, kind: 'well', x: 0, y: 0, built: 0 },
  ];
  const index = buildIndex(buildings);
  assert.equal(agricultureMoodAt(index, 0, 0), 0);
  assert.equal(agricultureGrowthAt(index, 0, 0), 0);
  assert.equal(agricultureHarvestAt(index, 0, 0), 0);
});

test('B25: harvestAt only sees farmplots, not wells', () => {
  const buildings = [makeBuilding('well', 3, 3, 1)];
  const index = buildIndex(buildings);
  // Right on top of the well — wells contribute mood + growth, never harvest.
  assert.equal(agricultureHarvestAt(index, 3, 3), 0);
  assert.ok(agricultureMoodAt(index, 3, 3) > 0);
  assert.ok(agricultureGrowthAt(index, 3, 3) > 0);
});
