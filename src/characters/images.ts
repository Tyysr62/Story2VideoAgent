import sharp from 'sharp';
import { AppError } from '../domain/storyboard.js';
import type { ImageAsset } from '../domain/characters.js';

export const MAX_PORTRAIT_BYTES = 10 * 1024 * 1024;
export async function validatePortrait(bytes: Buffer, declaredMime: string): Promise<{ mime: ImageAsset['mime']; width: number; height: number }> {
  if (!bytes.length || bytes.length > MAX_PORTRAIT_BYTES) throw new AppError(400, '参考图必须为 1 字节至 10 MiB');
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!mime || declaredMime.split(';')[0].trim().toLowerCase() !== mime) throw new AppError(400, '仅支持真实 PNG、JPEG、WebP 格式，声明类型必须匹配');
  if (mime === 'image/png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw new AppError(400, '参考图仅支持静态图片，不支持动画');
      offset += 12 + length;
    }
  }
  try {
    const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1 || metadata.delay) throw new AppError(400, '参考图仅支持静态图片，不支持动画');
    if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) throw new AppError(400, '参考图宽高不能超过 4096 像素');
    await image.raw().toBuffer(); // Metadata alone does not prove that the compressed pixel data is valid.
    return { mime, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, '图片无法完整解码或超过 4096×4096 限制');
  }
}
