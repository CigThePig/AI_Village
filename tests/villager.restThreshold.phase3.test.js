import test from 'node:test';
import { strict as assert } from 'node:assert';

const { policy } = await import('../src/policy/policy.js');

// Mirrors the predicate at src/app/villagerTick.js:340-347. Keeping a copy
// here lets us assert behavior without reaching into the full villager-tick
// state machine (which has 30+ deps).
function shouldRest({ energy, fatigueFlag, style }) {
  const restThreshold = Number.isFinite(style.restEnergyThreshold)
    ? style.restEnergyThreshold
    : 0.26;
  const restFatigueBoost = Number.isFinite(style.restFatigueBoost)
    ? style.restFatigueBoost
    : 0.04;
  const effective = fatigueFlag ? restThreshold + restFatigueBoost : restThreshold;
  return energy < effective;
}

test('B1: rest decision uses restEnergyThreshold from policy when not fatigued', () => {
  const style = policy.style.jobScoring;
  assert.equal(
    shouldRest({ energy: style.restEnergyThreshold - 0.001, fatigueFlag: false, style }),
    true,
    'energy just below threshold must trigger rest'
  );
  assert.equal(
    shouldRest({ energy: style.restEnergyThreshold + 0.001, fatigueFlag: false, style }),
    false,
    'energy just above threshold must NOT trigger rest'
  );
});

test('B1: fatigued villager rests at higher energy (monotonicity)', () => {
  const style = policy.style.jobScoring;
  const justAboveBase = style.restEnergyThreshold + 0.001;
  assert.equal(
    shouldRest({ energy: justAboveBase, fatigueFlag: false, style }),
    false,
    'no fatigue: just above base does not rest'
  );
  assert.equal(
    shouldRest({ energy: justAboveBase, fatigueFlag: true, style }),
    true,
    'fatigue: same energy DOES rest'
  );
  assert.ok(style.restFatigueBoost > 0, 'restFatigueBoost must remain positive');
});

test('B1: restEnergyThreshold dominates the old dead 0.8*energyFatigueThreshold clause', () => {
  // Regression guard. The pre-fix predicate had a third OR'd clause
  // `energy < energyFatigueThreshold * 0.8` that always fired before the
  // restEnergyThreshold clause, making the policy knob dead. After the fix,
  // the policy knob must be at least as authoritative as the dead clause.
  const style = policy.style.jobScoring;
  assert.ok(
    style.restEnergyThreshold >= style.energyFatigueThreshold * 0.8 - 1e-9,
    `restEnergyThreshold (${style.restEnergyThreshold}) must dominate ` +
      `energyFatigueThreshold * 0.8 (${style.energyFatigueThreshold * 0.8})`
  );
});
