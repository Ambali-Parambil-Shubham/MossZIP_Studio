import libre from 'libreoffice-convert';
import fs from 'fs';
import { createRequire } from 'module';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');

const convertAsync = (buf, format, filter) => new Promise((resolve, reject) => {
  libre.convert(buf, format, filter, (err, done) => {
    if (err) return reject(err);
    resolve(done);
  });
});

async function extractPdfText(pdfBuffer) {
  if (typeof pdfParseModule === 'function') {
    const res = await pdfParseModule(pdfBuffer);
    return { text: res.text || '', numPages: res.numpages || 1 };
  }

  if (pdfParseModule && pdfParseModule.PDFParse) {
    const parser = new pdfParseModule.PDFParse({ data: pdfBuffer });
    await parser.load();
    const res = await parser.getText();
    return { text: res.text || '', numPages: res.total || 1 };
  }

  return { text: '', numPages: 1 };
}

/**
 * Converts PDF to an editable Microsoft Word (.docx) document.
 * Primary: LibreOffice Headless conversion.
 * Fallback: PDF text extraction + docx Document builder.
 */
export async function convertPdfToWord(pdfBuffer) {
  // Primary Attempt: LibreOffice Convert
  try {
    const docxBuffer = await convertAsync(pdfBuffer, '.docx', undefined);
    if (docxBuffer && docxBuffer.length > 500) {
      return docxBuffer;
    }
  } catch (libreErr) {
    console.warn('[PDFToWord] LibreOffice binary not present, engaging docx fallback engine.');
  }

  // Fallback: Text extraction + docx Document Builder
  try {
    const { text: rawText, numPages } = await extractPdfText(pdfBuffer);
    const lines = rawText.split('\n');

    const paragraphs = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('-- ') && line.endsWith(' --')) {
        continue;
      }

      // Identify potential headings vs regular text
      if (line.length < 50 && /[A-Za-z]/.test(line) && (line === line.toUpperCase() || i === 0)) {
        paragraphs.push(
          new Paragraph({
            text: line,
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 100 },
          })
        );
      } else {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line,
                size: 24, // 12pt font
                font: 'Calibri',
              }),
            ],
            spacing: { after: 120 },
          })
        );
      }
    }

    // No selectable text found: this PDF is likely scanned/image-based and
    // requires OCR, which this pipeline does not perform. Say so honestly
    // instead of returning a misleading blank/generic document.
    const noticeParagraphs = [
      new Paragraph({
        children: [
          new TextRun({
            text: 'No selectable text was found in this PDF.',
            bold: true,
            font: 'Calibri',
            size: 26,
          }),
        ],
        spacing: { after: 120 },
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `This document (${numPages} page${numPages === 1 ? '' : 's'}) appears to be scanned or image-based. Automatic text conversion requires OCR, which is not currently available, so the original layout could not be reconstructed as editable text.`,
            font: 'Calibri',
            size: 22,
          }),
        ],
        spacing: { after: 120 },
      }),
    ];

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: paragraphs.length > 0 ? paragraphs : noticeParagraphs,
        },
      ],
    });

    const docxBytes = await Packer.toBuffer(doc);
    return Buffer.from(docxBytes);
  } catch (err) {
    console.error('[PDFToWord] Fallback error:', err);
    throw new Error('Failed to convert PDF to Word document.');
  }
}
