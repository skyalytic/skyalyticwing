/** Numeric model usage/budget fields are measurements, not authentication tokens. */
const TOKEN_METRICS = new Set([
  'tokens',
  'prompttokens',
  'completiontokens',
  'totaltokens',
  'inputtokens',
  'outputtokens',
  'cachedtokens',
  'cachecreationinputtokens',
  'cachereadinputtokens',
  'reasoningtokens',
  'maxtokens',
  'maxcompletiontokens',
  'maxoutputtokens',
  'maxtotaltokens',
  'maxcontexttokens',
  'maxinputtokens',
  'contextwindowtokens',
  'reservedtokens',
  'estimatedtokens',
  'mintokens',
  'inputyuanpertoken',
  'outputyuanpertoken',
  'contexttokens',
  'tokenbudget',
  'tokenlimit',
  'tokensbefore',
  'tokensafter',
]);

export function isTokenMetric(key: string, value: unknown): boolean {
  return (
    ((typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
      // MySQL BIGINT/DECIMAL values remain strings to preserve precision.
      (typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) &&
    TOKEN_METRICS.has(key.toLowerCase().replace(/[_-]/g, ''))
  );
}
