// Read-only bridge protocol check: no screenshots, clicks or keyboard events.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { UiaService } = require('../packages/backend/dist/modules/automation/uia.service.js');
(async () => {
  const service = new UiaService({});
  try {
    assert(service.isAvailable(), 'Windows bridge is missing');
    const result = await service.diagnostics();
    assert(result && typeof result === 'object');
    fs.mkdirSync('.test-runtime-data', { recursive: true });
    fs.writeFileSync('.test-runtime-data/desktop-diagnostics.json', JSON.stringify(result, null, 2));
    console.log('PASS Windows bridge diagnostics protocol exchange; no live desktop actions tested');
  } finally { service.onModuleDestroy(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
