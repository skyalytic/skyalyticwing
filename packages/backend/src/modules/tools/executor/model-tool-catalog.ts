/**
 * Presentation-only reductions for the model's tool menu. The registry keeps
 * every definition so saved calls, user tool settings and explicit execution
 * continue to work. Apply this AFTER permissions and agent allowlists.
 */
export const MODEL_TOOL_REDUNDANCIES: Readonly<Record<string, {
  replacement: string;
  replacementArguments?: Readonly<Record<string, string>>;
  reason: string;
}>> = {
  computer_use: { replacement: 'node_repl', reason: 'The installed Computer Use guide uses the persistent sky API; old saved calls remain compatible.' },
  desktop: { replacement: 'computer_use', reason: 'The visual desktop workflow owns interactive desktop operation; legacy registry calls remain available explicitly.' },
  desktop_windows: { replacement: 'computer_use', reason: 'Window inventory and focus are already in the visual workflow; unbound legacy input is rejected.' },
  desktop_screenshot: { replacement: 'computer_use', reason: 'The visual workflow delivers fresh image pixels and coordinate metadata.' },
  uia_diagnostics: { replacement: 'computer_use', reason: 'The default screenshot workflow does not use the legacy UIA bridge.' },
  image_generate: {
    replacement: 'generate_image',
    reason: 'The full image tool accepts every simple image-generation input and adds editing, provider selection and count.',
  },
  subagent_status: {
    replacement: 'subagents',
    replacementArguments: { action: 'status' },
    reason: 'Both status paths call AgentSwarmService.getAgentStatus(agentId) and return the same record.',
  },
};

export function filterModelToolCatalog<T extends { name: string }>(tools: readonly T[]): T[] {
  const available = new Set(tools.map(tool => tool.name));
  return tools.filter(tool => {
    if (available.has('node_repl') && ['desktop', 'desktop_windows', 'desktop_screenshot', 'uia_diagnostics'].includes(tool.name)) return false;
    const redundant = MODEL_TOOL_REDUNDANCIES[tool.name];
    return !redundant || !available.has(redundant.replacement);
  });
}

/** Name repair only: never translate arguments or redirect a registered call. */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  bash: 'bash',
  shell: 'bash',
  exec: 'bash',
  terminal: 'bash',
  cmd: 'bash',
  read: 'file-read',
  readfile: 'file-read',
  cat: 'file-read',
  file_read: 'file-read',
  write: 'file-write',
  writefile: 'file-write',
  save: 'file-write',
  file_write: 'file-write',
  edit: 'file-edit',
  modify: 'file-edit',
  file_edit: 'file-edit',
  file_delete: 'file-delete',
  generate: 'doc_generate',
  gendoc: 'doc_generate',
  create_doc: 'doc_generate',
  export_doc: 'doc_generate',
  list: 'directory-list',
  ls: 'directory-list',
  dir: 'directory-list',
  file_list: 'directory-list',
  directory_list: 'directory-list',
  search: 'grep',
  find: 'glob',
  grep: 'grep',
  glob: 'glob',
  web: 'web-fetch',
  fetch: 'web-fetch',
  url: 'web-fetch',
  web_fetch: 'web-fetch',
  todo: 'todo',
  todos: 'todo',
  task: 'todo',
  todo_write: 'todo',
};

/** Resolve only against tools the caller has already authorized/exposed. */
export function resolveModelToolName(name: string, tools: readonly { name: string }[]): string {
  const exact = tools.find(tool => tool.name === name);
  if (exact) return exact.name;
  const lower = name.toLowerCase();
  const caseMatch = tools.find(tool => tool.name.toLowerCase() === lower);
  if (caseMatch) return caseMatch.name;
  const alias = TOOL_NAME_ALIASES[lower];
  return alias && tools.some(tool => tool.name === alias) ? alias : name;
}
