import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LoggerService } from '../core/logger/logger.service.js';

/** 平台标识 */
const IS_WIN = platform() === 'win32';

/** OCR 词结果（词级坐标框） */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** OCR 完整结果 */
export interface OcrResult {
  success: boolean;
  text: string;
  words: OcrWord[];
  lang?: string;
  engine: 'winocr' | 'tesseract';
  error?: string;
}

/** Tesseract worker 缓存（懒加载，避免启动即拉重量级依赖） */
let tesseractWorker: unknown | null = null;
let tesseractWorkerResolved = false;

/**
 * OcrService - 本地 OCR 服务
 *
 * （本地文字识别能力，与媒体 API 生成无关——旧媒体套件清理时保留）
 *
 *   Windows: winocr.ps1（Windows.Media.Ocr，系统内置零依赖，词级坐标框）
 *   其他平台 / WinRT 失败: tesseract.js 降级
 *
 * 词级坐标 + 中文逐字合并（同行且 x 相邻 ≤ 8px 合并）
 * 是桌面自动化"按文字定位坐标"的基础能力。
 */
@Injectable()
export class OcrService {
  private winOcrScriptPath: string | null | undefined;

  constructor(private readonly logger: LoggerService) {}

  /** OCR 是否可用（任一引擎就绪） */
  isAvailable(): boolean {
    return this.resolveWinOcrScript() !== null || this.tesseractAvailable();
  }

  /**
   * 识别图片文字，返回词级坐标框。
   * offset: 图片在屏幕上的偏移（窗口截图 → 屏幕全局坐标转换）
   */
  async recognize(
    imagePath: string,
    offset?: { x?: number; y?: number },
  ): Promise<OcrResult> {
    if (!existsSync(imagePath)) {
      return { success: false, text: '', words: [], engine: 'winocr', error: `图片不存在: ${imagePath}` };
    }
    // Windows：优先 WinRT（系统内置、中文好、带词级框）
    if (IS_WIN) {
      const r = await this.winOcr(imagePath, offset);
      if (r.success) return r;
      this.logger.warn('WinOCR failed, falling back to tesseract', { error: r.error });
    }
    // 降级：tesseract.js（跨平台兜底）
    return this.tesseractOcr(imagePath, offset);
  }

  /** winocr.ps1 路径解析（与 desktop.service.ts resolveCsFile 同一套布局约定） */
  private resolveWinOcrScript(): string | null {
    if (this.winOcrScriptPath !== undefined) return this.winOcrScriptPath;
    if (!IS_WIN) {
      this.winOcrScriptPath = null;
      return null;
    }
    const candidates = [
      join(__dirname, '..', '..', '..', '..', 'web', 'winocr.ps1'),
      join(__dirname, '..', '..', '..', '..', '..', 'web', 'winocr.ps1'),
      join(process.cwd(), 'packages', 'web', 'winocr.ps1'),
      join(process.cwd(), '..', 'web', 'winocr.ps1'),
      join(process.cwd(), 'web', 'winocr.ps1'),
      join(process.cwd(), 'winocr.ps1'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        this.winOcrScriptPath = p;
        return p;
      }
    }
    this.winOcrScriptPath = null;
    return null;
  }

