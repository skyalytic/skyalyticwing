import type { Type } from '@nestjs/common';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { OcrService } from '../../../../modules/automation/ocr.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';

/**
 * 本地 OCR 工具组
 *
 * OCR 属本地文字识别能力（WinRT / tesseract.js，离线零成本），与媒体 API
 * 生成无关——旧媒体套件（语音 TTS/STT、音乐生成、媒体分析）清理时保留。
 *
 *   - ocr：识别图片文字并返回全文 + 词级坐标框（桌面自动化按文字定位坐标 /
 *     截图读字；与 computer_use（UIA 元素级）互补）
 */

/** 服务懒解析缓存 */
function lazy<T>(resolve: ServiceResolver, type: Type<T>): () => T | undefined {
  let cache: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      cache = resolve(type);
      done = true;
    }
    return cache;
  };
}

export function createOcrTools(resolve: ServiceResolver): ToolDefinition[] {
  const getOcr = lazy(resolve, OcrService);

  const ocrTool: ToolDefinition = {
    name: 'ocr',
    description:
      '本地 OCR 文字识别（离线、零成本）。识别图片中的文字并返回全文 + 词级坐标框（每个词的 text/x/y/w/h）。' +
      'Windows 优先用系统内置 WinRT OCR（中文准确），失败自动降级 tesseract.js；其他平台直接用 tesseract.js。' +
      '典型用途：1) 桌面自动化时按文字精确定位坐标（配合 desktop 工具点击 words 里目标词的中心点）；' +
      '2) 读取截图/扫描件文字；3) 与 computer_use（UIA 元素级）互补——UIA 找不到控件时用 OCR 坐标降级定位。',
    category: 'automation',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: '图片文件路径（PNG/JPG，建议先用 desktop_screenshot 截图获取路径）' },
        offsetX: { type: 'number', description: '截图区域在屏幕上的 X 偏移（窗口截图转屏幕全局坐标时传入）' },
        offsetY: { type: 'number', description: '截图区域在屏幕上的 Y 偏移' },
      },
      required: ['imagePath'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as { imagePath?: string; offsetX?: number; offsetY?: number };
      if (!a.imagePath) return { success: false, error: 'imagePath 参数必填' };
      const ocr = getOcr();
      if (!ocr) return { success: false, error: 'OCR 服务不可用（AutomationModule 未加载）' };
      try {
        const r = await ocr.recognize(a.imagePath, {
          ...(a.offsetX !== undefined ? { x: a.offsetX } : {}),
          ...(a.offsetY !== undefined ? { y: a.offsetY } : {}),
        });
        if (!r.success) {
          return { success: false, error: r.error ?? 'OCR 识别失败' };
        }
        return {
          success: true,
          output: JSON.stringify(
            { text: r.text, words: r.words, lang: r.lang, engine: r.engine },
          ).slice(0, 50_000),
          data: { text: r.text, words: r.words, lang: r.lang, engine: r.engine },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return [ocrTool];
}
