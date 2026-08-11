import { useState, useCallback, useEffect } from 'react';
import { PDFDocument } from 'pdf-lib';
import { supabase } from '../lib/supabaseClient.js';
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

async function imageFileToJpgBuffer(file) {
  try {
    const rawBuffer = await file.arrayBuffer();
    const blob = new Blob([rawBuffer], { type: file.type || 'image/png' });
    const img = await createImageBitmap(blob);

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const jpegBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return {
      buffer: await jpegBlob.arrayBuffer(),
      width: img.width,
      height: img.height,
    };
  } catch (err) {
    return null;
  }
}

async function generatePdfFromImages(files) {
  try {
    const pdfDoc = await PDFDocument.create();
    for (const file of files) {
      const rawBuffer = await file.arrayBuffer();
      const ext = file.name.split('.').pop()?.toLowerCase();
      let image = null;

      try {
        if (ext === 'png') {
          image = await pdfDoc.embedPng(rawBuffer);
        } else {
          image = await pdfDoc.embedJpg(rawBuffer);
        }
      } catch (e) {
        // Fallback to HTML5 Canvas re-encoding (handles screenshots, 16-bit PNGs, WEBP, BMP, etc.)
        const canvasJpg = await imageFileToJpgBuffer(file);
        if (canvasJpg && canvasJpg.buffer) {
          image = await pdfDoc.embedJpg(canvasJpg.buffer).catch(() => null);
        }
      }

      if (image) {
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });
      }
    }

    if (pdfDoc.getPageCount() === 0) return null;

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false });
    return new Blob([pdfBytes], { type: 'application/pdf' });
  } catch (err) {
    console.error('In-browser Image to PDF error:', err);
    return null;
  }
}

