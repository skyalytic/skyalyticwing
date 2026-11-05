import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultDataDir } from './web-data.util.js';

/** Local-at-rest encryption. The key remains in the private user data directory, never in a bundle. */
function key(create: boolean): Buffer {
  const root=getDefaultDataDir(), path=join(root,'local-secrets.key');
  if(!existsSync(path)&&create){mkdirSync(root,{recursive:true});try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(!existsSync(path))throw e;}}
  const value=readFileSync(path);if(value.length!==32)throw new Error('本地凭据密钥无效');return value;
}
export function sealSecret(value: unknown, context: string): string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(true),iv);
  cipher.setAAD(Buffer.from(context));const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),body.toString('base64')].join('.');
}
export function openSecret<T>(value: string, context: string): T {
  const parts=value.split('.');if(parts.length!==4||parts[0]!=='v1')throw new Error('本地凭据格式无效');
  const decipher=createDecipheriv('aes-256-gcm',key(false),Buffer.from(parts[1]!,'base64'));
  decipher.setAAD(Buffer.from(context));decipher.setAuthTag(Buffer.from(parts[2]!,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3]!,'base64')),decipher.final()]).toString('utf8')) as T;
}
