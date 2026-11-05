import type { Sharp } from 'sharp';
/** Keep small UI text lossless, falling back only to fit the image transport budget. */
export async function desktopObservationImage(source: Sharp) {
  let rendered = await source.clone().png().toBuffer({ resolveWithObject: true });
  let mimeType: 'image/png' | 'image/jpeg' = 'image/png';
  if (rendered.data.length > 2_900_000) {
    mimeType = 'image/jpeg';
    rendered = await source.clone().jpeg({ quality: 93, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
    if (rendered.data.length > 2_900_000) rendered = await source.clone().jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
  }
  if (rendered.data.length > 2_900_000) throw new Error('Desktop image exceeds the transport budget; observe a smaller window.');
  return { ...rendered, mimeType };
}
