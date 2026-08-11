import { useState, useCallback, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { runCompression } from '../lib/huffman.js';
import { optimizeFile } from '../lib/formatOptimizers.js';
import { getApiUrl } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { downloadFile } from '../lib/downloadFile.js';
import FileDropZone from '../components/FileDropZone.jsx';
import TerminalLog from '../components/TerminalLog.jsx';
import FrequencyTable from '../components/FrequencyTable.jsx';
import HuffmanCodeTable from '../components/HuffmanCodeTable.jsx';

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '0 B';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isBinaryText(str) {
  if (!str) return true;
  let nonPrintable = 0;
  const sample = str.slice(0, 500);
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 65533) {
      nonPrintable++;
    }
  }
  return nonPrintable > 8;
}

export default function CompressorPage({ onRecord, onResult, preserveFormat, setPreserveFormat }) {
  const { requireAuth, showToast } = useAuth();
  const [fileInfo, setFileInfo] = useState(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('codes');
  const [inputMode, setInputMode] = useState('file');

  // Dynamic Admin Compression Limits State (Initialized from LocalStorage)
  const [limits, setLimits] = useState(() => {
    try {
      const saved = localStorage.getItem('mosszip_admin_limits');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      images_per_request: 10,
      videos_per_request: 2,
      pdfs_per_request: 10,
      max_total_upload_mb: 1024,
      limits_enabled: true,
    };
  });
  const [limitToast, setLimitToast] = useState(null);

  // Progress Bar & ETA state
  const [progress, setProgress] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');

  const now = () => new Date().toLocaleTimeString('en-US', { hour12: false });

  const loadLimitsFromApi = useCallback(async () => {
    // 1. Check Supabase Cloud app_users table first for live global admin settings
    if (supabase) {
      try {
        const { data } = await supabase.from('app_users').select('*').eq('mobile', 'SYSTEM_LIMITS');
        if (data && data.length > 0 && data[0].mpin) {
          const cloudLimits = JSON.parse(data[0].mpin);
          if (cloudLimits && cloudLimits.max_total_upload_mb) {
            setLimits(cloudLimits);
            localStorage.setItem('mosszip_admin_limits', JSON.stringify(cloudLimits));
            return;
          }
        }
      } catch (e) {}
    }

    // 2. Try central API
    try {
      const res = await fetch(getApiUrl('/api/admin/limits'));
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          if (data && data.limits) {
            setLimits(data.limits);
            localStorage.setItem('mosszip_admin_limits', JSON.stringify(data.limits));
            return;
          }
        }
      }
    } catch (e) {}

    // 3. Local fallback
    try {
      const saved = localStorage.getItem('mosszip_admin_limits');
      if (saved) setLimits(JSON.parse(saved));
    } catch (e) {}
  }, []);

  useEffect(() => {
    loadLimitsFromApi();

    const handleUpdate = () => {
      loadLimitsFromApi();
    };

    window.addEventListener('mosszip_limits_updated', handleUpdate);
    window.addEventListener('storage', handleUpdate);
    window.addEventListener('focus', handleUpdate);
    const interval = setInterval(loadLimitsFromApi, 2500);

    return () => {
      window.removeEventListener('mosszip_limits_updated', handleUpdate);
      window.removeEventListener('storage', handleUpdate);
      window.removeEventListener('focus', handleUpdate);
      clearInterval(interval);
    };
  }, [loadLimitsFromApi]);

  const handleFile = useCallback((info) => {
    setLimitToast(null);
    if (limits && limits.limits_enabled && info.rawFile) {
      const sizeMb = info.size / (1024 * 1024);

      if (limits.max_total_upload_mb > 0 && sizeMb > limits.max_total_upload_mb) {
        setLimitToast(`Total upload size exceeds maximum allowed limit of ${limits.max_total_upload_mb >= 1024 ? `${(limits.max_total_upload_mb / 1024).toFixed(1)} GB` : `${limits.max_total_upload_mb} MB`}.`);
        return;
      }
    }

    setFileInfo(info);
    if (info.textContent) setText(info.textContent);
    setResult(null);
    setProgress(0);
    setEtaSeconds(0);
    setLogs([`[INFO] ${now()} Loaded file: ${info.name} (${formatBytes(info.size)})`]);
  }, [limits]);

  // Protected Compress Handler
  const handleCompress = () => {
    requireAuth(() => {
      executeCompress();
    });
  };

  const executeCompress = async () => {
    const hasFilePayload = fileInfo?.rawFile || fileInfo?.content;
    const input = (inputMode === 'file' && hasFilePayload) ? (fileInfo.rawFile || fileInfo.content) : text;
    if (!input || (typeof input === 'string' && !input.trim())) return;
    
    setLoading(true);
    setResult(null);
    setLimitToast(null);
    setProgress(5);
    setStatusMessage('Analyzing file streams...');
    setEtaSeconds(3);

    setLogs(prev => [
      ...prev,
      `[INFO] ${now()} Initializing ultra-compression pipeline...`,
    ]);

    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 90) return prev;
        const next = prev + Math.floor(Math.random() * 15 + 10);
        const rem = Math.max(1, Math.ceil((100 - next) / 30));
        setEtaSeconds(rem);
        if (next > 40 && next < 70) {
          setStatusMessage('Processing video streams (FFmpeg H.264)...');
        } else if (next >= 70) {
          setStatusMessage('Applying AAC audio & faststart packaging...');
        }
        return next > 90 ? 90 : next;
      });
    }, 250);

    setTimeout(async () => {
      try {
        const rawName = fileInfo?.name || 'payload.txt';
        const ext = rawName.split('.').pop()?.toLowerCase();
        const isPdfOrImage = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'docx', 'pptx', 'xlsx', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', '3gp'].includes(ext);

        let finalPayload;
        let stats;
        let freqMap = new Map();
        let codes = new Map();
        let encoded = "";
        let root = null;
        let isDirectFormat = true;

        let serverSuccess = false;
        let uploadPayload = fileInfo?.rawFile;
        if (!uploadPayload && fileInfo?.content) {
          uploadPayload = new File([fileInfo.content], rawName, { type: 'application/octet-stream' });
        }

        if (inputMode === 'file' && uploadPayload) {
          try {
            const formData = new FormData();
            formData.append('file', uploadPayload);

            const response = await fetch(getApiUrl('/api/compress'), {
              method: 'POST',
              body: formData,
            });

            if (response.ok) {
              const blob = await response.blob();
              if (blob && blob.size > 0) {
                finalPayload = blob;

                const headerOrig = response.headers.get('X-Original-Size');
                const headerComp = response.headers.get('X-Compressed-Size');

                const origLen = headerOrig ? Number(headerOrig) : (fileInfo?.size || input.length || 0);
                const newLen = (headerComp && Number(headerComp) > 0) ? Number(headerComp) : (blob.size || origLen);
                const ratio = origLen > 0 ? Math.max(0, ((1 - (newLen / origLen)) * 100)) : 0;

                stats = {
                  originalBits: origLen * 8,
                  compressedBits: newLen * 8,
                  ratio: ratio
                };

                setResult({
                  payload: finalPayload,
                  isDirectFormat: isPdfOrImage,
                  ext: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', '3gp'].includes(ext) ? 'mp4' : ext,
                  stats,
                  codes,
                  freqMap
                });

                serverSuccess = true;
                setLogs(prev => [...prev, `[SUCCESS] ${now()} Server Compression Pipeline executed.`]);
              } else {
                setLogs(prev => [...prev, `[WARN] ${now()} Server returned empty response. Executing client-side engine fallback...`]);
              }
            } else if (!response.ok) {
              const errData = await response.json().catch(() => ({}));
              if (errData.message) {
                setLimitToast(errData.message);
              }
            }
          } catch (e) {
            console.warn('[CompressorPage] Server response error:', e);
          }
        }

        if (!serverSuccess) {
          if (isDirectFormat) {
            let bufferInput = input;
            if (fileInfo?.rawFile && !(bufferInput instanceof Uint8Array)) {
              try {
                bufferInput = new Uint8Array(await fileInfo.rawFile.arrayBuffer());
              } catch (e) {
                bufferInput = fileInfo.rawFile;
              }
            }

            finalPayload = await optimizeFile(bufferInput, rawName, (msg) => {
              setLogs(prev => [...prev, `${now()} ${msg}`]);
            });

            const origLen = fileInfo?.size || (bufferInput?.byteLength || bufferInput?.length || 0);
            const newLen = finalPayload?.size || finalPayload?.byteLength || finalPayload?.length || origLen;
            const ratio = origLen > 0 ? Math.max(0, ((1 - (newLen / origLen)) * 100)) : 0;

            stats = {
              originalBits: origLen * 8,
              compressedBits: newLen * 8,
              ratio: ratio
            };

            setResult({
              payload: finalPayload,
              isDirectFormat: true,
              ext: ext,
              stats,
              codes,
              freqMap
            });
          } else {
            const compressed = runCompression(input);
            freqMap = compressed.freqMap;
            codes = compressed.codes;
            encoded = compressed.encoded;
            stats = compressed.stats;
            root = compressed.root;

            setResult({
              payload: compressed.binaryPayload,
              isDirectFormat: false,
              ext: 'huff',
              stats,
              codes,
              freqMap,
              root,
              encoded
            });
          }
        }

        clearInterval(interval);
        setProgress(100);
        setEtaSeconds(0);
        setStatusMessage('Compression Complete!');

        setLogs(prev => [
          ...prev,
          `[STATS] ${now()} Original: ${formatBytes(stats.originalBits / 8)} → Compressed: ${formatBytes(stats.compressedBits / 8)}`,
          `[SUCCESS] ${now()} Compression complete. Space saved: ${stats.ratio.toFixed(1)}%`,
        ]);

        if (supabase) {
          await supabase.from('compression_jobs').insert({
            name: `${rawName}_compressed.${isDirectFormat ? ext : 'huff'}`,
            original_text: typeof input === 'string' ? input : '[Binary Data]',
            compressed_bits: encoded || '[Format Preserved]',
            stats: stats,
            frequency_map: Object.fromEntries(freqMap),
            huffman_codes: Object.fromEntries(codes)
          });
        }

        if (onResult) {
          onResult({ root, freqMap, codes, encoded, originalText: input });
        }

        if (onRecord) {
          onRecord({
            id: Date.now(),
            type: 'Compress',
            file: rawName,
            originalBits: stats.originalBits,
            compressedBits: stats.compressedBits,
            ratio: stats.ratio,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        clearInterval(interval);
        setLogs(prev => [...prev, `[ERROR] ${now()} ${err.message}`]);
      } finally {
        setLoading(false);
      }
    }, 250);
  };

  const handleDownload = () => {
    requireAuth(() => {
      executeDownload();
    });
  };

  const executeDownload = async () => {
    if (!result || !result.payload) return;

    const rawName = fileInfo?.name || 'compressed_output';
    let safeName;
    let mimeType;

    const mimeMap = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      aac: 'audio/aac',
      m4a: 'audio/mp4',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    if (result.isDirectFormat) {
      const ext = (result.ext || 'mp4').toLowerCase();
      const baseName = rawName.includes('.') ? rawName.slice(0, rawName.lastIndexOf('.')) : rawName;
      safeName = `${baseName}_compressed.${ext}`;
      mimeType = mimeMap[ext] || 'application/octet-stream';
    } else {
      const baseName = rawName.includes('.') ? rawName.slice(0, rawName.lastIndexOf('.')) : rawName;
      safeName = `${baseName}_compressed.huff`;
      mimeType = 'application/x-huffman';
    }

    const blob = (result.payload instanceof Blob) 
      ? result.payload 
      : new Blob([result.payload], { type: mimeType });

    if (blob.size === 0) {
      showToast('❌ Compression error: generated file is empty.');
      return;
    }

    await downloadFile(blob, safeName);
    showToast(`✅ "${safeName}" downloaded successfully!`);
  };

  const hasInput = (inputMode === 'file' && fileInfo) || (inputMode === 'text' && text.trim().length > 0);
  const previewText = fileInfo?.textContent || text;
  const isBinary = isBinaryText(previewText);

  // Determine active limits label for selected file type
  const fileExt = fileInfo?.name ? fileInfo.name.split('.').pop().toLowerCase() : '';
  const isVideo = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', '3gp'].includes(fileExt);
  const isImage = ['jpg', 'jpeg', 'png', 'webp'].includes(fileExt);
  const isPdf = fileExt === 'pdf';

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-display font-bold text-on-surface">Compress & Optimize Files</h1>
          <p className="text-xs text-on-surface-muted mt-0.5">
            Lossless automatic file format optimization & compression.
          </p>
        </div>

        {/* Header Controls & Badges */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Live Max Upload Limit Badge */}
          {limits && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary/10 text-primary border border-primary/30 text-xs font-mono font-bold shadow-sm whitespace-nowrap">
              <span>⚡ Max Limit:</span>
              <span className="text-primary">
                {limits.max_total_upload_mb >= 1024 
                  ? `${(limits.max_total_upload_mb / 1024).toFixed(limits.max_total_upload_mb % 1024 === 0 ? 0 : 1)} GB` 
                  : `${limits.max_total_upload_mb} MB`}
              </span>
            </div>
          )}

          {/* Preserve Format Active Badge */}
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-container text-on-surface border border-border/80 text-xs font-display font-bold shadow-sm whitespace-nowrap">
            <span>✨</span>
            <span>Preserve Format Enabled</span>
          </div>
        </div>
      </div>

      {/* Modern Limit Alert Toast */}
      {limitToast && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs font-bold flex items-center justify-between shadow-md animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="text-base">⚠️</span>
            <span>{limitToast}</span>
          </div>
          <button onClick={() => setLimitToast(null)} className="text-amber-700 hover:text-amber-950 font-bold ml-4">✕</button>
        </div>
      )}

      {/* Main Grid */}
      <div className="space-y-6">
        
        {/* Input Card */}
        <div className="card p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setInputMode('file')}
                className={`text-xs font-display font-semibold transition-colors ${inputMode === 'file' ? 'text-primary border-b-2 border-primary pb-3 -mb-3.5' : 'text-on-surface-subtle hover:text-on-surface'}`}
              >
                File Upload
              </button>
              <button
                onClick={() => setInputMode('text')}
                className={`text-xs font-display font-semibold transition-colors ${inputMode === 'text' ? 'text-primary border-b-2 border-primary pb-3 -mb-3.5' : 'text-on-surface-subtle hover:text-on-surface'}`}
              >
                Text & Code Editor
              </button>
            </div>

            {/* Live Counter Badge */}
            {limits && limits.limits_enabled && inputMode === 'file' && (
              <div className="text-[11px] font-mono font-bold text-primary bg-primary/10 px-2.5 py-1 rounded-full border border-primary/20">
                {isVideo && `Videos selected: 1 / ${limits.videos_per_request}`}
                {isImage && `Images selected: 1 / ${limits.images_per_request}`}
                {isPdf && `PDFs selected: 1 / ${limits.pdfs_per_request}`}
                {!isVideo && !isImage && !isPdf && (
                  limits.max_total_upload_mb >= 1024 
                    ? `Max upload limit: ${(limits.max_total_upload_mb / 1024).toFixed(limits.max_total_upload_mb % 1024 === 0 ? 0 : 1)} GB` 
                    : `Max upload limit: ${limits.max_total_upload_mb} MB`
                )}
              </div>
            )}

            {inputMode === 'text' && (
              <span className="text-[11px] font-mono text-on-surface-subtle">
                {text.length} characters · {text.trim() ? text.trim().split(/\s+/).length : 0} words
              </span>
            )}
          </div>

          {inputMode === 'file' ? (
            <FileDropZone
              onFile={handleFile}
              accept=".txt,.java,.class,.jar,.huff,.pdf,.docx,.pptx,.xlsx,.jpg,.jpeg,.png,.webp,.mp4,.mov,.avi,.mkv,.webm,.m4v,.wmv,.3gp,.csv,.json,.js,.py,.html,.css,.cpp,.c,.h,.md"
              label="Drop any file here to compress"
              sublabel="Supports Video (MP4, MOV, AVI, MKV), PDF, Office, Images & Text"
            />
          ) : (
            <div className="space-y-2">
              <textarea
                value={text}
                onChange={e => { setText(e.target.value); setResult(null); }}
                placeholder="Paste or type text to compress..."
                className="input-field h-48 resize-none font-mono text-xs leading-relaxed"
              />
              <div className="pt-2 flex justify-end">
                <button
                  onClick={handleCompress}
                  disabled={loading || !text.trim()}
                  className="btn-primary py-2.5 px-6 font-bold text-xs"
                >
                  {loading ? 'Compressing Text...' : '⚡ COMPRESS TEXT NOW'}
                </button>
              </div>
            </div>
          )}

          {hasInput && (
            <div className="space-y-4 pt-2">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 rounded-xl bg-surface-low border border-border/80 shadow-md">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-mono font-bold text-sm border border-primary/20">
                    {fileInfo?.name ? fileInfo.name.split('.').pop().toUpperCase() : 'TXT'}
                  </div>
                  <div>
                    <p className="text-base font-display font-bold text-on-surface">
                      {fileInfo?.name || 'Text Buffer Payload'}
                    </p>
                    <p className="text-xs font-mono text-on-surface-subtle mt-0.5">
                      {fileInfo ? formatBytes(fileInfo.size) : `${text.length} bytes`}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCompress}
                  disabled={loading}
                  className="btn-primary w-full sm:w-auto py-3 px-8 text-sm font-bold shadow-lg flex items-center justify-center gap-2"
                >
                  <span>⚡</span>
                  <span>{loading ? 'Compressing Payload...' : 'COMPRESS FILE NOW'}</span>
                </button>
              </div>

              {/* Compression Progress Bar & Time Remaining */}
              {loading && (
                <div className="p-4 rounded-xl bg-surface-low border border-primary/20 space-y-2 animate-fade-in">
                  <div className="flex items-center justify-between text-xs font-display">
                    <span className="font-semibold text-primary flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-primary animate-ping" />
                      {statusMessage}
                    </span>
                    <span className="font-mono text-on-surface-subtle">
                      {progress}% · Estimated time: ~{etaSeconds}s remaining
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-border/60 overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 rounded-full"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Results Panel */}
        {result && (
          <div className="card p-6 space-y-6 animate-fade-in">
            {/* Visual Size Comparison Meter */}
            <div className="space-y-2 bg-surface-low p-4 rounded-xl border border-border/80">
              <div className="flex items-center justify-between text-xs font-display">
                <span className="font-semibold text-on-surface">Space Reduction</span>
                <span className="font-mono font-bold text-primary">
                  {formatBytes(result.stats.originalBits / 8)} → {formatBytes(result.stats.compressedBits / 8)} ({result.stats.ratio.toFixed(1)}% saved)
                </span>
              </div>
              <div className="h-3 rounded-full bg-border/60 overflow-hidden flex">
                <div 
                  className="h-full bg-primary transition-all duration-700" 
                  style={{ width: `${Math.max(5, 100 - result.stats.ratio)}%` }} 
                />
                <div 
                  className="h-full bg-secondary/30 transition-all duration-700" 
                  style={{ width: `${Math.max(0, result.stats.ratio)}%` }} 
                />
              </div>
            </div>

            {/* Results Action & Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-3">
              <div className="flex items-center gap-4">
                {!result.isDirectFormat && (
                  <>
                    <button
                      onClick={() => setActiveTab('codes')}
                      className={`text-xs font-display font-semibold transition-colors ${activeTab === 'codes' ? 'text-primary border-b-2 border-primary pb-3 -mb-3.5' : 'text-on-surface-subtle hover:text-on-surface'}`}
                    >
                      Bit Codes
                    </button>
                    <button
                      onClick={() => setActiveTab('freq')}
                      className={`text-xs font-display font-semibold transition-colors ${activeTab === 'freq' ? 'text-primary border-b-2 border-primary pb-3 -mb-3.5' : 'text-on-surface-subtle hover:text-on-surface'}`}
                    >
                      Frequencies
                    </button>
                  </>
                )}
                <button
                  onClick={() => setActiveTab('preview')}
                  className={`text-xs font-display font-semibold transition-colors ${activeTab === 'preview' ? 'text-primary border-b-2 border-primary pb-3 -mb-3.5' : 'text-on-surface-subtle hover:text-on-surface'}`}
                >
                  Original Data Preview
                </button>
                <button
                  onClick={() => setActiveTab('logs')}
                  className={`text-xs font-display font-semibold transition-colors ${activeTab === 'logs' ? 'text-primary border-b-2 border-primary pb-3 -mb-3.5' : 'text-on-surface-subtle hover:text-on-surface'}`}
                >
                  Log
                </button>
              </div>

              <button onClick={handleDownload} className="btn-secondary">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download Compressed File ({result.isDirectFormat ? `.${result.ext}` : '.huff'})
              </button>
            </div>

            {/* Tab Views */}
            {activeTab === 'codes' && !result.isDirectFormat && (
              <HuffmanCodeTable codes={result.codes} />
            )}
            {activeTab === 'freq' && !result.isDirectFormat && (
              <FrequencyTable freqMap={result.freqMap} />
            )}
            {activeTab === 'preview' && (
              isBinary ? (
                <div className="bg-[#1C271D] text-[#FFF7E2] rounded-xl p-5 font-mono text-xs space-y-2 border border-[#2C3B2E]">
                  <div className="flex items-center justify-between border-b border-[#2C3B2E] pb-2 text-[#8BA194] font-bold">
                    <span>[BINARY FILE STREAM DETECTED]</span>
                    <span>TYPE: {fileInfo?.name ? fileInfo.name.split('.').pop().toUpperCase() : 'BINARY'}</span>
                  </div>
                  <div className="space-y-1 text-[#FFF7E2]/80">
                    <p><span className="text-[#8BA194]">File Name:</span> {fileInfo?.name || 'Binary Payload'}</p>
                    <p><span className="text-[#8BA194]">Original Size:</span> {formatBytes(result.stats.originalBits / 8)}</p>
                    <p><span className="text-[#8BA194]">Compressed Output Size:</span> {formatBytes(result.stats.compressedBits / 8)}</p>
                    <p><span className="text-[#8BA194]">Space Reduction:</span> {result.stats.ratio.toFixed(1)}%</p>
                    <p className="text-[#8BA194] font-semibold pt-1">Status: Valid compressed stream ready for download ({result.isDirectFormat ? `.${result.ext}` : '.huff format'})</p>
                  </div>
                </div>
              ) : (
                <div className="terminal max-h-56 overflow-auto">
                  <pre className="text-xs font-mono whitespace-pre-wrap">
                    {previewText}
                  </pre>
                </div>
              )
            )}
            {activeTab === 'logs' && (
              <TerminalLog lines={logs} />
            )}
          </div>
        )}

      </div>
    </div>
  );
}
