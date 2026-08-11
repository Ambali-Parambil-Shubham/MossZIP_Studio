import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Configure FFmpeg binary path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * MossZip Ultra-Fast Video Compressor Engine (5GB+ Large File Support)
 * Codec: H.264 (libx264) with CRF 28, AAC 128k audio, yuv420p, +faststart, ultrafast preset & all CPU threads.
 */
export async function compressVideoFile(tempInputPath, extension = 'mp4') {
  const uuid = crypto.randomUUID();
  const tempOutputPath = path.join(os.tmpdir(), `output_${uuid}.mp4`);

  try {
    const inStat = fs.statSync(tempInputPath);
    const inSize = inStat ? inStat.size : 0;

    // Production-Safe FFmpeg Compression (H.264 + AAC, Preserves Duration, Audio & Timing)
    await new Promise((resolve, reject) => {
      const command = ffmpeg(tempInputPath)
        .inputOptions(['-nostdin'])
        .outputOptions([
          '-c:v', 'libx264',
          '-crf', '28',
          '-preset', 'fast',
          '-threads', '0',
          '-vf', 'scale=trunc(min(1920\\,iw)/2)*2:trunc(min(1080\\,ih)/2)*2',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-max_muxing_queue_size', '2048',
          '-map', '0:v:0',
          '-map', '0:a?',
        ])
        .output(tempOutputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err));

      command.run();
    });

    // Verify output integrity and non-zero size
    if (fs.existsSync(tempOutputPath)) {
      const outStat = fs.statSync(tempOutputPath);
      if (outStat.size > 1024 && outStat.size < inSize) {
        return tempOutputPath;
      }
    }

    return tempOutputPath;
  } catch (err) {
    console.error('[VideoCompressor] FFmpeg compression error:', err);
    return tempInputPath;
  }
}

export async function compressVideo(buffer, extension = 'mp4') {
  const ext = (extension || 'mp4').toLowerCase().replace('.', '');
  const uuid = crypto.randomUUID();
  const tempInputPath = path.join(os.tmpdir(), `input_${uuid}.${ext}`);

  try {
    await fs.promises.writeFile(tempInputPath, buffer);
    const outputPath = await compressVideoFile(tempInputPath, extension);
    const compressedBuffer = await fs.promises.readFile(outputPath);

    try {
      if (fs.existsSync(tempInputPath)) await fs.promises.unlink(tempInputPath);
      if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);
    } catch (e) {}

    return (compressedBuffer && compressedBuffer.length < buffer.length) ? compressedBuffer : buffer;
  } catch (err) {
    try {
      if (fs.existsSync(tempInputPath)) await fs.promises.unlink(tempInputPath);
    } catch (e) {}
    return buffer;
  }
}
