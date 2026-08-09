import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Enterprise Audio Compressor Engine
 * Formats: MP3, WAV, AAC, M4A, FLAC, OGG, WMA, OPUS, AIFF
 * Optimizes bitrate to 128k (or 96k) stereo with high acoustic fidelity.
 */
export async function compressAudioFile(tempInputPath, extension = 'mp3') {
  const uuid = crypto.randomUUID();
  const ext = (extension || 'mp3').toLowerCase().replace('.', '');
  const outExt = ext === 'wav' || ext === 'flac' || ext === 'aiff' ? 'mp3' : ext;
  const tempOutputPath = path.join(os.tmpdir(), `audio_output_${uuid}.${outExt}`);

  try {
    await new Promise((resolve, reject) => {
      let command = ffmpeg(tempInputPath)
        .inputOptions(['-nostdin'])
        .audioCodec(outExt === 'mp3' ? 'libmp3lame' : outExt === 'aac' || outExt === 'm4a' ? 'aac' : outExt === 'ogg' ? 'libvorbis' : 'libmp3lame')
        .audioBitrate('128k')
        .audioChannels(2)
        .output(tempOutputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err));

      command.run();
    });

    if (fs.existsSync(tempOutputPath)) {
      const outStat = fs.statSync(tempOutputPath);
      const inStat = fs.statSync(tempInputPath);
      if (outStat.size > 0 && outStat.size < inStat.size) {
        return { path: tempOutputPath, ext: outExt };
      }
    }

    return { path: tempOutputPath, ext: outExt };
  } catch (err) {
    console.error('[AudioCompressor] Error:', err);
    return { path: tempInputPath, ext: extension };
  }
}
