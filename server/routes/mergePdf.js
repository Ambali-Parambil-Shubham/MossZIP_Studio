import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { mergePdfs } from '../services/mergePdfService.js';
import { validateCompressionLimits, rateLimiterMiddleware } from '../middleware/limitsMiddleware.js';
import { addAuditLog } from './admin.js';

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'server', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `merge_${Date.now()}_${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`),
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
        message: 'No PDF files uploaded for merging.',
      });
    }

    for (const file of uploadedFiles) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext !== '.pdf' && file.mimetype !== 'application/pdf') {
        return res.status(400).json({
          success: false,
          message: `File '${file.originalname}' is not a valid PDF document.`,
        });
      }
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
      type: 'Merge PDF',
      file: `${uploadedFiles.length} PDFs Merged`,
      originalBits: totalOrigBytes * 8,
      compressedBits: mergedBuffer.length * 8,
      ratio: Math.max(0, ((1 - (mergedBuffer.length / totalOrigBytes)) * 100)),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="merged-document.pdf"');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
    return res.send(mergedBuffer);
  } catch (err) {
    console.error('[POST /api/merge-pdfs] Error:', err);
    return res.status(400).json({
      success: false,
      message: err.message || 'Merging PDFs failed.',
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
