import { parse } from 'yaml';

/** SKILL.md supports UTF-8 BOM, Windows line endings and YAML block scalars. */
export function parseSkillDocument(content: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) return { metadata: {}, body: normalized.trim() };
  const metadata: unknown = parse(match[1], { maxAliasCount: 0 });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('技能说明头部必须是 YAML 对象');
  }
  return { metadata: metadata as Record<string, unknown>, body: normalized.slice(match[0].length).trim() };
}
