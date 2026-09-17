import { useState, useCallback, useEffect } from 'react';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, PageBreak } from 'docx';
import { getApiUrl } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { downloadFile } from '../lib/downloadFile.js';

// Setup local offline PDF.js worker
if (typeof window !== 'undefined' && pdfjsLib?.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Adaptive Client-Side PDF-to-Word Engine
 * 1. For text PDFs: extracts Unicode text and builds formatted Word headings and paragraphs.
 * 2. For presentations, scanned notes, circuits & equations (like BEEE notes):
 *    renders every page on an in-browser canvas and embeds high-res figures with proper page breaks.
 */
async function generateDocxFromPdf(pdfFile) {
  try {
    const arrayBuffer = await pdfFile.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;

    // ── Phase 1: Try Text Extraction ──────────────────────────────────────────
    let totalChars = 0;
    const pagesText = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      let lastY = null;
      let currentLine = '';
      const pageLines = [];

      for (const item of textContent.items) {
        if (!item.str) continue;
        const currentY = item.transform ? Math.round(item.transform[5]) : null;
        if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 5) {
          if (currentLine.trim()) pageLines.push(currentLine.trim());
          currentLine = item.str;
        } else {
          currentLine += (currentLine ? ' ' : '') + item.str;
        }
        lastY = currentY;
      }
      if (currentLine.trim()) pageLines.push(currentLine.trim());

      const joined = pageLines.join('\n');
      totalChars += joined.trim().length;
      pagesText.push({ pageNum: i, lines: pageLines });
    }

    // If substantial selectable text is present (>= 50 chars), build editable text paragraphs
    if (totalChars >= 50) {
      const paragraphs = [];
      for (const page of pagesText) {
        if (pdf.numPages > 1) {
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
                children: [new TextRun({ text: line, size: 24, font: 'Calibri' })],
                spacing: { after: 120 },
              })
            );
          }
        }
        if (page.pageNum < pdf.numPages) {
          paragraphs.push(new Paragraph({ children: [new PageBreak()] }));
        }
      }

      if (paragraphs.length > 0) {
        const doc = new Document({
          sections: [{
            properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
            children: paragraphs,
          }],
        });
        return await Packer.toBlob(doc);
      }
    }

    // ── Phase 2: Visual Slide / Scanned Document Reconstruction ──────────────
    // When text streams are absent (diagrams, circuits, slides), render each page to canvas
    const elements = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, viewport.width, viewport.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob) continue;
      const buf = await blob.arrayBuffer();
      const uint8 = new Uint8Array(buf);

      const targetWidth = 595;
      const targetHeight = Math.round((viewport.height / viewport.width) * targetWidth);

      elements.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: uint8,
              transformation: { width: targetWidth, height: targetHeight },
            }),
          ],
          spacing: { after: 120 },
        })
      );

      if (i < pdf.numPages) {
        elements.push(new Paragraph({ children: [new PageBreak()] }));
      }
    }

    if (elements.length > 0) {
      const doc = new Document({
        sections: [{
          properties: {
            page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
          },
          children: elements,
        }],
      });
      return await Packer.toBlob(doc);
    }

    return null;
  } catch (err) {
    console.error('[PdfToWordPage] Client adaptive engine error:', err);
    return null;
  }
}

