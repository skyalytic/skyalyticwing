import { execSync } from 'child_process';
async function main() {
    console.log('Running tests...');
    execSync('vitest run', {
        stdio: 'inherit',
    });
    console.log('Tests complete!');
}
main().catch(console.error);
//# sourceMappingURL=test.js.map