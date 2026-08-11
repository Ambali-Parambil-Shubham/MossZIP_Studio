import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { convertPdfToWord } from '../services/pdfToWordService.js';
import { validateCompressionLimits, rateLimiterMiddleware } from '../middleware/limitsMiddleware.js';
import { addAuditLog } from './admin.js';

const router = express.Router();

const uploadDir = path.join(process.cwd(), 'server', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `pdf_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`),
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.post('/', rateLimiterMiddleware, upload.single('file'), validateCompressionLimits, async (req, res) => {
  const uploadedFile = req.file;

  try {
    if (!uploadedFile) {
      return res.status(400).json({
        success: false,
        message: 'No PDF file uploaded.',
      });
    }

    const fileBuffer = await fs.promises.readFile(uploadedFile.path);
    const docxBuffer = await convertPdfToWord(fileBuffer);

    const origName = uploadedFile.originalname || 'document.pdf';
    const baseName = origName.includes('.')
      ? origName.slice(0, origName.lastIndexOf('.'))
      : 'document';

    const rawClientUser = req.headers['x-user-name'] || req.body?.userName || req.headers['user-name'];
    let clientName = null;
    if (rawClientUser && typeof rawClientUser === 'string') {
      try { clientName = decodeURIComponent(rawClientUser).trim(); } catch (e) { clientName = rawClientUser.trim(); }
    }
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const userIdentifier = (clientName && clientName !== 'Guest' && clientName !== 'null' && clientName.length > 0)
      ? `${clientName} (${ip})`
      : `User (${ip})`;

    addAuditLog({
      user: userIdentifier,
      ip: ip,
      type: 'PDF to Word',
      file: origName,
      originalBits: fileBuffer.length * 8,
      compressedBits: docxBuffer.length * 8,
      ratio: 0,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}-converted.docx"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
    return res.send(docxBuffer);
  } catch (err) {
    console.error('[POST /api/pdf-to-word] Error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'PDF to Word conversion failed.',
    });
  } finally {
    if (uploadedFile?.path && fs.existsSync(uploadedFile.path)) {
      try { await fs.promises.unlink(uploadedFile.path); } catch (e) {}
    }
  }
});

export default router;
