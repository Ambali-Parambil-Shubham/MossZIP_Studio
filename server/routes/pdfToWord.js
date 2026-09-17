import express from 'express';
import multer from 'multer';
import { convertPdfToWord } from '../services/pdfToWordService.js';
import { validateCompressionLimits, rateLimiterMiddleware } from '../middleware/limitsMiddleware.js';
import { fileSecurityMiddleware, validateFileSignature } from '../middleware/securityMiddleware.js';
import { addAuditLog } from './admin.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.post('/', rateLimiterMiddleware, upload.single('file'), fileSecurityMiddleware, validateCompressionLimits, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No PDF file uploaded.' });
    }

    const isValidPdf = await validateFileSignature(req.file.buffer, 'pdf');
    if (!isValidPdf) {
      return res.status(400).json({ status: 'error', message: 'The uploaded file is not a valid PDF document.' });
    }

    const rawUserName = req.headers['x-user-name'] ? decodeURIComponent(req.headers['x-user-name']) : (req.body?.userName || 'Guest');
    const pdfBuffer = req.file.buffer;

    // Call dual-engine converter service (LibreOffice primary + docx Packer fallback)
    const docxBuffer = await convertPdfToWord(pdfBuffer);

    if (!docxBuffer || docxBuffer.length === 0) {
      return res.status(500).json({ status: 'error', message: 'Generated DOCX document is empty.' });
    }

    addAuditLog({
      user: rawUserName,
      type: 'PDF to Word',
      file: `${req.file.originalname} -> .docx`,
      originalBits: req.file.size * 8,
      compressedBits: docxBuffer.length * 8,
      ratio: Math.max(0, ((1 - docxBuffer.length / req.file.size) * 100)),
      ip: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1',
    });

    const outputName = req.file.originalname.replace(/\.pdf$/i, '') + '.docx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(outputName)}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
    return res.send(docxBuffer);
  } catch (err) {
    console.error('[PdfToWord Route Error]:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to convert PDF to Word document.' });
  }
});

export default router;
