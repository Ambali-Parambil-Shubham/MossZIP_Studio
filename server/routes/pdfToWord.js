import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { convertPdfToWord } from '../services/pdfToWordService.js';
import { validateCompressionLimits, rateLimiterMiddleware } from '../middleware/limitsMiddleware.js';
import { fileSecurityMiddleware } from '../middleware/securityMiddleware.js';
import { addAuditLog } from './admin.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.post('/', rateLimiterMiddleware, upload.single('file'), validateCompressionLimits, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No PDF file uploaded.' });
    }

    const rawUserName = req.headers['x-user-name'] ? decodeURIComponent(req.headers['x-user-name']) : (req.body?.userName || 'Guest');
    const pdfBuffer = req.file.buffer;

    let parsedText = '';
    let numPages = 1;

    try {
      const data = await pdfParse(pdfBuffer);
      parsedText = data.text || '';
      numPages = data.numpages || 1;
    } catch (parseErr) {
      console.warn('[PdfToWord] PDF parse notice:', parseErr.message);
    }

    const paragraphs = [];
    const lines = parsedText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length > 0) {
      lines.forEach(line => {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line,
                font: 'Calibri',
                size: 24, // 12pt
              }),
            ],
            spacing: { after: 120 },
          })
        );
      });
    } else {
      // Scanned/Image PDF notice fallback page
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[Scanned PDF Document — ${numPages} Page(s)]`,
              bold: true,
              font: 'Calibri',
              size: 28,
            }),
          ],
          spacing: { after: 200 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: `Original File: ${req.file.originalname}`,
              italic: true,
              font: 'Calibri',
              size: 22,
            }),
          ],
          spacing: { after: 120 },
        })
      );
    }

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: paragraphs,
        },
      ],
    });

    const docxBuffer = await Packer.toBuffer(doc);

    addAuditLog({
      user: rawUserName,
      type: 'PDF to Word',
      file: `${req.file.originalname} -> .docx`,
      originalBits: req.file.size * 8,
      compressedBits: docxBuffer.length * 8,
      ratio: Math.max(0, ((1 - docxBuffer.length / req.file.size) * 100)),
      ip: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1',
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(req.file.originalname.replace(/\.pdf$/i, '.docx'))}"`);
    return res.send(docxBuffer);
  } catch (err) {
    console.error('[PdfToWord Error]:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to convert PDF to Word document.' });
  }
});

export default router;
