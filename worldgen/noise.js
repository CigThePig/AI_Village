const TAU = Math.PI * 2;

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function buildPermutation(rng) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    p[i] = i;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
  }
  return perm;
}

const gradients2D = new Float32Array(16);
for (let i = 0; i < 8; i++) {
  const angle = TAU * i / 8;
  gradients2D[i * 2] = Math.cos(angle);
  gradients2D[i * 2 + 1] = Math.sin(angle);
}

function grad(hash, x, y) {
  const h = hash & 7;
  const gx = gradients2D[h * 2];
  const gy = gradients2D[h * 2 + 1];
  return gx * x + gy * y;
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + t * (b - a);
}

export function makeNoise2D(seed) {
  const rng = mulberry32(seed >>> 0);
  const perm = buildPermutation(rng);

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

    const gradAA = grad(perm[aa], xf, yf);
    const gradBA = grad(perm[ba], xf - 1, yf);
    const gradAB = grad(perm[ab], xf, yf - 1);
    const gradBB = grad(perm[bb], xf - 1, yf - 1);

    const x1 = lerp(gradAA, gradBA, u);
    const x2 = lerp(gradAB, gradBB, u);
    return lerp(x1, x2, v);
  }

  function fbm2D(x, y, scale, octaves, lacunarity, gain) {
    let amplitude = 1;
    let frequency = scale;
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

export { mulberry32 };
