import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { convertImagesToPdf } from '../services/imageToPdfService.js';
import { validateCompressionLimits, rateLimiterMiddleware } from '../middleware/limitsMiddleware.js';
import { addAuditLog } from './admin.js';

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'server', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `img_${Date.now()}_${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.post('/', rateLimiterMiddleware, upload.array('files', 100), validateCompressionLimits, async (req, res) => {
  const uploadedFiles = req.files || [];

  try {
    if (uploadedFiles.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No image files uploaded.',
      });
    }

    const rawClientUser = req.headers['x-user-name'] || req.body?.userName || req.headers['user-name'];
    let clientName = null;
    if (rawClientUser && typeof rawClientUser === 'string') {
      try { clientName = decodeURIComponent(rawClientUser).trim(); } catch (e) { clientName = rawClientUser.trim(); }
    }
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userIdentifier = (clientName && clientName !== 'Guest' && clientName !== 'null' && clientName.length > 0)
      ? `${clientName} (${ip})`
      : `User (${ip})`;
    const totalOrigBytes = uploadedFiles.reduce((acc, f) => acc + f.size, 0);

    addAuditLog({
      user: userIdentifier,
      ip: ip,
      type: 'Image to PDF',
      file: `${uploadedFiles.length} Images`,
      originalBits: totalOrigBytes * 8,
      compressedBits: pdfBuffer.length * 8,
      ratio: Math.max(0, ((1 - (pdfBuffer.length / totalOrigBytes)) * 100)),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="images-to-pdf.pdf"');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[POST /api/image-to-pdf] Error:', err);
    return res.status(400).json({
      success: false,
      message: err.message || 'Image to PDF conversion failed.',
    });
  } finally {
    for (const file of uploadedFiles) {
      if (file.path && fs.existsSync(file.path)) {
        try { await fs.promises.unlink(file.path); } catch (e) {}
      }
    }
  }
});

export default router;
