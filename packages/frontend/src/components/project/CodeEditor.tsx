import { shortcutText } from '@/utils/shortcuts';
import { uiFontSize } from '@/utils/typography';
import { useEffect, useRef, useState } from 'react';
import { basicSetup, minimalSetup } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { openSearchPanel, searchKeymap } from '@codemirror/search';
import { HighlightStyle, LanguageDescription, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { useWorkbenchLanguage, wt } from '@/i18n/workbench-text';
import './code-editor.css';
import '../chat/composer-picker.css';
import { attachContext } from '@/services/context-reference';

const chinesePhrases = {
  'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个',
  'all': '全部', 'match case': '区分大小写', 'by word': '全字匹配',
  'regexp': '正则表达式', 'replace': '替换', 'replace all': '全部替换',
  'close': '关闭', 'Go to line': '跳转到行', 'go': '跳转',
  'Selection deleted': '已删除选区', 'Fold line': '折叠行', 'Unfold line': '展开行',
  'to': '到', 'on line': '所在行', 'No diagnostics': '没有诊断信息',
};
function colorExtensions(dark: boolean) {
  return [EditorView.theme({
    '&': { height: '100%', color: 'var(--text-primary)', backgroundColor: 'var(--bg-primary)' },
    '.cm-scroller': { overflow: 'auto', fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: uiFontSize(13), lineHeight: '1.65' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--text-primary)' },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderRight: '1px solid var(--border)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: dark ? '#ffffff0c' : '#0969da09' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-primary)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: dark ? '#264f78' : '#cce3ff' },
    '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', borderColor: 'var(--border)' },
    '.cm-searchMatch': { backgroundColor: dark ? '#715c26' : '#ffdf80', outline: '1px solid #ae851a' },
    '.cm-searchMatch-selected': { backgroundColor: dark ? '#8b6620' : '#ffbc42' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: dark ? '#284c44' : '#c9eadb' },
  }, { dark }), syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: dark ? '#c792ea' : '#7c3aa0' },
    { tag: [tags.string, tags.special(tags.string)], color: dark ? '#a8dca2' : '#246b32' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: dark ? '#f7bb83' : '#a04a12' },
    { tag: [tags.comment, tags.meta], color: dark ? '#8b9ba8' : '#637381', fontStyle: 'italic' },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: dark ? '#82cfff' : '#0064a5' },
    { tag: [tags.typeName, tags.className, tags.namespace], color: dark ? '#6edac6' : '#007465' },
    { tag: [tags.propertyName, tags.attributeName], color: dark ? '#b4c9f2' : '#274e84' },
    { tag: [tags.heading], color: dark ? '#82cfff' : '#0064a5', fontWeight: 'bold' },
    { tag: [tags.link, tags.url], color: dark ? '#6edac6' : '#007465', textDecoration: 'underline' },
    { tag: tags.invalid, color: dark ? '#ff9090' : '#b42318' },
  ]))];
}

