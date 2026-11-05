import { BadRequestException } from '@nestjs/common';
import { isRedactableKey } from './redact.interceptor.js';

const isMask = (v: unknown): v is string => typeof v === 'string' && /^(?:\*+|•+|\[REDACTED\]|\*+REDACTED\*+)$/i.test(v.trim());
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A GET/save roundtrip must never replace a real credential with its display mask. */
export function restoreRedactedConfig(incoming: unknown, current: unknown, parentKey?: string): unknown {
  if (Array.isArray(incoming)) return incoming.map(value => {
    // Never pair credentials by array index: entries can be reordered or deleted.
    const identity = object(value) ? ['id', 'name'].find(k => typeof value[k] === 'string' && value[k]) : undefined;
    const matches = identity && Array.isArray(current) ? current.filter(old => object(old) && old[identity] === value[identity]) : [];
    return restoreRedactedConfig(value, matches.length === 1 ? matches[0] : undefined, parentKey);
  });
  if (!object(incoming)) return incoming;
  return Object.fromEntries(Object.entries(incoming).map(([key, value]) => {
    const previous = object(current) ? current[key] : undefined;
    if (isRedactableKey(key, parentKey) && isMask(value)) {
      if (typeof previous !== 'string' || !previous || isMask(previous))
        throw new BadRequestException('无法保存脱敏占位符，请重新填写对应凭据');
      return [key, previous];
    }
    return [key, restoreRedactedConfig(value, previous, key)];
  }));
}
