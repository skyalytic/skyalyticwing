import { createOfficePreset, officeTemplates } from './office-presets.js';
import { createWorkfile } from './create-workfile.js';
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Post,
  Body,
  Query,
  Injectable,
} from '@nestjs/common';
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, extname, join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Element, type Document } from '@xmldom/xmldom';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { withFileMutation } from './checkpoint-store.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export interface OfficeField {
  id: string;
  value: string;
  row?: number;
  column?: number;
  formula?: boolean;
  readOnly?: boolean;
}
export interface OfficeSection {
  name: string;
  fields: OfficeField[];
}
export interface OfficeSnapshot {
  format: string;
  revision: string;
  sections: OfficeSection[];
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const elements = (root: Document | Element, ns: string, tag: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(ns, tag));
const invalidXmlText = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)));
const relationshipPart = (container: string, target: string) =>
  posix.normalize(
    target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(container), target),
  );
function parse(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new BadRequestException('不支持带外部实体的文档');
  return new DOMParser({
    onError: () => {
      throw new BadRequestException('文档 XML 无效');
    },
  }).parseFromString(text, 'application/xml');
}
@Injectable()
export class OfficeService {
  constructor(private readonly security: SecurityManagerService) {}
  /** Read-only content summary for comparing durable Office snapshots. */
  async historyText(buffer: Buffer, format: string): Promise<string> {
    if (buffer.length > 25 * 1024 * 1024 || !['docx', 'xlsx', 'pptx'].includes(format)) throw new BadRequestException('快照仅提供完整文件比较');
    const { sections } = await this.open(buffer, format);
    return sections.map(section => `[${section.name}]\n` + section.fields.map(f => format === 'xlsx' ? `${f.row},${f.column}: ${f.value}` : f.value).join('\n')).join('\n\n');
  }
  private check(raw: string, mode: 'read' | 'write') {
    if (typeof raw !== 'string' || !raw || raw.includes('\0'))
      throw new BadRequestException('文档路径无效');
    const path = resolve(raw);
    if (!['.docx', '.pptx', '.xlsx'].includes(extname(path).toLowerCase()))
      throw new BadRequestException('支持 docx、pptx、xlsx；旧格式请先转换');
    if (!this.security.isPathAllowed(path, mode))
      throw new BadRequestException('文档路径不在授权范围内');
    if (!statSync(path).isFile() || statSync(path).size > 25 * 1024 * 1024)
      throw new BadRequestException('文档超过 25 MB 或不是文件');
    return path;
  }
  async create(directory: string, name: string, format: string, template = 'blank') {
    const buffer = await createOfficePreset(format, template);
    return createWorkfile(directory, name, format, buffer, path => this.security.isPathAllowed(path, 'write'));
  }
  private async open(buffer: Buffer, format: string) {
    const zip = await JSZip.loadAsync(buffer).catch(() => {
      throw new BadRequestException('文档损坏或加密，无法打开');
    });
    const entries = Object.values(zip.files);
    const expanded = entries.reduce(
      (sum, entry) =>
        sum +
        ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ||
          0),
      0,
    );
    if (entries.length > 5000 || expanded > 100 * 1024 * 1024)
      throw new BadRequestException('压缩文档内容过大');
    const names = Object.keys(zip.files)
      .filter((name) =>
        format === 'docx'
          ? /^word\/(document|header\d+|footer\d+)\.xml$/.test(name)
          : format === 'pptx'
            ? /^ppt\/slides\/slide\d+\.xml$/.test(name)
            : /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
      )
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) throw new BadRequestException('未找到可编辑的文档内容');
    const labels = new Map<string, string>();
    const container =
      format === 'xlsx' ? 'xl/workbook.xml' : format === 'pptx' ? 'ppt/presentation.xml' : '';
    if (container && zip.file(container)) {
      const relPath = posix.join(
        posix.dirname(container),
        '_rels',
        posix.basename(container) + '.rels',
      );
      const rels = zip.file(relPath);
      if (rels) {
        const targets = new Map(
          elements(
            parse(await rels.async('string')),
            'http://schemas.openxmlformats.org/package/2006/relationships',
            'Relationship',
          )
            .filter((r) => r.getAttribute('TargetMode') !== 'External')
            .map((r) => [
              r.getAttribute('Id'),
              relationshipPart(container, r.getAttribute('Target') || ''),
            ]),
        );
        const metadata = parse(await zip.file(container)!.async('string'));
        const items = elements(
          metadata,
          format === 'xlsx' ? S : 'http://schemas.openxmlformats.org/presentationml/2006/main',
          format === 'xlsx' ? 'sheet' : 'sldId',
        );
        const ordered: string[] = [];
        for (const item of items) {
          const target = targets.get(
            item.getAttributeNS(
              'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
              'id',
            ),
          );
          if (target && names.includes(target)) {
            ordered.push(target);
            labels.set(target, item.getAttribute('name') || '幻灯片 ' + ordered.length);
          }
        }
        if (ordered.length === names.length) names.splice(0, names.length, ...ordered);
      }
    }
    const shared = zip.file('xl/sharedStrings.xml');
    const strings = shared
      ? elements(parse(await shared.async('string')), S, 'si').map((si) =>
          elements(si, S, 't')
            .map((t) => t.textContent)
            .join(''),
        )
      : [];
    const docs = new Map<string, Document>();
    const bindings = new Map<string, { node: Element; part: string }>();
    const sections: OfficeSection[] = [];
    let total = 0;
    for (const name of names) {
      const text = await zip.file(name)!.async('string');
      if (text.length > 10 * 1024 * 1024) throw new BadRequestException('单个文档页内容过大');
      const doc = parse(text);
      docs.set(name, doc);
      const nodes = elements(
        doc,
        format === 'docx' ? W : format === 'pptx' ? A : S,
        format === 'xlsx' ? 'c' : 't',
      );
      const fields = nodes.map((node, i): OfficeField => {
        const id = name + ':' + i;
        bindings.set(id, { node, part: name });
        if (format !== 'xlsx') return { id, value: node.textContent || '' };
        const f = elements(node, S, 'f')[0];
        const raw = elements(node, S, 'v')[0]?.textContent || '';
        const value = f
          ? '=' + f.textContent
          : node.getAttribute('t') === 's'
            ? strings[Number(raw)] || ''
            : node.getAttribute('t') === 'inlineStr'
              ? elements(node, S, 't')
                  .map((t) => t.textContent)
                  .join('')
              : raw;
        const address = /^([A-Z]+)(\d+)$/.exec(node.getAttribute('r') || '');
        const column = address
          ? [...address[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)
          : i + 1;
        return {
          id,
          value,
          row: address ? Number(address[2]) : 1,
          column,
          formula: !!f,
          readOnly: !!f && ['shared', 'array', 'dataTable'].includes(f.getAttribute('t') || ''),
        };
      });
      total += fields.length;
      if (total > 20000) throw new BadRequestException('内容过多，请在桌面办公软件中打开');
      // Array/shared formulas cover other cells too. Keep the whole sheet read-only
      // rather than rewriting only one member and damaging the formula group.
      if (fields.some((field) => field.readOnly)) for (const field of fields) field.readOnly = true;
      sections.push({
        name:
          labels.get(name) ||
          (format === 'docx'
            ? name.includes('document')
              ? '正文'
              : name.split('/').pop()!
            : (format === 'pptx' ? '幻灯片 ' : '工作表 ') + (sections.length + 1)),
        fields,
      });
    }
    return { zip, docs, bindings, sections };
  }
  async read(raw: string): Promise<OfficeSnapshot> {
    const path = this.check(raw, 'read'),
      data = readFileSync(path),
      format = extname(path).slice(1).toLowerCase();
    return { format, revision: digest(data), sections: (await this.open(data, format)).sections };
  }
  async save(raw: string, revision: string, changes: Array<{ id: string; value: string }>) {
    const path = this.check(raw, 'write');
    if (
      !/^[a-f0-9]{64}$/.test(revision || '') ||
      !Array.isArray(changes) ||
      changes.length > 20000 ||
      changes.some(
        (c) =>
          !c ||
          typeof c.id !== 'string' ||
          typeof c.value !== 'string' ||
          c.value.length > 100000 ||
          invalidXmlText(c.value),
      )
    )
      throw new BadRequestException('修改内容或版本无效');
    return withFileMutation(path, async () => {
      const before = readFileSync(path);
      if (digest(before) !== revision)
        throw new ConflictException('文档已被其他程序或 AI 修改；请保留修改并重新打开合并');
      const format = extname(path).slice(1).toLowerCase();
      const { zip, docs, bindings, sections } = await this.open(before, format);
      const readOnlyIds = new Set(
        sections.flatMap((s) => s.fields.filter((f) => f.readOnly).map((f) => f.id)),
      );
      const changed = new Set<string>();
      for (const change of changes) {
        if (readOnlyIds.has(change.id))
          throw new BadRequestException('此工作表包含共享或数组公式，请在 Excel / WPS 中编辑');
        const binding = bindings.get(change.id);
        if (!binding) throw new BadRequestException('找不到要修改的文档元素');
        const { node, part } = binding;
        changed.add(part);
        if (format !== 'xlsx') {
          node.textContent = change.value;
          node.setAttribute('xml:space', 'preserve');
          continue;
        }
        const doc = docs.get(part)!;
        while (node.firstChild) node.removeChild(node.firstChild);
        node.removeAttribute('t');
        if (change.value.startsWith('=')) {
          const f = doc.createElementNS(S, 'f');
          f.textContent = change.value.slice(1);
          node.appendChild(f);
        } else if (
          /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(change.value) &&
          Number.isFinite(Number(change.value)) &&
          change.value.replace(/\D/g, '').length <= 15
        ) {
          const v = doc.createElementNS(S, 'v');
          v.textContent = change.value;
          node.appendChild(v);
        } else {
          node.setAttribute('t', 'inlineStr');
          const is = doc.createElementNS(S, 'is'),
            t = doc.createElementNS(S, 't');
          t.setAttribute('xml:space', 'preserve');
          t.textContent = change.value;
          is.appendChild(t);
          node.appendChild(is);
        }
      }
      if (format === 'xlsx' && changes.length) {
        if (zip.file('xl/calcChain.xml')) {
          zip.remove('xl/calcChain.xml');
          for (const name of ['[Content_Types].xml', 'xl/_rels/workbook.xml.rels']) {
            const entry = zip.file(name);
            if (!entry) continue;
            const doc = parse(await entry.async('string'));
            const nodes = Array.from(doc.documentElement!.childNodes);
            for (const node of nodes) {
              if (node.nodeType !== 1) continue;
              const element = node as Element;
              if (
                element.getAttribute('PartName') === '/xl/calcChain.xml' ||
                element.getAttribute('Type')?.endsWith('/calcChain')
              )
                element.parentNode!.removeChild(element);
            }
            zip.file(name, new XMLSerializer().serializeToString(doc));
          }
        }
        for (const [part, doc] of docs)
          for (const cell of elements(doc, S, 'c'))
            if (elements(cell, S, 'f').length) {
              for (const value of elements(cell, S, 'v')) cell.removeChild(value);
              changed.add(part);
            }
        const wb = zip.file('xl/workbook.xml');
        if (wb) {
          const doc = parse(await wb.async('string'));
          let calc = elements(doc, S, 'calcPr')[0];
          if (!calc) {
            calc = doc.createElementNS(S, 'calcPr');
            doc.documentElement!.appendChild(calc);
          }
          calc.setAttribute('fullCalcOnLoad', '1');
          calc.setAttribute('forceFullCalc', '1');
          calc.setAttribute('calcMode', 'auto');
          zip.file('xl/workbook.xml', new XMLSerializer().serializeToString(doc));
        }
      }
      for (const part of changed)
        zip.file(part, new XMLSerializer().serializeToString(docs.get(part)!));
      const next = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      // Recheck after asynchronous compression, including external Office edits.
      if (digest(readFileSync(path)) !== revision)
        throw new ConflictException('保存期间文档已变化，请重新加载');
      const backupDir = join(getDefaultDataDir(), 'office-backups');
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(
        join(backupDir, createHash('sha256').update(path).digest('hex') + extname(path)),
        before,
      );
      const temp = path + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temp, next);
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
      return { revision: digest(next), saved: changes.length };
    });
  }
}
@Controller('files/office')
export class OfficeController {
  constructor(private readonly office: OfficeService) {}
  @Get('templates') templates() { return officeTemplates; }
  @Post('create') create(@Body() body: {directory:string;name:string;format:string;template?:string}) {
    return this.office.create(body?.directory, body?.name, body?.format, body?.template);
  }
  @Get() read(@Query('path') path: string) {
    return this.office.read(path);
  }
  @Post() save(
    @Body() body: { path: string; revision: string; changes: Array<{ id: string; value: string }> },
  ) {
    return this.office.save(body?.path, body?.revision, body?.changes);
  }
}
