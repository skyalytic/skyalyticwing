const {releaseConfig} = require('./release-config.cjs');
try {
  const {version,policy}=releaseConfig();
  if(policy.version!==version || policy.packagingAllowed!==true) throw Error(`Packaging blocked: Wing ${version} is local-only until user acceptance.`);
} catch(error) { console.error(error.message); process.exitCode=1; }
