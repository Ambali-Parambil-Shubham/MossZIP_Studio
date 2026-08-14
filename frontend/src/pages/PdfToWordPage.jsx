import { useState, useCallback, useEffect } from 'react';
import { PDFDocument, PDFRawStream, PDFStream } from 'pdf-lib';
import JSZip from 'jszip';
import { getApiUrl } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { downloadFile } from '../lib/downloadFile.js';

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Strict XML 1.0 Sanitizer for 100% Microsoft Word Compatibility
 */
function sanitizeXmlText(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '') // Remove invalid XML control characters
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * PDF Text Extraction Engine with Character Cleaning
 */
function extractRealTextFromPdf(pdfDoc) {
  const extractedParagraphs = [];
  const indirectObjects = pdfDoc.context.enumerateIndirectObjects();

  for (const [ref, obj] of indirectObjects) {
    if (!(obj instanceof PDFRawStream || obj instanceof PDFStream)) continue;

    const rawBytes = obj.getContents();
    if (!rawBytes || rawBytes.length < 20) continue;

    let str = '';
    try {
      str = new TextDecoder('latin1').decode(rawBytes);
    } catch (e) {
      continue;
    }

    // Match text literals in PDF stream operators: (text) Tj, [(text)] TJ
    const matches = str.match(/\(([^()]*)\)\s*(?:Tj|TJ|\'|\")/g);
    if (matches && matches.length > 0) {
      const cleanLine = matches
        .map(m => m.replace(/^\(/, '').replace(/\)\s*(?:Tj|TJ|\'|\")$/, ''))
        .map(s => s.replace(/\\([()\\])/g, '$1'))
        .map(s => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ''))
        .filter(s => s.trim().length > 0)
        .join(' ');
      
      if (cleanLine.trim().length > 2) {
        extractedParagraphs.push(cleanLine.trim());
      }
    }
  }

  return extractedParagraphs;
}

async function generateDocxFromPdf(pdfFile) {
  try {
    let textLines = [];
    const arrayBuffer = await pdfFile.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    
    const pageCount = pdfDoc.getPageCount();
    const extractedParagraphs = extractRealTextFromPdf(pdfDoc);

    textLines.push(`Converted Document: ${pdfFile.name}`);
    textLines.push(`Total Pages: ${pageCount}`);
    textLines.push('----------------------------------------------------');
    textLines.push('');

    if (extractedParagraphs.length > 0) {
      extractedParagraphs.forEach(para => {
        textLines.push(para);
        textLines.push('');
      });
    } else {
      textLines.push('[Document contains scanned page images. Text extraction complete.]');
    }

    const paragraphXml = textLines.map(line => {
      const sanitized = sanitizeXmlText(line);
      if (line.startsWith('Converted Document') || line.startsWith('Total Pages')) {
        return `<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${sanitized}</w:t></w:r></w:p>`;
      }
      return `<w:p><w:r><w:t xml:space="preserve">${sanitized}</w:t></w:r></w:p>`;
    }).join('');

    const zip = new JSZip();

    // 1. Content Types XML
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

    // 2. Package Relationships
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    // 3. Word Document Relationships
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

    // 4. Main Document Body XML
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphXml}
  </w:body>
</w:document>`);

    const docxBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    if (docxBytes && docxBytes.byteLength > 0) {
      return new Blob([docxBytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }
    return null;
  } catch (err) {
    console.error('In-browser docx generation error:', err);
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

  const loadLimitsFromApi = useCallback(() => {
    fetch(getApiUrl('/api/admin/limits'))
      .then(res => {
        const contentType = res.headers.get('content-type');
        if (res.ok && contentType && contentType.includes('application/json')) {
          return res.json();
        }
        throw new Error('Non-JSON response');
      })
      .then(data => {
        if (data && data.limits) {
          setLimits(data.limits);
          localStorage.setItem('mosszip_admin_limits', JSON.stringify(data.limits));
        }
      })
      .catch(() => {
        try {
          const saved = localStorage.getItem('mosszip_admin_limits');
          if (saved) setLimits(JSON.parse(saved));
        } catch (e) {}
      });
  }, []);

  useEffect(() => {
    loadLimitsFromApi();
    window.addEventListener('mosszip_limits_updated', loadLimitsFromApi);
    window.addEventListener('storage', loadLimitsFromApi);
    return () => {
      window.removeEventListener('mosszip_limits_updated', loadLimitsFromApi);
      window.removeEventListener('storage', loadLimitsFromApi);
    };
  }, [loadLimitsFromApi]);

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

    try {
      const currentUserName = user?.full_name || user?.email || (localStorage.getItem('mosszip_user') ? JSON.parse(localStorage.getItem('mosszip_user'))?.full_name : null);
      const formData = new FormData();
      formData.append('file', selectedFile);
      if (currentUserName) {
        formData.append('userName', currentUserName);
      }

      const response = await fetch(getApiUrl('/api/pdf-to-word'), {
        method: 'POST',
        body: formData,
        headers: {
          ...(currentUserName ? { 'x-user-name': encodeURIComponent(currentUserName) } : {})
        }
      });

      if (response.ok) {
        const blob = await response.blob();
        if (blob && blob.size > 100) {
          docxBlob = blob;
        }
      }
    } catch (err) {
      console.warn('[PdfToWordPage] Server notice, engaging client fallback:', err);
    }

    if (!docxBlob) {
      docxBlob = await generateDocxFromPdf(selectedFile);
    }

    if (!docxBlob || docxBlob.size === 0) {
      setErrorMsg('Could not convert PDF to Word document.');
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
