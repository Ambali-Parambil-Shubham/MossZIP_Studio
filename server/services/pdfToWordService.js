import libre from 'libreoffice-convert';
import { createRequire } from 'module';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, PageBreak } from 'docx';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);

let createCanvas;
try {
  const napi = require('@napi-rs/canvas');
  createCanvas = napi.createCanvas;
} catch (e) {
  const nodeCanvas = require('canvas');
  createCanvas = nodeCanvas.createCanvas;
}

const convertAsync = (buf, format, filter) => new Promise((resolve, reject) => {
  libre.convert(buf, format, filter, (err, done) => {
    if (err) return reject(err);
    resolve(done);
  });
});

/**
 * Loads PDF document using PDF.js
 */
async function loadPdfDocument(pdfBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
  });
  return await loadingTask.promise;
}

/**
 * Extracts selectable Unicode text from all pages
 */
async function extractTextFromPdf(pdfDoc) {
  const pagesText = [];
  let totalChars = 0;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const lines = [];
    let lastY = null;
    let currentLine = '';

    for (const item of textContent.items) {
      if (!item.str) continue;
      const currentY = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 5) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = item.str;
      } else {
        currentLine += (currentLine ? ' ' : '') + item.str;
      }
      lastY = currentY;
    }
    if (currentLine.trim()) lines.push(currentLine.trim());

    const pageJoined = lines.join('\n');
    totalChars += pageJoined.trim().length;
    pagesText.push({ pageNum, lines });
  }

  return { totalChars, pagesText };
}

/**
 * Renders every page of a slide deck, presentation, or scanned PDF as high-resolution
 * graphics embedded directly into Microsoft Word with proper page breaks.
 */
async function renderPdfPagesToWordImages(pdfDoc) {
  const elements = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    try {
      const page = await pdfDoc.getPage(pageNum);
      // Scale 1.5 gives crisp ~150 DPI resolution for slides, circuits, and formulas
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');

      // Ensure clean white background
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, viewport.width, viewport.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      const imgBuffer = typeof canvas.encodeSync === 'function'
        ? canvas.encodeSync('jpeg', 85)
        : canvas.toBuffer('image/jpeg', { quality: 0.85 });

      // Standard Word page width ~ 595pt
      const targetWidth = 595;
      const targetHeight = Math.round((viewport.height / viewport.width) * targetWidth);

      elements.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: imgBuffer,
              transformation: { width: targetWidth, height: targetHeight },
            }),
          ],
          spacing: { after: 120 },
        })
      );

      if (pageNum < pdfDoc.numPages) {
        elements.push(
          new Paragraph({
            children: [new PageBreak()],
          })
        );
      }
    } catch (pageErr) {
      console.warn(`[PDFToWord] Warning: Page ${pageNum} rendering notice:`, pageErr.message);
    }
  }

  return elements;
}

/**
 * Converts PDF to a rich Microsoft Word (.docx) document.
 * Primary: LibreOffice Headless conversion.
 * Fallback: Adaptive Hybrid selectable text extraction + full-fidelity visual page reconstruction.
 */
export async function convertPdfToWord(pdfBuffer) {
  // Primary Attempt: LibreOffice Convert
  try {
    const docxBuffer = await convertAsync(pdfBuffer, '.docx', undefined);
    if (docxBuffer && docxBuffer.length > 500) {
      return docxBuffer;
    }
  } catch (libreErr) {
    console.warn('[PDFToWord] LibreOffice binary not present, engaging adaptive hybrid fallback engine.');
  }

  // Fallback: Adaptive Hybrid Engine
  try {
    const pdfDoc = await loadPdfDocument(pdfBuffer);
    const { totalChars, pagesText } = await extractTextFromPdf(pdfDoc);

    // 1. If substantial selectable text is present (>= 50 characters), reconstruct editable paragraphs
    if (totalChars >= 50) {
      const paragraphs = [];

      for (const page of pagesText) {
        if (pdfDoc.numPages > 1) {
          paragraphs.push(
            new Paragraph({
              text: `Page ${page.pageNum}`,
              heading: HeadingLevel.HEADING_2,
              spacing: { before: 200, after: 80 },
            })
          );
        }

        for (const line of page.lines) {
          if (!line) continue;

          // Detect potential headings
          if (line.length < 50 && /[A-Za-z]/.test(line) && line === line.toUpperCase()) {
            paragraphs.push(
              new Paragraph({
                text: line,
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 180, after: 80 },
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

        if (page.pageNum < pdfDoc.numPages) {
          paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
        }
      }

      if (paragraphs.length > 0) {
        const doc = new Document({
          sections: [{ properties: {}, children: paragraphs }],
        });
        const docxBytes = await Packer.toBuffer(doc);
        return Buffer.from(docxBytes);
      }
    }

    // 2. Scanned notes, presentation slides, diagrams, and math formulas (like BEEE notes):
    // Render high-resolution visual pages directly into Word!
    const visualElements = await renderPdfPagesToWordImages(pdfDoc);
    if (visualElements && visualElements.length > 0) {
      const doc = new Document({
        sections: [{
          properties: {
            page: {
              margin: {
                top: 720,
                right: 720,
                bottom: 720,
                left: 720,
              },
            },
          },
          children: visualElements,
        }],
      });
      const docxBytes = await Packer.toBuffer(doc);
      return Buffer.from(docxBytes);
    }

    throw new Error('Could not extract text or render pages from PDF.');
  } catch (err) {
    console.error('[PDFToWord] Adaptive fallback error:', err);
    throw new Error('Failed to convert PDF to Word document.');
  }
}
