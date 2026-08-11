import express from 'express';
import multer from 'multer';
import mime from 'mime-types';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { compressPdf } from '../services/pdfCompressor.js';
import { compressImage } from '../services/imageCompressor.js';
import { compressOfficeDoc } from '../services/officeCompressor.js';
import { compressVideoFile } from '../services/videoCompressor.js';
import { compressAudioFile } from '../services/audioCompressor.js';
import { packHuffmanBytes } from '../services/huffmanCompressor.js';
import { validateCompressionLimits, rateLimiterMiddleware } from '../middleware/limitsMiddleware.js';
import { addAuditLog } from './admin.js';

import { fileSecurityMiddleware } from '../middleware/securityMiddleware.js';

const router = express.Router();

// Disk storage engine to support 5GB+ massive payloads without RAM exhaustion
const uploadDir = path.join(os.tmpdir(), 'mosszip_uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 2048 * 1024 * 1024 } // Safe 2GB max single file cap
});

router.post('/', rateLimiterMiddleware, upload.single('file'), fileSecurityMiddleware, validateCompressionLimits, async (req, res) => {
  let reqFilePath = null;
  let outFilePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { originalname, path: filePath, mimetype, size } = req.file;
    reqFilePath = filePath;

    const ext = originalname.split('.').pop()?.toLowerCase() || '';
    const baseName = originalname.includes('.') 
      ? originalname.slice(0, originalname.lastIndexOf('.'))
      : originalname;

    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    
    // 1. VIDEO COMPRESSION PIPELINE (5GB+ Direct Disk Streaming)
    const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', '3gp', 'm4v', 'ts', 'mpg', 'mpeg'];
    if (videoExts.includes(ext) || (mimetype && mimetype.startsWith('video/'))) {
      outFilePath = await compressVideoFile(reqFilePath, ext);
      const outStat = await fs.promises.stat(outFilePath).catch(() => null);
      const outSize = outStat ? outStat.size : size;
      const outputFilename = `${baseName}_compressed.mp4`;
      const ratio = size > 0 ? Math.max(0, ((1 - (outSize / size)) * 100)) : 0;

      addAuditLog({
        user: `Client (${ip})`,
        ip: ip,
        type: 'Video Compression',
        file: originalname,
        originalBits: size * 8,
        compressedBits: outSize * 8,
        ratio: ratio,
      });

      res.setHeader('X-Original-Size', size);
      res.setHeader('X-Compressed-Size', outSize);
      res.setHeader('Access-Control-Expose-Headers', 'X-Original-Size, X-Compressed-Size, Content-Disposition');

      res.on('finish', async () => {
        try {
          if (reqFilePath && fs.existsSync(reqFilePath)) await fs.promises.unlink(reqFilePath);
          if (outFilePath && fs.existsSync(outFilePath)) await fs.promises.unlink(outFilePath);
        } catch (e) {}
      });

      return res.download(path.resolve(outFilePath), outputFilename, (err) => {
        if (err && !res.headersSent) {
          console.error('[VideoDownload] Stream error:', err);
          res.status(500).json({ error: 'Video download failed.' });
        }
      });
    }

    // 2. AUDIO COMPRESSION PIPELINE (MP3, WAV, AAC, M4A, FLAC, OGG, WMA, OPUS)
    const audioExts = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma', 'opus', 'aiff', 'mka'];
    if (audioExts.includes(ext) || (mimetype && mimetype.startsWith('audio/'))) {
      const audioResult = await compressAudioFile(reqFilePath, ext);
      outFilePath = audioResult.path;
      const outExt = audioResult.ext || 'mp3';
      const outStat = await fs.promises.stat(outFilePath).catch(() => null);
      const outSize = outStat ? outStat.size : size;
      const outputFilename = `${baseName}_compressed.${outExt}`;
      const ratio = size > 0 ? Math.max(0, ((1 - (outSize / size)) * 100)) : 0;

      addAuditLog({
        user: `Client (${ip})`,
        ip: ip,
        type: 'Audio Compression',
        file: originalname,
        originalBits: size * 8,
        compressedBits: outSize * 8,
        ratio: ratio,
      });

      res.setHeader('X-Original-Size', size);
      res.setHeader('X-Compressed-Size', outSize);
      res.setHeader('Access-Control-Expose-Headers', 'X-Original-Size, X-Compressed-Size, Content-Disposition');

      res.on('finish', async () => {
        try {
          if (reqFilePath && fs.existsSync(reqFilePath)) await fs.promises.unlink(reqFilePath);
          if (outFilePath && fs.existsSync(outFilePath)) await fs.promises.unlink(outFilePath);
        } catch (e) {}
      });

      return res.download(path.resolve(outFilePath), outputFilename, (err) => {
        if (err && !res.headersSent) {
          console.error('[AudioDownload] Stream error:', err);
          res.status(500).json({ error: 'Audio download failed.' });
        }
      });
    }

    // 3. DOCUMENT, IMAGE, OFFICE & TEXT PIPELINES
    const buffer = await fs.promises.readFile(reqFilePath);
    let outputBuffer;
    let outputFilename;
    let outputMimeType;
    let typeName = 'File Compress';

    const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'tiff', 'avif', 'heic'];
    const officeExts = ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub'];

    if (ext === 'pdf' || mimetype === 'application/pdf') {
      outputBuffer = await compressPdf(buffer);
      outputFilename = `${baseName}_compressed.pdf`;
      outputMimeType = 'application/pdf';
      typeName = 'PDF Compression';
    } else if (imageExts.includes(ext) || (mimetype && mimetype.startsWith('image/'))) {
      outputBuffer = await compressImage(buffer, ext);
      outputFilename = `${baseName}_compressed.${ext}`;
      outputMimeType = mime.lookup(ext) || mimetype;
      typeName = 'Image Compression';
    } else if (officeExts.includes(ext)) {
      outputBuffer = await compressOfficeDoc(buffer);
      outputFilename = `${baseName}_compressed.${ext}`;
      outputMimeType = mime.lookup(ext) || mimetype;
      typeName = 'Office Doc Compress';
    } else {
      outputBuffer = packHuffmanBytes(buffer);
      outputFilename = `${baseName}_compressed.huff`;
      outputMimeType = 'application/x-huffman';
      typeName = 'Huffman Encoding';
    }

    const ratio = buffer.length > 0 ? Math.max(0, ((1 - (outputBuffer.length / buffer.length)) * 100)) : 0;

    // Add to global admin audit log
    addAuditLog({
      user: `Client (${ip})`,
      ip: ip,
      type: typeName,
      file: originalname,
      originalBits: buffer.length * 8,
      compressedBits: outputBuffer.length * 8,
      ratio: ratio,
    });

    res.setHeader('Content-Type', outputMimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(outputFilename)}"`);
    res.setHeader('X-Original-Size', buffer.length);
    res.setHeader('X-Compressed-Size', outputBuffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'X-Original-Size, X-Compressed-Size, Content-Disposition');

    // Clean up uploaded file
    try {
      if (reqFilePath && fs.existsSync(reqFilePath)) await fs.promises.unlink(reqFilePath);
    } catch (e) {}

    return res.send(outputBuffer);
  } catch (err) {
    console.error('[POST /api/compress] Error:', err);
    try {
      if (reqFilePath && fs.existsSync(reqFilePath)) await fs.promises.unlink(reqFilePath);
      if (outFilePath && fs.existsSync(outFilePath)) await fs.promises.unlink(outFilePath);
    } catch (e) {}
    return res.status(500).json({ error: err.message || 'Compression failed.' });
  }
});

export default router;