export function CodeEditor({ filePath, value, onChange, onSave, segmented = false, segmentOffset }: {
  filePath: string; value: string; onChange: (value: string) => void; onSave: () => void; segmented?: boolean; segmentOffset?: number;
}) {
  const locale = useWorkbenchLanguage();
  const modifier = shortcutText('Ctrl');
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const lastValue = useRef(value);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [languageName, setLanguageName] = useState('');
  const [wrap, setWrap] = useState(false);
  const [selection, setSelection] = useState<{left:number;top:number}|null>(null);
  const addSelection = (view:EditorView) => {
    const range=view.state.selection.main;if(range.empty)return false;
    const start=view.state.doc.lineAt(range.from).number,end=view.state.doc.lineAt(Math.max(range.from,range.to-1)).number;
    attachContext({kind:'selection',label:`${filePath.split(/[\\/]/).pop()} ${start}–${end}`,path:filePath,startLine:start,endLine:end,
      ...(segmented?{segmentOffset:segmentOffset??0}:{}),content:view.state.sliceDoc(range.from,range.to),instruction:'用户选中的文件内容快照；行号对应选择时的编辑状态，可能含未保存内容。修改前请重新核对来源。'});
    setSelection(null);return true;
  };
  const compartments = useRef({ color: new Compartment(), language: new Compartment(), locale: new Compartment(), wrap: new Compartment() });
  useEffect(() => {
    if (!host.current) return;
    const c = compartments.current;
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      value.length > 1024 * 1024 ? [minimalSetup, lineNumbers(), keymap.of(searchKeymap)] : basicSetup,
      EditorState.tabSize.of(4), indentUnit.of(filePath.endsWith('.py') ? '    ' : '  '),
      EditorState.lineSeparator.of(value.includes('\r\n') ? '\r\n' : '\n'),
      // Pasted LF text must be parsed using this document's CRLF separator;
      // otherwise CodeMirror keeps literal LF characters inside a single line.
      EditorView.clipboardInputFilter.of((text, state) => text.replace(/\r\n|\r|\n/g, state.lineBreak)),
      c.color.of(colorExtensions(document.documentElement.dataset['theme'] === 'dark')),
      c.language.of([]), c.locale.of([EditorState.phrases.of(locale.startsWith('zh') ? chinesePhrases : {}), EditorView.contentAttributes.of({ 'aria-label': wt('代码编辑器'), spellcheck: 'false' })]), c.wrap.of([]),
      Prec.highest(keymap.of([{ key: 'Mod-s', run: () => { callbacks.current.onSave(); return true; } }, {key:'Mod-u',run:addSelection}])), keymap.of([indentWithTab]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) { lastValue.current = update.state.sliceDoc(); callbacks.current.onChange(lastValue.current); }
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head, line = update.state.doc.lineAt(head);
          setPosition({ line: line.number, column: head - line.from + 1 });
          const selected=update.state.selection.main;
          if(selected.empty)setSelection(null);
          else requestAnimationFrame(()=>{
            if(viewRef.current!==update.view||!update.view.state.selection.main.eq(selected))return;
            const rect=host.current?.getBoundingClientRect(),point=update.view.coordsAtPos(selected.from);
            if(rect&&point)setSelection({left:Math.max(8,Math.min(point.left-rect.left,rect.width-220)),top:Math.max(40,Math.min(point.top-rect.top+34,rect.height-10))});
          });
        }
      }),
    ] }) });
    viewRef.current = view;
    const syncTheme = () => view.dispatch({ effects: c.color.reconfigure(colorExtensions(document.documentElement.dataset['theme'] === 'dark' || document.documentElement.classList.contains('dark'))) });
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    let active = true;
    const name = filePath.split(/[\\/]/).pop() || filePath;
    const language = LanguageDescription.matchFilename(languages, name);
    setLanguageName(language?.name || '');
    if (language && value.length <= 1024 * 1024) void language.load().then(support => { if (active) view.dispatch({ effects: c.language.reconfigure(support) }); }).catch(() => { if (active) setLanguageName(''); });
    return () => { active = false; observer.disconnect(); view.destroy(); viewRef.current = undefined; };
    // FilePreview keys each document by path. Keep undo history while saving and changing themes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);
  useEffect(() => {
    const view = viewRef.current;
    if (view && lastValue.current !== value) { lastValue.current = value; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }
  }, [value]);
  useEffect(() => { viewRef.current?.dispatch({ effects: compartments.current.locale.reconfigure([EditorState.phrases.of(locale.startsWith('zh') ? chinesePhrases : {}), EditorView.contentAttributes.of({ 'aria-label': wt('代码编辑器'), spellcheck: 'false' })]) }); }, [locale]);
  useEffect(() => { viewRef.current?.dispatch({ effects: compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) }); }, [wrap]);
  return <div className="sky-code-editor" style={{position:'relative'}}>
    <div className="sky-code-editor-tools">
      <span>{languageName || wt('纯文本')}</span>
      <button type="button" onClick={() => { if (viewRef.current) openSearchPanel(viewRef.current); }}>{wt('查找与替换')}</button>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap(v => !v)}>{wt('自动换行')}</button>
    </div>
    <div className="sky-code-editor-host" ref={host} />
    {selection&&<button type="button" className="wing-selection-action" style={selection} onMouseDown={e=>e.preventDefault()} onClick={()=>{if(viewRef.current)addSelection(viewRef.current);}}>{wt('添加到对话')} <kbd>{modifier}+U</kbd></button>}
    <div className="sky-code-editor-status"><span>{segmented && wt('当前分段 · ')}{wt('第 {{line}} 行，第 {{column}} 列', position)}</span><span>UTF-8 · {value.includes('\r\n') ? 'CRLF' : 'LF'}</span><span>{wt('停顿自动保存 · Ctrl/⌘ S 立即保存').replace('Ctrl/⌘ S', `${modifier}+S`)}</span></div>
  </div>;
}
