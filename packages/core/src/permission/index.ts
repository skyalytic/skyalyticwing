export type PermissionMode = 'auto' | 'ask' | 'deny';

export interface PermissionRule {
  pattern: string;
  action: 'allow' | 'deny';
}

export interface PermissionContext {
  tool: string;
  input: Record<string, unknown>;
  agent: string;
  channel?: string;
}

export class PermissionEngine {
  private mode: PermissionMode;
  private rules: PermissionRule[];

  constructor(mode: PermissionMode = 'ask', rules: PermissionRule[] = []) {
    this.mode = mode;
    this.rules = rules;
  }

  check(context: PermissionContext): 'allow' | 'deny' | 'ask' {
    // Check rules first
    for (const rule of this.rules) {
      if (this.matchRule(rule.pattern, context)) {
        return rule.action;
      }
    }
    // Fall back to default mode
    // 'auto' 模式语义为自动放行（匹配白名单规则后未命中则允许），需映射为合法决策值
    if (this.mode === 'auto') return 'allow';
    return this.mode;
  }

  private matchRule(pattern: string, context: PermissionContext): boolean {
    const [toolPattern, actionPattern] = pattern.split(':');
    if (toolPattern !== '*' && toolPattern !== context.tool) return false;
    if (actionPattern && actionPattern !== '*') {
      if (!context.input) return false;
      const action = context.input['action'] as string | undefined;
      if (!action || actionPattern !== action) return false;
    }
    return true;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }
}
