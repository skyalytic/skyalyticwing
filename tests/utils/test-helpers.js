export const TEST_CONFIG = {
    port: 19876,
    host: '127.0.0.1',
    auth: { mode: 'none' },
    timeout: 10000,
};
export function getTestUrl(path) {
    return `http://${TEST_CONFIG.host}:${TEST_CONFIG.port}${path}`;
}
export async function waitForServer(maxRetries = 10, delay = 500) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await fetch(getTestUrl('/api/health'), { signal: AbortSignal.timeout(2000) });
            if (res.ok)
                return true;
        }
        catch { /* retry */ }
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
}
//# sourceMappingURL=test-helpers.js.map