export default function ImageToPdfPage({ onRecord }) {
  const { requireAuth, showToast } = useAuth();
  const [selectedFiles, setSelectedFiles] = useState([]);
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
      images_per_request: 10,
      max_total_upload_mb: 1024,
      limits_enabled: true,
    };
  });

  const loadLimitsFromApi = useCallback(async () => {
    if (supabase) {
      try {
        const { data } = await supabase.from('app_users').select('*').eq('mobile', 'SYSTEM_LIMITS');
        if (data && data.length > 0 && data[0].mpin) {
          const cloudLimits = JSON.parse(data[0].mpin);
          if (cloudLimits && cloudLimits.images_per_request) {
            setLimits(cloudLimits);
            localStorage.setItem('mosszip_admin_limits', JSON.stringify(cloudLimits));
            return;
          }
        }
      } catch (e) {}
    }

    try {
      const res = await fetch(getApiUrl('/api/admin/limits'));
      if (res.ok) {
        const data = await res.json();
        if (data && data.limits) {
          setLimits(data.limits);
          localStorage.setItem('mosszip_admin_limits', JSON.stringify(data.limits));
          return;
        }
      }
    } catch (e) {}

    try {
      const saved = localStorage.getItem('mosszip_admin_limits');
      if (saved) setLimits(JSON.parse(saved));
    } catch (e) {}
  }, []);

  useEffect(() => {
    loadLimitsFromApi();
    window.addEventListener('mosszip_limits_updated', loadLimitsFromApi);
    window.addEventListener('storage', loadLimitsFromApi);
    const interval = setInterval(loadLimitsFromApi, 2500);
    return () => {
      window.removeEventListener('mosszip_limits_updated', loadLimitsFromApi);
      window.removeEventListener('storage', loadLimitsFromApi);
      clearInterval(interval);
    };
  }, [loadLimitsFromApi]);

  const handleFiles = useCallback((files) => {
    const validFiles = Array.from(files).filter(f => f.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|bmp)$/i.test(f.name));
    
    if (limits && limits.limits_enabled && validFiles.length > limits.images_per_request) {
      setErrorMsg(`You can compress a maximum of ${limits.images_per_request} images at a time.`);
      setSelectedFiles(validFiles.slice(0, limits.images_per_request));
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

  const handleConvert = () => {
    requireAuth(() => {
      executeConvert();
    });
  };

  const executeConvert = async () => {
    if (selectedFiles.length === 0) return;

    if (limits && limits.limits_enabled && selectedFiles.length > limits.images_per_request) {
      setErrorMsg(`You can compress a maximum of ${limits.images_per_request} images at a time.`);
      return;
    }

    setLoading(true);
    setResultBlob(null);
    setErrorMsg(null);

    let pdfBlob = null;

    try {
      const currentUserName = user?.full_name || user?.email || (localStorage.getItem('mosszip_user') ? JSON.parse(localStorage.getItem('mosszip_user'))?.full_name : null);
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      if (currentUserName) {
        formData.append('userName', currentUserName);
      }

      const response = await fetch(getApiUrl('/api/image-to-pdf'), {
        method: 'POST',
        body: formData,
        headers: {
          ...(currentUserName ? { 'x-user-name': encodeURIComponent(currentUserName) } : {})
        }
      });

      if (response.ok) {
        const blob = await response.blob();
        if (blob && blob.size > 0 && (blob.type.includes('pdf') || blob.type === 'application/octet-stream')) {
          pdfBlob = blob;
        }
      }
    } catch (err) {
      console.warn('[ImageToPdfPage] Server notice, engaging client fallback:', err);
    }

    if (!pdfBlob) {
      pdfBlob = await generatePdfFromImages(selectedFiles);
    }

    if (!pdfBlob || pdfBlob.size === 0) {
      setErrorMsg('Could not convert images to PDF document.');
      setLoading(false);
      return;
    }

    setResultBlob(pdfBlob);

    const totalSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    if (onRecord) {
      onRecord({
        id: Date.now(),
        type: 'Image to PDF',
        file: `${selectedFiles.length} Images`,
        originalBits: totalSize * 8,
        compressedBits: pdfBlob.size * 8,
        ratio: Math.max(0, ((1 - (pdfBlob.size / totalSize)) * 100)),
        timestamp: new Date().toISOString(),
      });
    }
    setLoading(false);
  };

  const handleDownload = async () => {
    if (!resultBlob) return;
    const fileName = `converted_images_${Date.now()}.pdf`;
    await downloadFile(resultBlob, fileName);
    showToast('✅ PDF downloaded successfully!');
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-display font-bold text-on-surface">Images to PDF Converter</h1>
          <div className="flex items-center gap-2">
            {limits && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary/10 text-primary border border-primary/30 text-xs font-mono font-bold shadow-sm">
                <span>⚡ Max Limit:</span>
                <span>
                  {limits.max_total_upload_mb >= 1024 
                    ? `${(limits.max_total_upload_mb / 1024).toFixed(limits.max_total_upload_mb % 1024 === 0 ? 0 : 1)} GB` 
                    : `${limits.max_total_upload_mb} MB`}
                </span>
              </div>
            )}
            {limits && limits.limits_enabled && (
              <div className="text-[11px] font-mono font-bold text-primary bg-primary/10 px-3 py-1 rounded-full border border-primary/20">
                Images selected: {selectedFiles.length} / {limits.images_per_request}
              </div>
            )}
          </div>
        </div>
        <p className="text-xs text-on-surface-muted mt-0.5">
          Convert JPG, PNG, WEBP images into a clean PDF document.
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
          onClick={() => document.getElementById('image-input')?.click()}
        >
          <input
            id="image-input"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/bmp"
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-3">
            🖼️
          </div>
          <p className="text-sm font-display font-bold text-on-surface">
            {selectedFiles.length > 0 ? `${selectedFiles.length} Image(s) Selected` : 'Click or Drag Images Here'}
          </p>
          <p className="text-xs text-on-surface-subtle mt-1 font-medium">
            Supports JPG, PNG, WEBP {limits && limits.limits_enabled && `(Max ${limits.images_per_request} per request)`}
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
              onClick={handleConvert}
              disabled={loading}
              className="btn-primary w-full py-3 text-xs font-bold shadow-lg"
            >
              {loading ? 'Converting Images to PDF...' : 'Convert to PDF'}
            </button>
          </div>
        )}

        {resultBlob && resultBlob.size > 0 && (
          <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
            <div>
              <p className="text-sm font-display font-bold text-emerald-900">PDF Ready for Download</p>
              <p className="text-xs font-mono text-emerald-700">Size: {formatBytes(resultBlob.size)}</p>
            </div>
            <button onClick={handleDownload} className="btn-primary py-2.5 px-6 text-xs font-bold shadow-md">
              Download PDF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
