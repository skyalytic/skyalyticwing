import { execFileSync } from 'node:child_process';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';

type ProxySettings = { server: string; bypass: string };
let cached: { until: number; settings: ProxySettings | null } | undefined;
const dispatchers = new Map<string, ProxyAgent>();
const agents = new Map<string, HttpsProxyAgent<string>>();
function windowsProxy(): ProxySettings | null {
  if (process.platform !== 'win32') return null;
  if (cached && cached.until > Date.now()) return cached.settings;
  let settings: ProxySettings | null = null;
  try {
    const text = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(text)) settings = {
      server: /ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(text)?.[1]?.trim() || '',
      bypass: /ProxyOverride\s+REG_SZ\s+([^\r\n]+)/.exec(text)?.[1]?.trim() || '' };
  } catch { /* No configured system proxy. */ }
  cached = { until: Date.now() + 10000, settings }; return settings;
}
export function selectChannelProxy(url: string, env: NodeJS.ProcessEnv, system: ProxySettings | null): string | undefined {
  const target = new URL(url), host = target.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return undefined;
  const configured = env['HTTPS_PROXY'] || env['https_proxy'] || env['HTTP_PROXY'] || env['http_proxy'];
  const bypass = (env['NO_PROXY'] || env['no_proxy'] || (configured ? '' : system?.bypass) || '').split(/[;,]/);
  for (const item of bypass) {
    const rule = item.trim().toLowerCase(); if (!rule) continue;
    if (rule === '*' || (rule === '<local>' && !host.includes('.'))) return undefined;
    const [name, port] = rule.split(':');
    if (port && port !== (target.port || '443')) continue;
    const domain = (name || '').replace(/^\*?\./, '');
    if (host === domain || host.endsWith('.' + domain)) return undefined;
  }
  let value = configured || system?.server || '';
  if (!configured && value.includes('=')) {
    const mappings = Object.fromEntries(value.split(';').map(item => item.trim().split('=')));
    value = mappings['https'] || mappings['http'] || '';
  }
  if (!value) return undefined;
  try { const proxy = new URL(value.includes('://') ? value : 'http://' + value);
    return ['http:', 'https:'].includes(proxy.protocol) ? proxy.href : undefined;
  } catch { return undefined; }
}
export function channelProxy(url: string): string | undefined { return selectChannelProxy(url, process.env, windowsProxy()); }
export function channelDispatcher(url: string): ProxyAgent | undefined {
  const proxy = channelProxy(url); if (!proxy) return undefined;
  let dispatcher = dispatchers.get(proxy);
  if (!dispatcher) { dispatcher = new ProxyAgent(proxy); dispatchers.set(proxy, dispatcher); }
  return dispatcher;
}
export function channelWebSocketAgent(url: string): HttpsProxyAgent<string> | undefined {
  const proxy = channelProxy(url); if (!proxy) return undefined;
  let agent = agents.get(proxy);
  if (!agent) { agent = new HttpsProxyAgent(proxy); agents.set(proxy, agent); }
  return agent;
}