export default function PdfToWordPage({ onRecord }) {
  const { user, requireAuth, showToast } = useAuth();
  const [selectedFile, setSelectedFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resultBlob, setResultBlob] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  // Limits State
  const [limits, setLimits] = useState(() => {
    try {
      const saved = localStorage.getItem('mosszip_admin_limits');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      pdfs_per_request: 10,
      max_total_upload_mb: 1024,
      limits_enabled: true,
    };
  });

  const loadLimitsFromStorage = useCallback(() => {
    try {
      const saved = localStorage.getItem('mosszip_admin_limits');
      if (saved) {
        setLimits(JSON.parse(saved));
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    loadLimitsFromStorage();
    const handleUpdate = () => loadLimitsFromStorage();
    window.addEventListener('mosszip_limits_updated', handleUpdate);
    window.addEventListener('storage', handleUpdate);
    return () => {
      window.removeEventListener('mosszip_limits_updated', handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, [loadLimitsFromStorage]);

  const handleFile = useCallback((file) => {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    
    if (!isPdf) {
      setErrorMsg('Please select a valid PDF file.');
      return;
    }

    setSelectedFile(file);
    setResultBlob(null);
    setErrorMsg(null);
  }, []);

  const handleFileChange = (e) => {
    if (e.target.files?.[0]) handleFile(e.target.files[0]);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
  };

  const handleConvert = () => {
    requireAuth(() => {
      executeConvert();
    });
  };

  const executeConvert = async () => {
    if (!selectedFile) return;

    setLoading(true);
    setErrorMsg(null);
    setResultBlob(null);

    let docxBlob = null;
    let serverNotice = null;

    try {
      const currentUserName = user?.full_name || user?.email || (localStorage.getItem('mosszip_user') ? JSON.parse(localStorage.getItem('mosszip_user'))?.full_name : null);
      const formData = new FormData();
      formData.append('file', selectedFile);
      if (currentUserName) {
        formData.append('userName', currentUserName);
      }

      const targetUrl = getApiUrl('/api/pdf-to-word');
      const response = await fetch(targetUrl, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const blob = await response.blob();
        if (blob && blob.size > 100) {
          docxBlob = blob;
        } else {
          serverNotice = 'Server returned empty payload';
        }
      } else {
        const errJson = await response.json().catch(() => null);
        serverNotice = errJson?.message || `Server HTTP ${response.status}`;
      }
    } catch (err) {
      serverNotice = `Network notice (${err.message})`;
    }

    if (!docxBlob) {
      console.info('[PdfToWordPage] Running high-fidelity client converter. Server notice:', serverNotice);
      docxBlob = await generateDocxFromPdf(selectedFile);
    }

    if (!docxBlob || docxBlob.size === 0) {
      setErrorMsg(`Could not convert PDF to Word document.${serverNotice ? ` (${serverNotice})` : ''}`);
      setLoading(false);
      return;
    }

    setResultBlob(docxBlob);

    if (onRecord) {
      onRecord({
        id: Date.now(),
        type: 'PDF to Word',
        file: selectedFile.name,
        originalBits: selectedFile.size * 8,
        compressedBits: docxBlob.size * 8,
        ratio: 0,
        timestamp: new Date().toISOString(),
      });
    }
    setLoading(false);
  };

  const handleDownload = async () => {
    if (!resultBlob) return;
    const baseName = selectedFile?.name ? selectedFile.name.replace(/\.[^/.]+$/, '') : 'document';
    const fileName = `${baseName}_converted.docx`;
    await downloadFile(resultBlob, fileName);
    showToast(`✅ "${fileName}" downloaded successfully!`);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-display font-bold text-on-surface">PDF to Word Converter</h1>
          {limits && limits.limits_enabled && (
            <div className="text-[11px] font-mono font-bold text-primary bg-primary/10 px-3 py-1 rounded-full border border-primary/20">
              PDFs selected: {selectedFile ? 1 : 0} / 1
            </div>
          )}
        </div>
        <p className="text-xs text-on-surface-muted mt-0.5">
          Convert PDF documents into editable Word (.docx) format.
        </p>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs font-bold flex items-center justify-between shadow-md">
          <span>⚠️ {errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-amber-700 font-bold ml-4">✕</button>
        </div>
      )}

      <div className="card p-6 space-y-6">
        <div
          className={`rounded-2xl border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
            isDragging ? 'bg-[#E7EFEA] border-primary' : 'bg-[#FFFDF6] border-border/80 hover:bg-white hover:border-primary/60'
          }`}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
          onClick={() => document.getElementById('pdf-to-word-input')?.click()}
        >
          <input
            id="pdf-to-word-input"
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-3 font-bold text-xl">
            📝
          </div>
          <p className="text-sm font-display font-bold text-on-surface">
            {selectedFile ? selectedFile.name : 'Click or Drag PDF File Here'}
          </p>
          <p className="text-xs text-on-surface-subtle mt-1 font-medium">
            Select a PDF document to convert to editable Word (.docx)
          </p>
        </div>

        {selectedFile && (
          <div className="space-y-4">
            <div className="p-4 bg-surface-low rounded-xl border border-border/80 flex items-center justify-between text-xs font-display">
              <span className="truncate font-semibold text-on-surface">{selectedFile.name}</span>
              <span className="font-mono text-on-surface-subtle">{formatBytes(selectedFile.size)}</span>
            </div>

            <button
              onClick={handleConvert}
              disabled={loading}
              className="btn-primary w-full py-3 text-xs font-bold shadow-lg"
            >
              {loading ? 'Converting PDF to Word...' : 'Convert to Word (.docx)'}
            </button>
          </div>
        )}

        {resultBlob && resultBlob.size > 0 && (
          <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
            <div>
              <p className="text-sm font-display font-bold text-emerald-900">Word Document Ready</p>
              <p className="text-xs font-mono text-emerald-700">Size: {formatBytes(resultBlob.size)}</p>
            </div>
            <button onClick={handleDownload} className="btn-primary py-2.5 px-6 text-xs font-bold shadow-md">
              Download Word File
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