  /** 调 winocr.ps1（Windows.Media.Ocr），输出 JSON：{text, words:[{text,x,y,w,h}], lang} */
  private async winOcr(
    imagePath: string,
    offset?: { x?: number; y?: number },
  ): Promise<OcrResult> {
    const script = this.resolveWinOcrScript();
    if (!script) {
      return { success: false, text: '', words: [], engine: 'winocr', error: 'winocr.ps1 not found' };
    }
    const stdout = await new Promise<string>((resolve) => {
      // 数组参数防注入（-File 调用，避免拼 shell 字符串）
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ImagePath', imagePath],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
        (err, out) => resolve(err ? '' : (out ?? '')),
      );
    });
    if (!stdout.trim()) {
      return { success: false, text: '', words: [], engine: 'winocr', error: 'winocr.ps1 无输出' };
    }
    try {
      const parsed = JSON.parse(stdout) as {
        error?: string;
        text?: string;
        words?: Array<{ text?: string; x?: number; y?: number; w?: number; h?: number }>;
        lang?: string;
      };
      if (parsed.error) {
        return { success: false, text: '', words: [], engine: 'winocr', error: parsed.error };
      }
      let words: OcrWord[] = (parsed.words ?? []).map((w) => ({
        text: String(w.text ?? ''),
        x: Number(w.x ?? 0),
        y: Number(w.y ?? 0),
        w: Number(w.w ?? 0),
        h: Number(w.h ?? 0),
      }));
      // offset 坐标转换（窗口截图 → 屏幕全局坐标）
      if (offset && (offset.x || offset.y)) {
        const ox = offset.x ?? 0;
        const oy = offset.y ?? 0;
        words = words.map((w) => ({ ...w, x: w.x + ox, y: w.y + oy }));
      }
      // 中文逐字合并（WinRT 将中文逐字拆分，"文宇"→"文"+"宇"）
      words = mergeOcrWords(words);
      return {
        success: true,
        text: parsed.text ?? '',
        words,
        ...(parsed.lang ? { lang: parsed.lang } : {}),
        engine: 'winocr',
      };
    } catch (e) {
      return {
        success: false,
        text: '',
        words: [],
        engine: 'winocr',
        error: `winocr 输出解析失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** tesseract.js 是否可用（依赖已装且可加载） */
  private tesseractAvailable(): boolean {
    if (!tesseractWorkerResolved) {
      tesseractWorker = this.loadTesseract();
      tesseractWorkerResolved = true;
    }
    return tesseractWorker !== null;
  }

  /** 懒加载 tesseract.js（与 main.ts 预热同一实例语义） */
  private loadTesseract(): unknown | null {
    try {
      const dynamicRequire = require;
      return dynamicRequire('tesseract.js');
    } catch {
      return null;
    }
  }

  /** tesseract.js OCR（跨平台兜底；中文 chi_sim + 英文 eng 双语） */
  private async tesseractOcr(
    imagePath: string,
    offset?: { x?: number; y?: number },
  ): Promise<OcrResult> {
    const mod = this.tesseractAvailable() ? (tesseractWorker as {
      recognize: (img: string, langs: string) => Promise<{
        data: { text: string; words?: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> };
      }>;
    }) : null;
    if (!mod) {
      return {
        success: false,
        text: '',
        words: [],
        engine: 'tesseract',
        error: '本地 OCR 引擎不可用（winocr.ps1 未找到且 tesseract.js 加载失败）',
      };
    }
    try {
      const { data } = await mod.recognize(imagePath, 'chi_sim+eng');
      let words: OcrWord[] = (data.words ?? [])
        .filter((w) => (w.text ?? '').trim().length > 0)
        .map((w) => ({
          text: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
        }));
      if (offset && (offset.x || offset.y)) {
        const ox = offset.x ?? 0;
        const oy = offset.y ?? 0;
        words = words.map((w) => ({ ...w, x: w.x + ox, y: w.y + oy }));
      }
      words = mergeOcrWords(words);
      return { success: true, text: data.text ?? '', words, engine: 'tesseract' };
    } catch (e) {
      return {
        success: false,
        text: '',
        words: [],
        engine: 'tesseract',
        error: `tesseract OCR 失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

/**
 * 合并同行相邻的 OCR 词。
 * Windows.Media.Ocr 将中文逐字拆分（"文宇"→"文"+"宇"），合并后精确匹配
 * 可直接命中"文宇"，不依赖邻近检测。规则：y 相近（同行）且 x 相邻（间距 ≤ 8px）。
 */
export function mergeOcrWords(words: OcrWord[]): OcrWord[] {
  if (!words || words.length < 2) return words;
  const sorted = words.slice().sort((a, b) => {
    const ay = a.y || 0;
    const by = b.y || 0;
    if (Math.abs(ay - by) > Math.min(a.h || 1, b.h || 1) * 0.5) return ay - by;
    return (a.x || 0) - (b.x || 0);
  });
  const merged: OcrWord[] = [];
  let cur: OcrWord | null = null;
  for (const w of sorted) {
    if (
      cur &&
      Math.abs((cur.y || 0) - (w.y || 0)) < Math.min(cur.h || 1, w.h || 1) * 0.5 &&
      (w.x || 0) <= (cur.x || 0) + (cur.w || 0) + 8
    ) {
      const rightEdge = Math.max((cur.x || 0) + (cur.w || 0), (w.x || 0) + (w.w || 0));
      cur.w = rightEdge - (cur.x || 0);
      cur.text = (cur.text || '') + (w.text || '');
    } else {
      if (cur) merged.push(cur);
      cur = { text: w.text, x: w.x, y: w.y, w: w.w, h: w.h };
    }
  }
  if (cur) merged.push(cur);
  return merged;
}

/** 生成临时 OCR 图片路径（调用方写入后传 recognize） */
export function ocrTempImagePath(): string {
  return join(tmpdir(), `ocr-${randomUUID()}.png`);
}

/** 读取文本文件内容（工具层辅助） */
export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
