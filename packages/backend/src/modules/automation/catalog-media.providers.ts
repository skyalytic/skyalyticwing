import type { HttpClientService } from '../core/http/http-client.service.js';
import type { GeneratedImage, ImageGenerateRequest, ImageGenerateResult, ImageProvider, ProviderConfig } from './image-provider.service.js';
import { VideoSubmissionRejected, type VideoGenerateRequest, type VideoGenerateResult, type VideoProvider, type VideoTaskSnapshot } from './video-provider.service.js';

/** Native payloads are intentionally separate from OpenAI-compatible chat payloads. */
export class CatalogImageProvider implements ImageProvider {
  id: string;
  name: string;
  private root: string;
  private key: string;
  private model: string;
  constructor(private protocol: 'gemini' | 'minimax' | 'xai' | 'zhipu' | 'siliconflow' | 'ideogram', cfg: ProviderConfig, private http: HttpClientService) {
    this.id = String(cfg['id']); this.name = String(cfg['name'] || this.id);
    this.root = String(cfg['baseUrl'] || '').replace(/\/$/, '');
    this.key = String(cfg['apiKey'] || ''); this.model = String(cfg['model'] || '');
  }
  listModels() { return [this.model]; }
  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResult> {
    if (!this.key || !this.root) throw new Error('Image API key and base URL are required');
    const model = request.model || this.model;
    const count = request.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Image count must be between 1 and 10');
    // Do not fan out a single request into unexpected multiple paid calls.
    if (['gemini','zhipu','siliconflow'].includes(this.protocol) && count !== 1) throw new Error('This image protocol supports one image per task');
    const [width, height] = (request.size || (this.protocol === 'zhipu' ? '1280x1280' : '1024x1024')).split('x').map(Number);
    if (!width || !height) throw new Error('Image size must be WIDTHxHEIGHT');
    let endpoint = '/images/generations';
    let body: Record<string, unknown> = { model, prompt: request.prompt };
    let headers: Record<string, string> = { Authorization: `Bearer ${this.key}` };
    if (this.protocol === 'gemini') {
      endpoint = `/models/${encodeURIComponent(model)}:generateContent`;
      headers = { 'x-goog-api-key': this.key };
      body = { contents: [{ role: 'user', parts: [{ text: request.prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspectRatio(width, height) } } };
    } else if (this.protocol === 'ideogram') {
      endpoint = `/image/generate/${encodeURIComponent(model)}`;
      headers = { 'Api-Key': this.key };
      body = { prompt: request.prompt, num_images: count, resolution: `${width}x${height}` };
    } else if (this.protocol === 'minimax') {
      endpoint = '/image_generation';
      body = { ...body, n: count, aspect_ratio: aspectRatio(width, height), response_format: 'url' };
    } else if (this.protocol === 'xai') {
      body = { ...body, n: count, aspect_ratio: aspectRatio(width, height), response_format: 'url' };
    } else if (this.protocol === 'siliconflow') {
      body['image_size'] = `${width}x${height}`;
    } else body['size'] = `${width}x${height}`;
    const response = await this.http.post<any>(this.root + endpoint, body, { headers, responseType: 'json', timeout: 180_000, maxRedirects: 0 });
    if (response.status >= 400 || response.data?.error || response.data?.base_resp?.status_code) throw new Error(`${this.name} image request failed (HTTP ${response.status})`);
    const images: GeneratedImage[] = [];
    const add = (url?: string, b64?: string, mime = 'image/png') => {
      if (!url && !b64) return;
      images.push({ url: url || null, data: b64 ? Buffer.from(b64, 'base64') : null, format: mime.split('/')[1] || 'png', width, height });
    };
    if (this.protocol === 'gemini') {
      for (const candidate of response.data?.candidates || []) for (const part of candidate.content?.parts || []) {
        const inline = part.inlineData || part.inline_data;
        if (inline?.data && /^image\//.test(inline.mimeType || inline.mime_type || '')) add(undefined, inline.data, inline.mimeType || inline.mime_type);
      }
    } else if (this.protocol === 'minimax') {
      for (const url of response.data?.data?.image_urls || []) add(url);
    } else {
      for (const item of response.data?.data || response.data?.images || []) add(item.url, item.b64_json);
    }
    if (!images.length) throw new Error(`${this.name} returned no generated image`);
    return { images, model, metadata: { provider: this.id } };
  }
}

function aspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const d = gcd(width, height); return `${width / d}:${height / d}`;
}

/** Both adapters use the persistent task queue: submit once, then poll by ID. */
export class CatalogVideoProvider implements VideoProvider {
  id: string; name: string; defaultModel: string; supportsImageInput = true;
  private root: string; private key: string;
  constructor(private protocol: 'minimax' | 'xai', cfg: ProviderConfig, private http: HttpClientService) {
    this.id = String(cfg['id']); this.name = String(cfg['name'] || this.id);
    this.defaultModel = String(cfg['model'] || ''); this.root = String(cfg['baseUrl'] || '').replace(/\/$/, ''); this.key = String(cfg['apiKey'] || '');
  }
  async submit(request: VideoGenerateRequest): Promise<string> {
    if (!this.key || !this.root) throw new VideoSubmissionRejected('Video API key and base URL are required');
    const model = request.model || this.defaultModel;
    const duration = request.durationSeconds ?? 5;
    if (!Number.isInteger(duration) || duration < (this.protocol === 'minimax' ? (model.endsWith('-Max') ? 5 : 4) : 1) || duration > 15) throw new VideoSubmissionRejected('Unsupported video duration');
    if ((request.inputImages?.length || 0) > (this.protocol === 'minimax' ? 2 : 1)) throw new VideoSubmissionRejected('Too many reference images for this video protocol');
    const ratios: Record<string, string> = { '1280x720': '16:9', '1920x1080': '16:9', '720x1280': '9:16', '1080x1920': '9:16', '1024x1024': '1:1' };
    if (request.size && !ratios[request.size]) throw new VideoSubmissionRejected('Unsupported video size');
    let body: Record<string, unknown>;
    let endpoint: string;
    if (this.protocol === 'minimax') {
      endpoint = '/video_generation';
      body = { model, content: [{ type: 'text', text: request.prompt }, ...(request.inputImages || []).map((url, i) => ({ type: 'image_url', image_url: { url }, role: i ? 'last_frame' : 'first_frame' }))], duration, resolution: '768P', ratio: ratios[request.size || '1280x720'] };
    } else {
      endpoint = '/videos/generations';
      body = { model, prompt: request.prompt, duration, aspect_ratio: ratios[request.size || '1280x720'], resolution: /1080/.test(request.size || '') ? '1080p' : '720p', ...(request.inputImages?.length ? { image: { url: request.inputImages[0] } } : {}) };
    }
    const response = await this.http.post<any>(this.root + endpoint, body, { headers: { Authorization: `Bearer ${this.key}` }, responseType: 'json', maxRedirects: 0 });
    if (response.status >= 400) throw new (response.status < 500 ? VideoSubmissionRejected : Error)(`${this.name} video submission failed (HTTP ${response.status})`);
    const id = this.protocol === 'minimax' ? response.data?.task_id : response.data?.request_id;
    if (typeof id !== 'string' || !id) throw new Error(`${this.name} returned no task ID; submission outcome is unknown`);
    return id;
  }
  async query(taskId: string, request: VideoGenerateRequest): Promise<VideoTaskSnapshot> {
    const endpoint = this.protocol === 'minimax' ? '/query/video_generation/' : '/videos/';
    const response = await this.http.get<any>(this.root + endpoint + encodeURIComponent(taskId), { headers: { Authorization: `Bearer ${this.key}` }, responseType: 'json', maxRedirects: 0 });
    if (response.status >= 400) throw new Error(`${this.name} polling failed (HTTP ${response.status})`);
    const data = this.protocol === 'minimax' ? response.data?.task : response.data;
    const states: Record<string, VideoTaskSnapshot['status']> = { pending: 'PENDING', queued: 'PENDING', processing: 'RUNNING', running: 'RUNNING', succeeded: 'SUCCEEDED', done: 'SUCCEEDED', failed: 'FAILED', canceled: 'CANCELED', cancelled: 'CANCELED' };
    const status = states[data?.status];
    if (!status) throw new Error(`${this.name} returned an unknown task status`);
    if (status !== 'SUCCEEDED') return { status, ...(status === 'FAILED' ? { error: `${this.name} video generation failed` } : {}) };
    const url = this.protocol === 'minimax' ? data.content?.url : data.video?.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error(`${this.name} completed without a video URL`);
    return { status, result: { videos: [{ url, data: null, format: 'mp4', duration: data.duration || data.video?.duration || request.durationSeconds || 5 }], model: request.model || this.defaultModel, metadata: { taskId } } };
  }
  async generate(_request: VideoGenerateRequest): Promise<VideoGenerateResult> {
    throw new VideoSubmissionRejected('Use the persistent video task API to submit and poll this provider');
  }
}
