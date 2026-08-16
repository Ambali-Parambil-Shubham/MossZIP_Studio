import { useState, useCallback, useEffect } from 'react';
import { PDFDocument } from 'pdf-lib';
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

export default function MergePdfPage({ onRecord }) {
  const { user, requireAuth, showToast } = useAuth();
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [resultBlob, setResultBlob] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  // Limits State (with LocalStorage initial fallback)
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

  const handleFiles = useCallback((files) => {
    const validFiles = Array.from(files).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    
    if (limits && limits.limits_enabled && validFiles.length > limits.pdfs_per_request) {
      setErrorMsg(`You can compress a maximum of ${limits.pdfs_per_request} PDFs at a time.`);
      setSelectedFiles(validFiles.slice(0, limits.pdfs_per_request));
      return;
    }

    if (validFiles.length > 0) {
      setSelectedFiles(validFiles);
      setResultBlob(null);
      setErrorMsg(null);
    }
  }, [limits]);

  const handleFileChange = (e) => {
    if (e.target.files?.length) handleFiles(e.target.files);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  };

  const handleMerge = () => {
    requireAuth(() => {
      executeMerge();
    });
  };

  const executeMerge = async () => {
    if (selectedFiles.length < 2) {
      setErrorMsg('Please select at least 2 PDF files to merge.');
      return;
    }

    if (limits && limits.limits_enabled && selectedFiles.length > limits.pdfs_per_request) {
      setErrorMsg(`You can compress a maximum of ${limits.pdfs_per_request} PDFs at a time.`);
      return;
    }

    setLoading(true);
    setResultBlob(null);
    setErrorMsg(null);

    let mergedBlob = null;

    try {
      const currentUserName = user?.full_name || user?.email || (localStorage.getItem('mosszip_user') ? JSON.parse(localStorage.getItem('mosszip_user'))?.full_name : null);
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      if (currentUserName) {
        formData.append('userName', currentUserName);
      }

      const response = await fetch(getApiUrl('/api/merge-pdfs'), {
        method: 'POST',
        body: formData,
        headers: {
          ...(currentUserName ? { 'x-user-name': encodeURIComponent(currentUserName) } : {})
        }
      });

      if (response.ok) {
        const blob = await response.blob();
        if (blob && blob.size > 0 && (blob.type.includes('pdf') || blob.type === 'application/octet-stream')) {
          mergedBlob = blob;
        }
      }
    } catch (err) {
      console.warn('[MergePdfPage] Server merge notice, executing client-side engine fallback:', err);
    }

    if (!mergedBlob) {
      try {
        const mergedPdf = await PDFDocument.create();
        for (const file of selectedFiles) {
          const arrayBuffer = await file.arrayBuffer();
          const srcPdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
          const pageIndices = srcPdf.getPageIndices();
          const copiedPages = await mergedPdf.copyPages(srcPdf, pageIndices);
          copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        const pdfBytes = await mergedPdf.save({ useObjectStreams: true, addDefaultPage: false });
        mergedBlob = new Blob([pdfBytes], { type: 'application/pdf' });
      } catch (clientErr) {
        console.error('[MergePdfPage] Client PDF merging error:', clientErr);
        setErrorMsg('Could not merge selected PDF files. Please check if any file is encrypted or password-protected.');
        setLoading(false);
        return;
      }
    }

    setResultBlob(mergedBlob);

    const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    if (onRecord) {
      onRecord({
        id: Date.now(),
        type: 'Merge PDF',
        file: `${selectedFiles.length} PDFs Merged`,
        originalBits: totalSize * 8,
        compressedBits: mergedBlob.size * 8,
        ratio: Math.max(0, ((1 - (mergedBlob.size / totalSize)) * 100)),
        timestamp: new Date().toISOString(),
      });
    }
    setLoading(false);
  };

  const handleDownload = async () => {
    if (!resultBlob) return;
    const fileName = `merged_document_${Date.now()}.pdf`;
    await downloadFile(resultBlob, fileName);
    showToast('✅ Merged PDF downloaded successfully!');
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-display font-bold text-on-surface">Merge PDF Files</h1>
          {limits && limits.limits_enabled && (
            <div className="text-[11px] font-mono font-bold text-primary bg-primary/10 px-3 py-1 rounded-full border border-primary/20">
              PDFs selected: {selectedFiles.length} / {limits.pdfs_per_request}
            </div>
          )}
        </div>
        <p className="text-xs text-on-surface-muted mt-0.5">
          Combine multiple PDF files into one seamless PDF document.
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
          onClick={() => document.getElementById('pdf-merge-input')?.click()}
        >
          <input
            id="pdf-merge-input"
            type="file"
            multiple
            accept="application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-3 font-bold text-xl">
            📄
          </div>
          <p className="text-sm font-display font-bold text-on-surface">
            {selectedFiles.length > 0 ? `${selectedFiles.length} PDF(s) Selected` : 'Click or Drag PDFs Here'}
          </p>
          <p className="text-xs text-on-surface-subtle mt-1 font-medium">
            Select 2 or more PDFs to combine {limits && limits.limits_enabled && `(Max ${limits.pdfs_per_request} per request)`}
          </p>
        </div>

        {selectedFiles.length > 0 && (
          <div className="space-y-4">
            <div className="p-4 bg-surface-low rounded-xl border border-border/80 space-y-2 max-h-48 overflow-y-auto">
              {selectedFiles.map((file, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs font-display py-1 border-b border-border/40 last:border-0">
                  <span className="truncate font-semibold text-on-surface">{file.name}</span>
                  <span className="font-mono text-on-surface-subtle">{formatBytes(file.size)}</span>
                </div>
              ))}
            </div>

            <button
              onClick={handleMerge}
              disabled={loading}
              className="btn-primary w-full py-3 text-xs font-bold shadow-lg"
            >
              {loading ? 'Merging PDF Files...' : 'Merge PDFs Now'}
            </button>
          </div>
        )}

        {resultBlob && resultBlob.size > 0 && (
          <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
            <div>
              <p className="text-sm font-display font-bold text-emerald-900">Merged PDF Ready for Download</p>
              <p className="text-xs font-mono text-emerald-700">Size: {formatBytes(resultBlob.size)}</p>
            </div>
            <button onClick={handleDownload} className="btn-primary py-2.5 px-6 text-xs font-bold shadow-md">
              Download Merged PDF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
