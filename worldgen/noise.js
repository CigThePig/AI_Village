;(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  function mulberry32(seed) {
    return function () {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function buildTables(seed) {
    const rng = mulberry32(seed >>> 0);
    const permBase = new Uint8Array(256);
    const gradients = new Float32Array(512);
    for (let i = 0; i < 256; i++) {
      permBase[i] = i;
      const angle = rng() * TAU;
      gradients[i * 2] = Math.cos(angle);
      gradients[i * 2 + 1] = Math.sin(angle);
    }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = permBase[i];
      permBase[i] = permBase[j];
      permBase[j] = tmp;
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      perm[i] = permBase[i & 255];
    }
    return { perm, gradients };
  }

  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function grad(hash, x, y, gradients) {
    const idx = (hash & 255) << 1;
    return gradients[idx] * x + gradients[idx + 1] * y;
  }

  function makeNoise2D(seed) {
    const { perm, gradients } = buildTables(seed >>> 0);

    function noise2D(x, y) {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;

      const xf = x - Math.floor(x);
      const yf = y - Math.floor(y);

      const u = fade(xf);
      const v = fade(yf);

      const aa = perm[X] + Y;
      const ab = aa + 1;
      const ba = perm[X + 1] + Y;
      const bb = ba + 1;

      const gradAA = grad(perm[aa], xf, yf, gradients);
      const gradBA = grad(perm[ba], xf - 1, yf, gradients);
      const gradAB = grad(perm[ab], xf, yf - 1, gradients);
      const gradBB = grad(perm[bb], xf - 1, yf - 1, gradients);

      const x1 = lerp(gradAA, gradBA, u);
      const x2 = lerp(gradAB, gradBB, u);
      return lerp(x1, x2, v);
    }

    function fbm2D(x, y, scale, octaves, lacunarity, gain) {
      let frequency = scale;
      let amplitude = 1;
      let sum = 0;
      let norm = 0;
      for (let i = 0; i < octaves; i++) {
        sum += amplitude * noise2D(x * frequency, y * frequency);
        norm += amplitude;
        frequency *= lacunarity;
        amplitude *= gain;
      }
      if (norm === 0) return 0;
      return sum / norm;
    }

    return { noise2D, fbm2D };
  }

  const api = { mulberry32, makeNoise2D };
  if (global && typeof global === 'object') {
    global.AIV_NOISE = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
