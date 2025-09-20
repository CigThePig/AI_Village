const GLOBAL_SCOPE = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);

function hasWorldgenDependencies() {
  return Boolean(
    GLOBAL_SCOPE &&
    GLOBAL_SCOPE.AIV_TERRAIN &&
    GLOBAL_SCOPE.AIV_CONFIG &&
    typeof GLOBAL_SCOPE.AIV_TERRAIN.generateTerrain === 'function' &&
    typeof GLOBAL_SCOPE.AIV_TERRAIN.makeHillshade === 'function'
  );
}

function waitForDocumentReady() {
  if (typeof document === 'undefined') {
    return Promise.resolve();
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });
}

async function waitForDependencies() {
  await waitForDocumentReady();
  if (hasWorldgenDependencies()) {
    return;
  }
  const POLL_INTERVAL_MS = 10;
  const MAX_ATTEMPTS = 300;
  await new Promise((resolve, reject) => {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (hasWorldgenDependencies()) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(interval);
        reject(new Error('AI Village terrain dependencies failed to load before timeout.'));
      }
    }, POLL_INTERVAL_MS);
  });
}

(async function bootstrap() {
  try {
    await waitForDependencies();
    if (!hasWorldgenDependencies()) {
      throw new Error('AI Village terrain dependencies became unavailable after waiting.');
    }
    const module = await import('./app.js');
    if (module && typeof module.bootGame === 'function') {
      module.bootGame();
    }
  } catch (err) {
    console.error('AI Village failed to start', err);
    if (GLOBAL_SCOPE && typeof GLOBAL_SCOPE.reportFatal === 'function') {
      try {
        GLOBAL_SCOPE.reportFatal(err);
      } catch (reportErr) {
        console.error('AI Village fallback fatal reporter failed', reportErr);
      }
    }
  }
})();
