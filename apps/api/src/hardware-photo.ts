import sharp from 'sharp';

export const MAX_HARDWARE_PHOTO_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_HARDWARE_PHOTO_OUTPUT_BYTES = 5 * 1024 * 1024;
export const MAX_HARDWARE_PHOTO_PIXELS = 25_000_000;

export type HardwarePhotoFormat = 'jpeg' | 'png' | 'webp';

/** Decode, orient, and re-encode one bounded still image. Re-encoding drops source metadata. */
export async function normalizeHardwarePhoto(input: Buffer) {
  if (!input.length || input.length > MAX_HARDWARE_PHOTO_INPUT_BYTES)
    throw new Error('Invalid photo size');

  const decoder = sharp(input, {
    limitInputPixels: MAX_HARDWARE_PHOTO_PIXELS,
    failOn: 'error',
    sequentialRead: true,
    animated: false,
  });
  const metadata = await decoder.metadata();
  if (metadata.format !== 'jpeg' && metadata.format !== 'png' && metadata.format !== 'webp')
    throw new Error('Unsupported photo format');
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_HARDWARE_PHOTO_PIXELS ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error('Unsupported photo dimensions');

  let pipeline = sharp(input, {
    limitInputPixels: MAX_HARDWARE_PHOTO_PIXELS,
    failOn: 'error',
    sequentialRead: true,
    animated: false,
  }).rotate();
  if (metadata.format === 'jpeg') pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
  else if (metadata.format === 'png')
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  else pipeline = pipeline.webp({ quality: 90 });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  if (
    data.length === 0 ||
    data.length > MAX_HARDWARE_PHOTO_OUTPUT_BYTES ||
    info.width * info.height > MAX_HARDWARE_PHOTO_PIXELS ||
    info.format !== metadata.format
  )
    throw new Error('Normalized photo exceeds supported limits');

  return {
    bytes: data,
    format: metadata.format as HardwarePhotoFormat,
    width: info.width,
    height: info.height,
  };
}
