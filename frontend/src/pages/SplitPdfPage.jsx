import { useState, useCallback, useEffect } from 'react';
import { PDFDocument } from 'pdf-lib';
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

export default function SplitPdfPage({ onRecord }) {
  const { user, requireAuth, showToast } = useAuth();
  const [selectedFile, setSelectedFile] = useState(null);
  const [totalPages, setTotalPages] = useState(0);
  const [splitMode, setSplitMode] = useState('range'); // 'range' | 'single'
  const [pageRange, setPageRange] = useState(''); // e.g. "1-3, 5"
  const [loading, setLoading] = useState(false);
  const [resultBlob, setResultBlob] = useState(null);
  const [resultFilename, setResultFilename] = useState('');
  const [errorMsg, setErrorMsg] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(async (file) => {
    if (!file || (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf'))) {
      setErrorMsg('Please select a valid PDF file.');
      return;
    }

    try {
      setLoading(true);
      setErrorMsg(null);
      setResultBlob(null);

      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
      const count = pdfDoc.getPageCount();

      setSelectedFile(file);
      setTotalPages(count);
      setPageRange(`1-${count}`);
    } catch (err) {
      console.error('[SplitPDF Load Error]:', err);
      setErrorMsg('Failed to read PDF pages. Document may be password protected.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFileChange = (e) => {
    if (e.target.files?.length) handleFile(e.target.files[0]);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) handleFile(e.dataTransfer.files[0]);
  };

  const handleSplit = () => {
    requireAuth(() => {
      executeSplit();
    });
  };

  const executeSplit = async () => {
    if (!selectedFile || totalPages === 0) return;

    setLoading(true);
    setErrorMsg(null);

    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const srcDoc = await PDFDocument.load(arrayBuffer);
      const baseName = selectedFile.name.replace(/\.[^/.]+$/, '');

      if (splitMode === 'single') {
        // Extract every single page into a ZIP archive
        const zip = new JSZip();

        for (let i = 0; i < totalPages; i++) {
          const subDoc = await PDFDocument.create();
          const [copiedPage] = await subDoc.copyPages(srcDoc, [i]);
          subDoc.addPage(copiedPage);

          const pdfBytes = await subDoc.save();
          zip.file(`${baseName}_page_${i + 1}.pdf`, pdfBytes);
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        setResultBlob(zipBlob);
        const outName = `${baseName}_split_pages.zip`;
        setResultFilename(outName);

        if (onRecord) {
          onRecord({
            type: 'Split PDF',
            file: outName,
            originalBits: selectedFile.size * 8,
            compressedBits: zipBlob.size * 8,
            ratio: Math.max(0, ((1 - zipBlob.size / selectedFile.size) * 100)),
          });
        }
      } else {
        // Extract specific page ranges
        const targetPages = new Set();
        const parts = pageRange.split(',');

        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed.includes('-')) {
            const [startStr, endStr] = trimmed.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (!isNaN(start) && !isNaN(end)) {
              for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                targetPages.add(i - 1);
              }
            }
          } else {
            const pageNum = parseInt(trimmed, 10);
            if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
              targetPages.add(pageNum - 1);
            }
          }
        }

        const pageIndices = Array.from(targetPages).sort((a, b) => a - b);
        if (pageIndices.length === 0) {
          throw new Error('Please enter valid page numbers within range.');
        }

        const splitDoc = await PDFDocument.create();
        const copiedPages = await splitDoc.copyPages(srcDoc, pageIndices);
        copiedPages.forEach(p => splitDoc.addPage(p));

        const splitBytes = await splitDoc.save();
        const pdfBlob = new Blob([splitBytes], { type: 'application/pdf' });

        setResultBlob(pdfBlob);
        const outName = `${baseName}_extracted.pdf`;
        setResultFilename(outName);

        if (onRecord) {
          onRecord({
            type: 'Split PDF',
            file: outName,
            originalBits: selectedFile.size * 8,
            compressedBits: pdfBlob.size * 8,
            ratio: Math.max(0, ((1 - pdfBlob.size / selectedFile.size) * 100)),
          });
        }
      }
    } catch (err) {
      console.error('[SplitPDF Error]:', err);
      setErrorMsg(err.message || 'Failed to split PDF file.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!resultBlob || !resultFilename) return;
    await downloadFile(resultBlob, resultFilename);
    showToast(`✅ "${resultFilename}" downloaded successfully!`);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-display font-bold text-on-surface">Split PDF Document</h1>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-primary/10 text-primary font-bold border border-primary/20">
            PDF Page Extractor
          </span>
        </div>
        <p className="text-xs text-on-surface-subtle mt-0.5">
          Extract page ranges or split every page into a standalone document.
        </p>
      </div>

      {/* File Drop Zone */}
      <div className="card p-4 sm:p-6 space-y-4">
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center transition-all cursor-pointer ${
            isDragging
              ? 'border-primary bg-primary/5 scale-[0.99]'
              : 'border-border hover:border-primary/50 hover:bg-surface-container/50'
          }`}
        >
          <input
            type="file"
            accept=".pdf,application/pdf"
            onChange={handleFileChange}
            className="hidden"
            id="split-pdf-input"
          />
          <label htmlFor="split-pdf-input" className="cursor-pointer space-y-2 block">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto text-xl font-bold">
              ✂️
            </div>
            <p className="text-sm font-display font-bold text-on-surface">
              {selectedFile ? selectedFile.name : 'Select or Drop a PDF File'}
            </p>
            <p className="text-xs text-on-surface-subtle">
              {selectedFile
                ? `${formatBytes(selectedFile.size)} • ${totalPages} Pages Loaded`
                : 'Upload a PDF document to split'}
            </p>
          </label>
        </div>

        {selectedFile && (
          <div className="space-y-4 pt-2 border-t border-border/60">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setSplitMode('range')}
                className={`p-3 rounded-xl border text-xs font-display text-left transition-all ${
                  splitMode === 'range'
                    ? 'border-primary bg-primary/10 text-primary font-bold'
                    : 'border-border text-on-surface-subtle hover:bg-surface-container'
                }`}
              >
                <div className="font-bold text-on-surface mb-0.5">Custom Page Range</div>
                <div className="text-[11px] opacity-80">Extract selected pages (e.g. 1-3, 5)</div>
              </button>

              <button
                type="button"
                onClick={() => setSplitMode('single')}
                className={`p-3 rounded-xl border text-xs font-display text-left transition-all ${
                  splitMode === 'single'
                    ? 'border-primary bg-primary/10 text-primary font-bold'
                    : 'border-border text-on-surface-subtle hover:bg-surface-container'
                }`}
              >
                <div className="font-bold text-on-surface mb-0.5">Split All Pages to ZIP</div>
                <div className="text-[11px] opacity-80">Save every single page as individual PDF</div>
              </button>
            </div>

            {splitMode === 'range' && (
              <div className="space-y-1">
                <label className="text-xs font-display font-semibold text-on-surface">
                  Pages to Extract (Total: {totalPages} pages)
                </label>
                <input
                  type="text"
                  value={pageRange}
                  onChange={(e) => setPageRange(e.target.value)}
                  placeholder={`e.g. 1-${Math.min(3, totalPages)}, ${totalPages}`}
                  className="input-field w-full text-xs py-2 px-3 font-mono"
                />
              </div>
            )}

            <button
              onClick={handleSplit}
              disabled={loading}
              className="btn-primary w-full py-3 text-xs font-display font-bold shadow-md disabled:opacity-50"
            >
              {loading ? 'Processing Split...' : '✂️ Split PDF Now'}
            </button>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-display">
            ⚠️ {errorMsg}
          </div>
        )}
      </div>

      {/* Result Section */}
      {resultBlob && (
        <div className="card p-6 bg-emerald-50/50 border-emerald-200 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-display font-bold text-emerald-900">
                PDF Split Successfully!
              </p>
              <p className="text-xs text-emerald-700 font-mono mt-0.5">
                Output: {resultFilename} ({formatBytes(resultBlob.size)})
              </p>
            </div>
            <button
              onClick={handleDownload}
              className="btn-primary py-2.5 px-6 text-xs font-bold shadow-md whitespace-nowrap"
            >
              Download Output
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
