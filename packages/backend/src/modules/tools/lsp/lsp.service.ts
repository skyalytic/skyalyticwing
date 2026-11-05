import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import * as ts from 'typescript';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { ConfigService } from '../../core/config/config.service.js';
import { withFileMutation, recordFileCheckpoint } from '../files/checkpoint-store.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';
import { LspClient } from './lsp-client.js';

export interface LspDiagnostic {
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source?: string;
  file?: string;
  code?: number | string;
}
export interface DiagnosticsResult {
  language: string;
  file: string;
  diagnostics: LspDiagnostic[];
  serverAvailable: boolean;
  error?: string;
  pending?: boolean;
}
export interface LspServerInfo {
  language: string;
  command: string;
  args: string[];
  initialized: boolean;
  running: boolean;
  error?: string;
}
export type LanguageAction =
  | 'diagnostics'
  | 'projectDiagnostics'
  | 'definition'
  | 'references'
  | 'implementation'
  | 'hover'
  | 'symbols'
  | 'workspaceSymbols'
  | 'completion'
  | 'signature'
  | 'rename'
  | 'format'
  | 'codeActions'
  | 'organizeImports';
export interface LanguageQuery {
  action: LanguageAction;
  file: string;
  root?: string;
  line?: number;
  col?: number;
  newName?: string;
  query?: string;
  text?: string;
}
type Server = { command: string; args: string[] };
type TextEdit = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
};
type EditPreview = {
  id: string;
  owner: string;
  root: string;
  files: Array<{ file: string; beforeHash: string; before: string; after: string }>;
};
const languages: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.java': 'java',
};
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const contained = (root: string, file: string) => {
  const r = relative(root, file);
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
const position = (text: string, offset: number) => {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
};
const offset = (text: string, pos: { line: number; character: number }) => {
  const lines = text.split('\n');
  if (
    !Number.isInteger(pos.line) ||
    !Number.isInteger(pos.character) ||
    pos.line < 0 ||
    pos.line >= lines.length ||
    pos.character < 0 ||
    pos.character > lines[pos.line]!.replace(/\r$/, '').length
  )
    throw new Error('Invalid source position');
  return lines.slice(0, pos.line).reduce((n, line) => n + line.length + 1, 0) + pos.character;
};

@Injectable()
export class LspService implements OnModuleDestroy {
  private projects = new Map<
    string,
    {
      service: ts.LanguageService;
      files: string[];
      options: ts.CompilerOptions;
      version: number;
      overlays: Map<string, string>;
    }
  >();
  private clients = new Map<
    string,
    {
      client: LspClient;
      ready: Promise<void>;
      documents: Map<string, { text: string; version: number }>;
    }
  >();
  private failures = new Map<string, string>();
  private previews = new Map<string, EditPreview>();
  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly policy?: LocalResourcePolicy,
  ) {}
  private servers(): Record<string, Server> {
    const defaults: Record<string, Server> = {
      python: { command: 'pylsp', args: [] },
      go: { command: 'gopls', args: [] },
      rust: { command: 'rust-analyzer', args: [] },
      c: { command: 'clangd', args: [] },
      cpp: { command: 'clangd', args: [] },
      java: { command: 'jdtls', args: [] },
    };
    const custom =
      (this.config?.getAll()['lsp'] as { servers?: Record<string, Server> } | undefined)?.servers ??
      {};
    for (const [language, value] of Object.entries(custom))
      if (
        value &&
        typeof value.command === 'string' &&
        Array.isArray(value.args) &&
        value.args.every((a) => typeof a === 'string')
      )
        defaults[language] = value;
    return defaults;
  }
  private file(path: string, mode: 'read' | 'write' = 'read'): string {
    const absolute = realpathSync(resolve(path));
    if (!this.security.isPathAllowed(absolute, mode))
      throw new Error(`Path not allowed: ${absolute}`);
    return absolute;
  }
  private workspace(file: string, requested?: string): string {
    if (requested) {
      const root = this.file(requested);
      if (!statSync(root).isDirectory() || !contained(root, file))
        throw new Error('File must belong to the requested workspace');
      return root;
    }
    let current = dirname(file);
    while (this.security.isPathAllowed(current)) {
      if (
        ['tsconfig.json', 'jsconfig.json', '.git', 'pyproject.toml', 'go.mod', 'Cargo.toml'].some(
          (name) => existsSync(join(current, name)),
        )
      )
        return this.file(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return dirname(file);
  }
  private project(root: string, file: string) {
    const configFile = ['tsconfig.json', 'jsconfig.json']
      .map((name) => join(root, name))
      .find(existsSync);
    const raw = configFile
      ? ts.readConfigFile(configFile, ts.sys.readFile)
      : {
          config: {
            compilerOptions: {
              allowJs: true,
              checkJs: true,
              strict: true,
              target: 'ESNext',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              noEmit: true,
              skipLibCheck: true,
            },
          },
          error: undefined,
        };
    if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root, undefined, configFile);
    const errors = parsed.errors.filter((e) => e.code !== 18003);
    if (errors.length)
      throw new Error(
        errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'),
      );
    const options = { ...parsed.options, noEmit: true };
    let project = this.projects.get(root);
    if (project && JSON.stringify(project.options) !== JSON.stringify(options)) {
      project.service.dispose();
      this.projects.delete(root);
      project = undefined;
    }
    if (!project) {
      const created = {
        files: [] as string[],
        options,
        version: 0,
        overlays: new Map<string, string>(),
        service: undefined as unknown as ts.LanguageService,
      };
      const libRoot = dirname(require.resolve('typescript/lib/lib.d.ts'));
      const readable = (name: string) => {
        try {
          const path = realpathSync(name);
          return contained(libRoot, path) || this.security.isPathAllowed(path);
        } catch {
          return false;
        }
      };
      created.service = ts.createLanguageService(
        {
          getScriptFileNames: () => created.files,
          getScriptVersion: (name) =>
            created.overlays.has(name)
              ? digest(created.overlays.get(name)!)
              : readable(name)
                ? digest(readFileSync(name, 'utf8'))
                : '',
          getProjectVersion: () => String(created.version),
          getScriptSnapshot: (name) => {
            if (!readable(name)) return undefined;
            return ts.ScriptSnapshot.fromString(
              created.overlays.get(name) ?? readFileSync(name, 'utf8'),
            );
          },
          getCurrentDirectory: () => root,
          getCompilationSettings: () => created.options,
          getDefaultLibFileName: ts.getDefaultLibFilePath,
          fileExists: (name) => readable(name) && ts.sys.fileExists(name),
          readFile: (name) => (readable(name) ? ts.sys.readFile(name) : undefined),
          readDirectory: (...args) => ts.sys.readDirectory(...args).filter(readable),
          directoryExists: ts.sys.directoryExists,
          getDirectories: ts.sys.getDirectories,
          useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        },
        ts.createDocumentRegistry(),
      );
      project = created;
      this.projects.set(root, project);
    }
    project.files = Array.from(new Set([...parsed.fileNames, file])).filter((name) =>
      this.security.isPathAllowed(name),
    );
    project.version++;
    return project;
  }
  private location(file: string, span: ts.TextSpan, overlays?: Map<string, string>) {
    const path = this.file(file),
      content = overlays?.get(path) ?? readFileSync(path, 'utf8');
    return {
      uri: pathToFileURL(path).href,
      file: path,
      range: {
        start: position(content, span.start),
        end: position(content, span.start + span.length),
      },
    };
  }
  async query(input: LanguageQuery, signal?: AbortSignal, owner = ''): Promise<any> {
    if (signal?.aborted) throw new Error('Language request cancelled');
    if (!input || typeof input.file !== 'string') throw new Error('file required');
    owner = (this.policy?.credentialIdentity() ?? 'local') + '\0' + owner;
    const file = this.file(input.file),
      root = this.workspace(file, input.root);
    if (
      ['rename', 'format', 'codeActions', 'organizeImports'].includes(input.action) &&
      input.text !== undefined &&
      input.text !== readFileSync(file, 'utf8')
    )
      throw new Error('Save the buffer before preparing disk edits');
    const language = languages[extname(file).toLowerCase()];
    if (!language) throw new Error(`Unsupported language: ${extname(file)}`);
    if (!['typescript', 'javascript'].includes(language))
      return this.external({ ...input, file, root }, language, signal, owner);
    let projectRoot = dirname(file);
    while (
      projectRoot !== root &&
      contained(root, projectRoot) &&
      !['tsconfig.json', 'jsconfig.json'].some((n) => existsSync(join(projectRoot, n)))
    )
      projectRoot = dirname(projectRoot);
    const project = this.project(projectRoot, file);
    project.overlays.clear();
    if (input.text !== undefined) project.overlays.set(file, input.text);
    else project.overlays.delete(file);
    const text = project.overlays.get(file) ?? readFileSync(file, 'utf8');
    const service = project.service;
    const pos = offset(text, { line: (input.line ?? 1) - 1, character: (input.col ?? 1) - 1 });
    const location = (entry: ts.DocumentSpan) =>
      this.location(entry.fileName, entry.textSpan, project.overlays);
    switch (input.action) {
      case 'diagnostics':
      case 'projectDiagnostics': {
        const files = input.action === 'diagnostics' ? [file] : project.files;
        const all: LspDiagnostic[] = [];
        for (const name of files)
          for (const d of [
            ...service.getSyntacticDiagnostics(name),
            ...service.getSemanticDiagnostics(name),
          ]) {
            const at = d.file?.getLineAndCharacterOfPosition(d.start ?? 0) ?? {
              line: 0,
              character: 0,
            };
            all.push({
              file: name,
              line: at.line + 1,
              col: at.character + 1,
              code: d.code,
              source: 'typescript',
              severity:
                d.category === ts.DiagnosticCategory.Error
                  ? 'error'
                  : d.category === ts.DiagnosticCategory.Warning
                    ? 'warning'
                    : d.category === ts.DiagnosticCategory.Suggestion
                      ? 'hint'
                      : 'information',
              message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
            });
          }
        return { language, file, diagnostics: all, serverAvailable: true };
      }
      case 'definition':
        return (service.getDefinitionAtPosition(file, pos) ?? []).map(location);
      case 'implementation':
        return (service.getImplementationAtPosition(file, pos) ?? []).map(location);
      case 'references':
        return (service.getReferencesAtPosition(file, pos) ?? []).map(location);
      case 'hover': {
        const value = service.getQuickInfoAtPosition(file, pos);
        return value
          ? {
              ...this.location(file, value.textSpan, project.overlays),
              contents: ts.displayPartsToString(value.displayParts),
              documentation: ts.displayPartsToString(value.documentation),
            }
          : null;
      }
      case 'completion':
        return service.getCompletionsAtPosition(file, pos, {
          includeCompletionsForModuleExports: true,
          includeCompletionsWithInsertText: true,
        });
      case 'signature':
        return service.getSignatureHelpItems(file, pos, undefined);
      case 'symbols':
        return service.getNavigationTree(file);
      case 'workspaceSymbols':
        return service
          .getNavigateToItems(input.query ?? '')
          .map((item) => ({ name: item.name, kind: item.kind, ...location(item) }));
      case 'rename': {
        const scanner = ts.createScanner(
          ts.ScriptTarget.Latest,
          false,
          ts.LanguageVariant.Standard,
          input.newName ?? '',
        );
        if (
          !input.newName ||
          scanner.scan() !== ts.SyntaxKind.Identifier ||
          scanner.scan() !== ts.SyntaxKind.EndOfFileToken
        )
          throw new Error('Valid non-keyword newName required');
        const info = service.getRenameInfo(file, pos, { allowRenameOfImportPath: false });
        if (info.canRename === false) throw new Error(info.localizedErrorMessage);
        const changes: Record<string, TextEdit[]> = {};
        for (const item of service.findRenameLocations(file, pos, false, false, true) ?? []) {
          const loc = location(item);
          (changes[loc.uri] ??= []).push({
            range: loc.range,
            newText: (item.prefixText ?? '') + input.newName + (item.suffixText ?? ''),
          });
        }
        return this.preview(root, changes, owner);
      }
      case 'codeActions': {
        const diagnostics = [
          ...service.getSyntacticDiagnostics(file),
          ...service.getSemanticDiagnostics(file),
        ].filter(
          (d) => d.start !== undefined && pos >= d.start && pos <= d.start + (d.length ?? 0),
        );
        return diagnostics
          .flatMap((d) =>
            service.getCodeFixesAtPosition(
              file,
              d.start!,
              d.start! + (d.length ?? 0),
              [d.code],
              {},
              {},
            ),
          )
          .map((fix) => ({
            title: fix.description,
            preview: this.preview(root, this.tsEdits(fix.changes), owner),
          }));
      }
      case 'organizeImports':
        return this.preview(
          root,
          this.tsEdits(service.organizeImports({ type: 'file', fileName: file }, {}, {})),
          owner,
        );
      case 'format': {
        const edits = service.getFormattingEditsForDocument(file, {
          indentSize: 2,
          tabSize: 2,
          convertTabsToSpaces: true,
          newLineCharacter: '\n',
        });
        return this.preview(
          root,
          {
            [pathToFileURL(file).href]: edits.map((edit) => ({
              range: {
                start: position(text, edit.span.start),
                end: position(text, edit.span.start + edit.span.length),
              },
              newText: edit.newText,
            })),
          },
          owner,
        );
      }
      default:
        throw new Error('Unsupported language operation');
    }
  }
  private tsEdits(changes: readonly ts.FileTextChanges[]) {
    const edits: Record<string, TextEdit[]> = {};
    for (const change of changes) {
      if (change.isNewFile) throw new Error('Creating files requires explicit file tools');
      const file = this.file(change.fileName),
        text = readFileSync(file, 'utf8');
      edits[pathToFileURL(file).href] = change.textChanges.map((e) => ({
        range: {
          start: position(text, e.span.start),
          end: position(text, e.span.start + e.span.length),
        },
        newText: e.newText,
      }));
    }
    return edits;
  }
  private async external(
    input: LanguageQuery & { root: string },
    language: string,
    signal?: AbortSignal,
    owner = '',
  ): Promise<any> {
    const config = this.servers()[language];
    if (!config) throw new Error(`No language server configured for ${language}`);
    // Unsaved documents and server state belong to the requesting identity/session.
    const key = JSON.stringify([owner, input.root, language, config]);
    let state = this.clients.get(key);
    if (!state?.client.alive) {
      const client = new LspClient(
        config.command,
        config.args,
        pathToFileURL(input.root).href,
        input.root,
      );
      state = { client, ready: client.initialize(signal), documents: new Map() };
      this.clients.set(key, state);
    }
    try {
      await state.ready;
    } catch (error) {
      this.logger.warn(`Language server unavailable: ${language}`);
      this.failures.set(language, (error as Error).message);
      await state.client.close();
      this.clients.delete(key);
      throw new Error(
        `${language} language server unavailable. Install/configure ${config.command}: ${(error as Error).message}`,
      );
    }
    this.failures.delete(language);
    const { client, documents } = state;
    const uri = pathToFileURL(input.file).href,
      text = input.text ?? readFileSync(input.file, 'utf8');
    const previous = documents.get(uri),
      version = (previous?.version ?? 0) + 1;
    if (!previous)
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: language, version, text },
      });
    else if (previous.text !== text) {
      client.diagnostics.delete(uri);
      client.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    documents.set(uri, { text, version });
    const params: Record<string, any> = {
      textDocument: { uri },
      position: { line: (input.line ?? 1) - 1, character: (input.col ?? 1) - 1 },
    };
    if (input.action === 'diagnostics') {
      const diagnostics = client.capabilities['diagnosticProvider']
        ? (await client.request('textDocument/diagnostic', { textDocument: { uri } }, signal))
            ?.items
        : client.diagnostics.get(uri);
      return {
        language,
        file: input.file,
        serverAvailable: true,
        pending: !diagnostics,
        diagnostics: (diagnostics ?? []).map((d: any) => ({
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          severity:
            ({ 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' } as any)[d.severity] ??
            'information',
          message: d.message,
          source: d.source,
          code: d.code,
        })),
      };
    }
    if (input.action === 'projectDiagnostics') {
      if (!client.capabilities['diagnosticProvider']?.workspaceDiagnostics)
        throw new Error(
          'This server does not advertise workspace diagnostics; query individual files',
        );
      return client.request('workspace/diagnostic', { previousResultIds: [] }, signal);
    }
    const methods: Record<string, string> = {
      definition: 'textDocument/definition',
      implementation: 'textDocument/implementation',
      references: 'textDocument/references',
      hover: 'textDocument/hover',
      symbols: 'textDocument/documentSymbol',
      workspaceSymbols: 'workspace/symbol',
      completion: 'textDocument/completion',
      signature: 'textDocument/signatureHelp',
      rename: 'textDocument/rename',
      format: 'textDocument/formatting',
    };
    if (input.action === 'codeActions' || input.action === 'organizeImports') {
      const at = params['position'];
      const actions = await client.request(
        'textDocument/codeAction',
        {
          textDocument: { uri },
          range: { start: at, end: at },
          context: {
            diagnostics: client.diagnostics.get(uri) ?? [],
            ...(input.action === 'organizeImports' ? { only: ['source.organizeImports'] } : {}),
          },
        },
        signal,
      );
      return (actions ?? []).map((action: any) => ({
        title: action.title,
        ...(action.edit
          ? { preview: this.preview(input.root, this.workspaceEdits(action.edit), owner) }
          : { requiresServerCommand: true, command: action.command }),
      }));
    }
    const method = methods[input.action];
    if (!method) throw new Error('Unsupported language operation');
    if (input.action === 'references') params['context'] = { includeDeclaration: true };
    if (input.action === 'rename') {
      if (!input.newName) throw new Error('newName required');
      params['newName'] = input.newName;
    }
    if (input.action === 'workspaceSymbols') params['query'] = input.query ?? '';
    if (input.action === 'format') params['options'] = { tabSize: 2, insertSpaces: true };
    const result = await client.request(method, params, signal);
    if (input.action === 'format') return this.preview(input.root, { [uri]: result ?? [] }, owner);
    if (input.action === 'rename') {
      const changes = { ...result?.changes };
      for (const change of result?.documentChanges ?? []) {
        if (!change.textDocument || !Array.isArray(change.edits))
          throw new Error('Resource creation/rename/delete requires explicit file tools');
        changes[change.textDocument.uri] = change.edits;
      }
      return this.preview(input.root, changes, owner);
    }
    return result;
  }
  private workspaceEdits(edit: any): Record<string, TextEdit[]> {
    const changes = { ...edit?.changes };
    for (const change of edit?.documentChanges ?? []) {
      if (!change.textDocument || !Array.isArray(change.edits))
        throw new Error('Resource operations require explicit file tools');
      changes[change.textDocument.uri] = change.edits;
    }
    return changes;
  }
  private preview(
    root: string,
    changes: Record<string, TextEdit[]>,
    owner: string,
  ): Omit<EditPreview, 'owner'> {
    const preview: EditPreview = { id: randomUUID(), owner, root, files: [] };
    for (const [uri, edits] of Object.entries(changes)) {
      const file = this.file(fileURLToPath(uri), 'write');
      if (!contained(root, file)) throw new Error('Language edit escapes the workspace');
      const before = readFileSync(file, 'utf8');
      let after = before,
        end = before.length;
      const spans = edits
        .map((e) => ({
          start: offset(before, e.range.start),
          end: offset(before, e.range.end),
          text: e.newText,
        }))
        .sort((a, b) => b.start - a.start);
      for (const span of spans) {
        if (span.end > end || span.start > span.end) throw new Error('Overlapping language edits');
        after = after.slice(0, span.start) + span.text + after.slice(span.end);
        end = span.start;
      }
      if (after !== before) preview.files.push({ file, beforeHash: digest(before), before, after });
    }
    this.previews.set(preview.id, preview);
    if (!owner.endsWith('\0')) writeJsonAtomicSync(this.previewPath(preview.id), preview);
    const { owner: _owner, ...publicPreview } = preview;
    return structuredClone(publicPreview);
  }
  private previewPath(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid edit preview ID');
    return join(
      getDefaultDataDir(),
      'language-previews',
      digest(this.policy?.credentialIdentity() ?? 'local'),
      id + '.json',
    );
  }
  async apply(id: string, sessionId: string): Promise<{ files: string[] }> {
    const preview =
      this.previews.get(id) ?? readJsonRecover<EditPreview | null>(this.previewPath(id), null);
    if (!preview) throw new Error('Edit preview expired; request a new preview');
    if (
      !sessionId ||
      preview.owner !== (this.policy?.credentialIdentity() ?? 'local') + '\0' + sessionId
    )
      throw new Error('Edit preview belongs to another session');
    if (
      !Array.isArray(preview.files) ||
      preview.files.some(
        (f) =>
          typeof f.before !== 'string' ||
          typeof f.after !== 'string' ||
          digest(f.before) !== f.beforeHash ||
          !contained(preview.root, f.file),
      )
    )
      throw new Error('Invalid edit preview');
    const files = [...preview.files].sort((a, b) => a.file.localeCompare(b.file));
    const lock = async (index: number): Promise<{ files: string[] }> =>
      index < files.length ? withFileMutation(files[index]!.file, () => lock(index + 1)) : commit();
    const commit = async () => {
      for (const f of files)
        if (
          this.file(f.file, 'write') !== f.file ||
          !this.security.isPathAllowed(dirname(f.file), 'write') ||
          digest(readFileSync(f.file, 'utf8')) !== f.beforeHash
        )
          throw new Error(`File changed since preview: ${f.file}`);
      const written: typeof files = [];
      try {
        for (const f of files) {
          const tmp = join(dirname(f.file), `.wing-lsp-${randomUUID()}`);
          try {
            await writeFile(tmp, f.after, { flag: 'wx', mode: statSync(f.file).mode & 0o777 });
            recordFileCheckpoint(sessionId, f.file, f.before, f.after);
            await rename(tmp, f.file);
            written.push(f);
          } finally {
            await unlink(tmp).catch(() => {});
          }
        }
      } catch (error) {
        for (const f of written.reverse())
          if (digest(readFileSync(f.file, 'utf8')) === digest(f.after))
            await writeFile(f.file, f.before);
        throw error;
      }
      this.previews.delete(id);
      await unlink(this.previewPath(id)).catch(() => {});
      await unlink(this.previewPath(id) + '.bak').catch(() => {});
      return { files: files.map((f) => f.file) };
    };
    return lock(0);
  }
  async getDiagnostics(file: string): Promise<DiagnosticsResult> {
    try {
      return await this.query({ action: 'diagnostics', file });
    } catch (error) {
      return {
        file,
        language: languages[extname(file)] ?? '',
        diagnostics: [],
        serverAvailable: false,
        error: (error as Error).message,
      };
    }
  }
  listServers(): LspServerInfo[] {
    return [
      {
        language: 'typescript/javascript',
        command: 'bundled TypeScript language service',
        args: [],
        initialized: this.projects.size > 0,
        running: this.projects.size > 0,
      },
      ...Object.entries(this.servers()).map(([language, server]) => ({
        language,
        ...server,
        initialized: [...this.clients].some(
          ([key, s]) => key.includes(`"${language}"`) && s.client.alive,
        ),
        running: [...this.clients].some(
          ([key, s]) => key.includes(`"${language}"`) && s.client.alive,
        ),
        ...(this.failures.has(language) ? { error: this.failures.get(language)! } : {}),
      })),
    ];
  }
  async onModuleDestroy(): Promise<void> {
    for (const project of this.projects.values()) project.service.dispose();
    this.projects.clear();
    await Promise.all([...this.clients.values()].map((s) => s.client.close()));
    this.clients.clear();
    this.previews.clear();
  }
}
