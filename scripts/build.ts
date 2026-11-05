import { build } from 'tsdown';

async function main() {
  console.log('Building all packages...');

  const packages = [
    'packages/shared',
    'packages/core',
    'packages/cli',
    'packages/sdk',
    'packages/channels',
    'packages/tools',
    'packages/providers',
    'packages/web',
  ];

  let failed = 0;
  for (const pkg of packages) {
    console.log(`Building ${pkg}...`);
    try {
      await build({ cwd: pkg });
      console.log(`✓ ${pkg} built successfully`);
    } catch (error) {
      console.error(`✗ Failed to build ${pkg}:`, error);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\nBuild completed with ${failed} failure(s)!`);
    process.exit(1);
  } else {
    console.log('Build complete!');
  }
}

main().catch(console.error);
