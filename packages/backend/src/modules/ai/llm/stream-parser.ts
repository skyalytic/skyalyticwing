/**
 * SSE 流式响应解析器
 *
 * 处理标准 Server-Sent Events 格式：以 `event:` / `data:` 行构成，空行分隔事件。
 *   - `event: <name>` 设置当前事件名（Anthropic 使用）
 *   - `data: <payload>` 累积数据行，多行 data 以 `\n` 连接
 *   - 空行触发事件派发
 *   - 以 `:` 开头的行是注释，忽略
 * OpenAI 仅使用 `data:` 行（末尾 `data: [DONE]`），Anthropic 同时使用 `event:` + `data:`。
 */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * 将 Web ReadableStream（fetch response.body）解析为 SSE 事件流。
 *
 * @param stream fetch 返回的 ReadableStream<Uint8Array>
 * @yields { event?, data } 事件对象
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];
  let eventSize = 0;
  const maxEventSize = 4 * 1024 * 1024;

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) return undefined;
    const ev: SseEvent = { data: dataLines.join('\n') };
    if (currentEvent !== undefined) ev.event = currentEvent;
    dataLines = [];
    eventSize = 0;
    currentEvent = undefined;
    return ev;
  };

  const applyLine = (line: string): SseEvent | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
      return undefined;
    }
    if (line.startsWith('data:')) {
      eventSize += line.length;
      if (eventSize > maxEventSize) throw new Error('Model stream event exceeds 4 MiB');
      // 去掉 "data:" 后最多一个前导空格
      dataLines.push(line.slice(5).replace(/^\s/, ''));
      return undefined;
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const ev = applyLine(line);
        if (ev) yield ev;
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > maxEventSize) throw new Error('Model stream line exceeds 4 MiB');
    }
    // flush 解码器内部残留
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const ev = applyLine(buffer.replace(/\r$/, ''));
      if (ev) yield ev;
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
