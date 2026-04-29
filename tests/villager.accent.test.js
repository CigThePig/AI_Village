import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// tileset.js bakes sprites at module-load time. pickAccentColor itself is
// pure (depends only on hash2), but the bake step still runs. Provide a
// no-op canvas/context stub so SHADOW_TEXTURE and the seasonal sprite caches
// can be constructed without throwing in node.
function ensureBrowserStubs() {
  const noopGradient = { addColorStop: () => {} };
  const makeCtx = () => ({
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    fill: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    drawImage: () => {},
    createRadialGradient: () => noopGradient,
    createLinearGradient: () => noopGradient,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    measureText: () => ({ width: 0 }),
    fillText: () => {},
    strokeText: () => {}
  });
  const makeFakeCanvas = () => ({
    width: 0,
    height: 0,
    style: {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ width: 800, height: 600 })
  });
  if (!globalThis.document) {
    globalThis.document = {
      getElementById: makeFakeCanvas,
      createElement: makeFakeCanvas
    };
  }
  if (!globalThis.window) {
    globalThis.window = { devicePixelRatio: 1, addEventListener: () => {} };
  }
}
ensureBrowserStubs();

const { pickAccentColor } = await import('../src/app/tileset.js');

test('pickAccentColor is a pure function of villager id', () => {
  for (let id = 1; id <= 50; id++) {
    assert.equal(pickAccentColor(id), pickAccentColor(id));
  }
});

test('pickAccentColor returns a hex string', () => {
  for (let id = 1; id <= 30; id++) {
    const c = pickAccentColor(id);
    assert.match(c, /^#[0-9a-f]{6}$/i, `not a 6-digit hex: ${c}`);
  }
});

test('pickAccentColor produces multiple distinct colors across ids', () => {
  // The 6-color palette should be reachable from a small id sweep.
  const seen = new Set();
  for (let id = 0; id < 200; id++) seen.add(pickAccentColor(id));
  assert.ok(seen.size >= 4, `expected ≥4 distinct accents, saw ${seen.size}`);
});

test('pickAccentColor handles non-finite ids without throwing', () => {
  // The implementation coerces with `(id | 0) >>> 0`, so NaN/undefined map
  // to 0 — still deterministic, still a valid color.
  assert.match(pickAccentColor(NaN), /^#[0-9a-f]{6}$/i);
  assert.match(pickAccentColor(undefined), /^#[0-9a-f]{6}$/i);
  assert.equal(pickAccentColor(NaN), pickAccentColor(undefined));
});
