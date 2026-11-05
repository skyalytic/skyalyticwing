const { releaseConfig, assertPublish } = require('./release-config.cjs');
try {
  assertPublish(process.argv[2] || releaseConfig().version);
  console.log('Release policy allows publishing this exact application version.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
