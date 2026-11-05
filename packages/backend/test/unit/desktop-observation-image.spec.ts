import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { desktopObservationImage } from '../../src/extensions/bundled/computer-use/runtime/desktop-observation-image';
import { visualObservation } from '../../src/modules/ai/agent/visual-observation';
it('keeps UI text pixels lossless and sends high-detail images without journaling pixels', async () => {
  const source = sharp(Buffer.from('<svg width="300" height="100"><rect width="300" height="100" fill="white"/><text x="10" y="40" font-size="16">Query: ABC123</text></svg>'));
  const expected = await source.clone().raw().toBuffer();
  const image = await desktopObservationImage(source);
  expect(image.mimeType).toBe('image/png'); expect(await sharp(image.data).raw().toBuffer()).toEqual(expected);
  const result = visualObservation({ success: true, data: { desktopWorkflow: true, lookId: 'after', visualObservation: { kind: 'desktop', mimeType: image.mimeType, detail: 'high', screenshotId: 'after', base64: image.data.toString('base64') } } }, 'gpt-4o', 'openai');
  expect((result.message?.content as any[])[1]).toMatchObject({ type: 'image_url', image_url: { detail: 'high' } });
  expect((result.message?.content as any[])[1].image_url.url).toMatch(/^data:image\/png/);
  expect((result.result as any).data).not.toHaveProperty('visualObservation');
});
it('fits a high-entropy frame within the transport budget without silently dropping it', async () => {
  const result = await desktopObservationImage(sharp(randomBytes(1600 * 1000 * 3), { raw: { width: 1600, height: 1000, channels: 3 } }));
  expect(result.mimeType).toBe('image/jpeg'); expect(result.data.length).toBeLessThanOrEqual(2_900_000);
  expect(result.info).toMatchObject({ width: 1600, height: 1000 });
});
