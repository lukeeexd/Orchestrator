import './index.css';

async function smokeTest(): Promise<void> {
  const pong = await window.api.ping();
  const settings = await window.api.getSettings();
  console.log('[orchestrator] ping →', pong);
  console.log('[orchestrator] settings →', settings);
}

smokeTest().catch((err) => console.error('[orchestrator] smoke-test failed', err));
