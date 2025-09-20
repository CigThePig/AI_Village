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
  await new Promise((resolve) => {
    const maxAttempts = 300;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (hasWorldgenDependencies() || attempts >= maxAttempts) {
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

(async function bootstrap() {
  try {
    await waitForDependencies();
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
