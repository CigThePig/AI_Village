import test from 'node:test';
import { strict as assert } from 'node:assert';

import { BUILDINGS, agricultureBonusesAt } from '../src/app/world.js';

function makeBuilding(kind, overrides = {}) {
  return { id: 1, kind, x: 0, y: 0, built: 1, ...overrides };
}

test('B12: well effects do not declare harvestBonus', () => {
  // The dead branch in agricultureBonusesAt's well case checked for a field
  // that no well effect actually defines. This test fails if someone adds
  // harvestBonus to wells without also reinstating the read.
  assert.equal(BUILDINGS.well.effects.harvestBonus, undefined,
    'well must not declare harvestBonus');
});

test('B12: agricultureBonusesAt over a well returns harvestBonus = 0', () => {
  const buildings = [makeBuilding('well', { x: 5, y: 5 })];
  const bonuses = agricultureBonusesAt(buildings, 5, 5);
  assert.equal(bonuses.harvestBonus, 0, 'well must not contribute harvestBonus');
  assert.ok(bonuses.growthBonus > 0, 'well must contribute hydrationGrowthBonus');
  assert.ok(bonuses.moodBonus > 0, 'well must contribute moodBonus');
});

test('B12: well outside hydration radius returns no bonuses', () => {
  const buildings = [makeBuilding('well', { x: 5, y: 5 })];
  const bonuses = agricultureBonusesAt(buildings, 50, 50);
  assert.equal(bonuses.harvestBonus, 0);
  assert.equal(bonuses.growthBonus, 0);
  assert.equal(bonuses.moodBonus, 0);
});
