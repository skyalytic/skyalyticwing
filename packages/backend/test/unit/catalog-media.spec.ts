import 'reflect-metadata';
import { CatalogImageProvider, CatalogVideoProvider } from '../../src/modules/automation/catalog-media.providers.js';
import { VideoSubmissionRejected } from '../../src/modules/automation/video-provider.service.js';

describe('native catalog media protocols', () => {
  const cfg = { id: 'fixture', apiKey: 'fixture-only', baseUrl: 'https://proxy.example/v1', model: 'model-fixture' };
  const http = { post: jest.fn(), get: jest.fn() };
  beforeEach(() => jest.resetAllMocks());
  it('uses Gemini native content, key header and inline image output', async () => {
    http.post.mockResolvedValue({ status: 200, data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } }] } });
    const p = new CatalogImageProvider('gemini', cfg, http as never);
    const r = await p.generate({ prompt: 'fixture', model: 'gemini-nano-banana-2.1' });
    expect(http.post).toHaveBeenCalledWith('https://proxy.example/v1/models/gemini-nano-banana-2.1:generateContent', expect.objectContaining({ contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] }), expect.objectContaining({ headers: { 'x-goog-api-key': 'fixture-only' }, maxRedirects: 0 }));
    expect(r.images[0]?.data?.toString()).toBe('hello');
  });
  it.each(['xai', 'zhipu', 'siliconflow', 'ideogram'] as const)('%s uses its native payload instead of assuming OpenAI', async protocol => {
    http.post.mockResolvedValue({ status: 200, data: { data: [{ url: 'https://example.com/image.png' }], images: [{ url: 'https://example.com/image.png' }] } });
    await new CatalogImageProvider(protocol, cfg, http as never).generate({ prompt: 'fixture' });
    const [url, body, options] = http.post.mock.calls[0]!;
    expect(body.batch_size).toBeUndefined();
    if (protocol === 'siliconflow') expect(body.image_size).toBe('1024x1024');
    if (protocol === 'zhipu') expect(body.size).toBe('1280x1280');
    if (protocol === 'xai') expect(body.aspect_ratio).toBe('1:1');
    if (protocol === 'ideogram') { expect(url).toContain('/image/generate/model-fixture'); expect(options.headers).toEqual({ 'Api-Key': 'fixture-only' }); }
  });
  it('parses MiniMax image URLs and rejects application errors with HTTP 200', async () => {
    const p = new CatalogImageProvider('minimax', cfg, http as never);
    http.post.mockResolvedValue({ status: 200, data: { data: { image_urls: ['https://example.com/a.png'] }, base_resp: { status_code: 0 } } });
    expect((await p.generate({ prompt: 'fixture' })).images[0]?.url).toContain('a.png');
    expect(http.post.mock.calls[0]?.[0]).toBe('https://proxy.example/v1/image_generation');
    http.post.mockResolvedValue({ status: 200, data: { base_resp: { status_code: 1004 } } });
    await expect(p.generate({ prompt: 'fixture' })).rejects.toThrow('failed');
  });
  it('does not fan out count requests or accept empty image success', async () => {
    const p = new CatalogImageProvider('gemini', cfg, http as never);
    await expect(p.generate({ prompt: 'fixture', count: 3 })).rejects.toThrow('one image');
    expect(http.post).not.toHaveBeenCalled();
    http.post.mockResolvedValue({ status: 200, data: {} });
    await expect(p.generate({ prompt: 'fixture' })).rejects.toThrow('no generated image');
  });
  it.each(['minimax', 'xai'] as const)('%s submits once and polls the returned ID', async protocol => {
    const request = { prompt: 'fixture', inputImages: ['https://example.com/frame.png'] };
    const p = new CatalogVideoProvider(protocol, cfg, http as never);
    http.post.mockResolvedValue({ status: 200, data: { task_id: 'task/id', request_id: 'task/id' } });
    http.get.mockResolvedValue({ status: 200, data: protocol === 'minimax' ? { task: { status: 'succeeded', content: { url: 'https://example.com/video.mp4' } } } : { status: 'done', video: { url: 'https://example.com/video.mp4' } } });
    const id = await p.submit(request); const result = await p.query(id, request);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.get.mock.calls[0]?.[0]).toContain('task%2Fid');
    expect(result.status).toBe('SUCCEEDED');
    if (protocol === 'minimax') expect(http.post.mock.calls[0]?.[1].content[1]).toEqual({ type: 'image_url', image_url: { url: request.inputImages[0] }, role: 'first_frame' });
    else expect(http.post.mock.calls[0]?.[1].image).toEqual({ url: request.inputImages[0] });
  });
  it('classifies rejection versus unknown submission without retrying', async () => {
    const p = new CatalogVideoProvider('xai', cfg, http as never);
    http.post.mockResolvedValue({ status: 400, data: {} });
    await expect(p.submit({ prompt: 'fixture' })).rejects.toBeInstanceOf(VideoSubmissionRejected);
    http.post.mockResolvedValue({ status: 503, data: {} });
    try { await p.submit({ prompt: 'fixture' }); throw new Error('expected failure'); } catch (error) { expect(error).not.toBeInstanceOf(VideoSubmissionRejected); }
    expect(http.post).toHaveBeenCalledTimes(2);
  });
});
