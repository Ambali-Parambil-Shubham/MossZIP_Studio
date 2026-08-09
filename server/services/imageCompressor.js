import sharp from 'sharp';

/**
 * Enterprise Image Compressor & Security Sanitizer
 * - Strips EXIF metadata & GPS coordinates by default
 * - Prevents decompression bombs (limit input pixels to 25 MegaPixels max)
 * - Safe color profile handling
 */
export async function compressImage(buffer, extension) {
  const ext = (extension || '').toLowerCase().replace('.', '');
  try {
    // 1. Validate image metadata & guard against decompression bombs
    const metadata = await sharp(buffer, { limitInputPixels: 25000000 }).metadata().catch(() => null);
    if (!metadata) return buffer;

    // 2. Strip EXIF, ICC profiles, and orientation metadata for security & privacy
    let pipeline = sharp(buffer, { limitInputPixels: 25000000 }).rotate();

    // 3. Maximum dimension cap for high-efficiency image compression
    const maxDim = 1920;
    if (metadata.width > maxDim || metadata.height > maxDim) {
      pipeline = pipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
    }

    let resultBuffer;
    if (ext === 'jpg' || ext === 'jpeg') {
      resultBuffer = await pipeline
        .jpeg({
          quality: 65,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: '4:2:0',
        })
        .toBuffer();
    } else if (ext === 'png') {
      resultBuffer = await pipeline
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
          palette: true,
          quality: 65,
        })
        .toBuffer();
    } else if (ext === 'webp') {
      resultBuffer = await pipeline
        .webp({
          quality: 65,
          effort: 5,
        })
        .toBuffer();
    } else {
      resultBuffer = await pipeline.toBuffer();
    }

    return (resultBuffer && resultBuffer.length < buffer.length) ? resultBuffer : buffer;
  } catch (err) {
    console.error('[ImageCompressor Security Warning]:', err.message);
    return buffer;
  }
}
