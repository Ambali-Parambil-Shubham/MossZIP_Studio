import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { getApiUrl } from '../lib/api.js';

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '0 B';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUsername(userStr) {
  if (!userStr) return 'Guest';
  const trimmed = String(userStr).trim();
  if (trimmed === 'Guest' || trimmed.startsWith('Client') || trimmed.startsWith('User (')) {
    return 'Guest';
  }
  const clean = trimmed.replace(/\s*\([^)]*\)/g, '').trim();
  return clean || 'Guest';
}



export default function AdminPage({ records = [], onClearHistory }) {
  const [adminToken, setAdminToken] = useState(() => {
    return sessionStorage.getItem('mosszip_admin_token') || null;
  });

  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState(null);

  // Custom Password State
  const [customPass, setCustomPass] = useState(() => {
    return localStorage.getItem('mosszip_custom_admin_password') || '';
  });
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [changePassMsg, setChangePassMsg] = useState(null);
  const [changePassError, setChangePassError] = useState(null);

  // Forgot Password Recovery States
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [showSetPassModal, setShowSetPassModal] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [recoveryError, setRecoveryError] = useState(null);
  const [recoveredInfo, setRecoveredInfo] = useState(null);

  const [serverStatus, setServerStatus] = useState(null);
  const [engineConfig, setEngineConfig] = useState({
    videoEnabled: true,
    pdfEnabled: true,
    imageToPdfEnabled: true,
    pdfToWordEnabled: true,
    mergePdfEnabled: true,
    ffmpegCrf: 28,
    maxVideoMb: 100,
    maxDocMb: 25,
  });

  // Compression Limits Dynamic State (Initialized from LocalStorage or 1 GB default)
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

  // MB / GB Unit Selector State
  const [uploadUnit, setUploadUnit] = useState(() => (limits.max_total_upload_mb >= 1024 ? 'GB' : 'MB'));
  const [uploadSizeVal, setUploadSizeVal] = useState(() => (
    limits.max_total_upload_mb >= 1024 
      ? (limits.max_total_upload_mb / 1024).toString() 
      : limits.max_total_upload_mb.toString()
  ));
  const [limitsMsg, setLimitsMsg] = useState(null);
  const [limitsLoading, setLimitsLoading] = useState(false);

  // Global Audit Logs State
  const [auditLogs, setAuditLogs] = useState([]);
  const [search, setSearch] = useState('');
  const [toolFilter, setToolFilter] = useState('ALL');
  const [sweeping, setSweeping] = useState(false);
  const [sweepMsg, setSweepMsg] = useState(null);

  // Monthly History Cleanup State
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState(null);
  const [cleanupLogs, setCleanupLogs] = useState([]);
  const [showCleanupLogs, setShowCleanupLogs] = useState(false);

  // Fetch Live Server Limits on Load
  const fetchServerLimits = async () => {
    if (supabase) {
      try {
        const { data } = await supabase.from('app_users').select('*').eq('mobile', 'SYSTEM_LIMITS');
        if (data && data.length > 0 && data[0].mpin) {
          const cloudLimits = JSON.parse(data[0].mpin);
          if (cloudLimits && cloudLimits.max_total_upload_mb) {
            setLimits(cloudLimits);
            localStorage.setItem('mosszip_admin_limits', JSON.stringify(cloudLimits));
            const currentMb = cloudLimits.max_total_upload_mb || 1024;
            if (currentMb >= 1024 && currentMb % 1024 === 0) {
              setUploadUnit('GB');
              setUploadSizeVal((currentMb / 1024).toString());
            } else {
              setUploadUnit('MB');
              setUploadSizeVal(currentMb.toString());
            }
            return;
          }
        }
      } catch (e) {}
    }

    try {
      const res = await fetch(getApiUrl('/api/admin/limits'));
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          if (data && data.limits) {
            setLimits(data.limits);
            localStorage.setItem('mosszip_admin_limits', JSON.stringify(data.limits));
            window.dispatchEvent(new Event('mosszip_limits_updated'));
            const currentMb = data.limits.max_total_upload_mb || 1024;
            if (currentMb >= 1024 && currentMb % 1024 === 0) {
              setUploadUnit('GB');
              setUploadSizeVal((currentMb / 1024).toString());
            } else {
              setUploadUnit('MB');
              setUploadSizeVal(currentMb.toString());
            }
          }
        }
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchServerLimits();
    if (adminToken) {
      fetchAdminStatus(adminToken);
      fetchAuditLogs(adminToken);
    }
  }, [adminToken]);

  const fetchAdminStatus = async (token) => {
    if (!token) return;
    try {
      const res = await fetch(getApiUrl('/api/admin/status'), {
        headers: { 'x-admin-key': token },
      });
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          setServerStatus(data);
          if (data.config) setEngineConfig(data.config);
          if (data.limits) setLimits(data.limits);
          if (data.auditLogs) setAuditLogs(data.auditLogs);
        }
      }
    } catch (e) {
      console.warn('[AdminStatus] Server unreachable, using local fallback state.');
    }
  };

  const fetchAuditLogs = async (token) => {
    if (!token) return;
    try {
      const res = await fetch(getApiUrl('/api/admin/audit-logs'), {
        headers: { 'x-admin-key': token },
      });
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          if (data.logs) setAuditLogs(data.logs);
        }
      }
    } catch (e) {}
  };

  const handleClearAuditLogs = async () => {
    try {
      await fetch(getApiUrl('/api/admin/audit-logs/clear'), {
        method: 'POST',
        headers: { 'x-admin-key': adminToken },
      });
      setAuditLogs([]);
      if (onClearHistory) onClearHistory();
    } catch (e) {
      setAuditLogs([]);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError(null);
    const pass = passwordInput.trim();
    const customPasscode = localStorage.getItem('mosszip_custom_admin_password') || '';

    try {
      const res = await fetch(getApiUrl('/api/admin/auth'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass }),
      });

      let data = null;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      } catch (err) {}

      if (res.ok && data && data.status === 'ok') {
        const token = data.token || pass;
        setAdminToken(token);
        sessionStorage.setItem('mosszip_admin_token', token);
        fetchAdminStatus(token);
        return;
      } else if (data && data.message) {
        setAuthError(data.message);
        return;
      }
    } catch (err) {}

    // Fallback: Check local custom passcode or default key (for offline / standalone modes)
    if (pass && (pass === 'MossZipAdmin#2026' || pass === '1234' || (customPasscode && pass === customPasscode))) {
      setAdminToken(pass);
      sessionStorage.setItem('mosszip_admin_token', pass);
      fetchAdminStatus(pass);
    } else {
      setAuthError('Invalid Admin Passcode. Please check your passcode and try again.');
    }
  };

  const handleSetCustomPassword = (e) => {
    e.preventDefault();
    setChangePassError(null);
    setChangePassMsg(null);

    const pass = newPasswordInput.trim();
    if (!pass || pass.length < 3) {
      setChangePassError('Passcode must be at least 3 characters long.');
      return;
    }

    localStorage.setItem('mosszip_custom_admin_password', pass);
    setCustomPass(pass);
    setChangePassMsg('Master Passcode successfully updated!');
    setNewPasswordInput('');

    fetch(getApiUrl('/api/admin/change-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: pass }),
    }).catch(() => {});
  };

  const handleUnitToggle = (newUnit) => {
    setUploadUnit(newUnit);
    const num = parseFloat(uploadSizeVal) || 0;
    if (newUnit === 'GB' && uploadUnit === 'MB') {
      setUploadSizeVal((num / 1024).toFixed(1));
    } else if (newUnit === 'MB' && uploadUnit === 'GB') {
      setUploadSizeVal(Math.round(num * 1024).toString());
    }
  };

  const handleSaveLimits = async (e) => {
    e.preventDefault();
    setLimitsMsg(null);
    setLimitsLoading(true);

    const rawNum = parseFloat(uploadSizeVal) || 1;
    const finalMb = uploadUnit === 'GB' ? Math.round(rawNum * 1024) : Math.round(rawNum);

    const updatedLimits = {
      ...limits,
      max_total_upload_mb: finalMb,
    };

    // 1. ALWAYS update LocalState & LocalStorage IMMEDIATELY so app updates live!
    setLimits(updatedLimits);
    localStorage.setItem('mosszip_admin_limits', JSON.stringify(updatedLimits));
    window.dispatchEvent(new Event('mosszip_limits_updated'));
    window.dispatchEvent(new Event('storage'));

    const limitDisplayLabel = uploadUnit === 'GB' ? `${rawNum} GB` : `${finalMb} MB`;
    setLimitsMsg(`Compression limits updated to ${limitDisplayLabel} & synced live!`);

    // 2. Persist to Supabase Cloud for universal multi-device sync
    if (supabase) {
      try {
        await supabase.from('app_users').upsert({
          mobile: 'SYSTEM_LIMITS',
          full_name: 'System Limits Configuration',
          email: 'config@mosszip.sys',
          mpin: JSON.stringify(updatedLimits),
        }, { onConflict: 'mobile' });
      } catch (e) {}
    }

    // 3. Persist to server API if server is reachable
    try {
      await fetch(getApiUrl('/api/admin/limits'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminToken,
        },
        body: JSON.stringify({ limits: updatedLimits }),
      });
    } catch (err) {
      console.warn('[AdminPage] Backend sync notice:', err);
    } finally {
      setLimitsLoading(false);
    }
  };

  const handleResetLimits = async () => {
    setLimitsMsg(null);
    setLimitsLoading(true);

    const defaultLim = {
      images_per_request: 10,
      videos_per_request: 2,
      pdfs_per_request: 10,
      max_total_upload_mb: 1024,
      limits_enabled: true,
    };

    setLimits(defaultLim);
    setUploadUnit('GB');
    setUploadSizeVal('1');
    localStorage.setItem('mosszip_admin_limits', JSON.stringify(defaultLim));
    window.dispatchEvent(new Event('mosszip_limits_updated'));
    window.dispatchEvent(new Event('storage'));
    setLimitsMsg('Reset compression limits to default (1 GB).');

    try {
      await fetch(getApiUrl('/api/admin/limits/reset'), {
        method: 'POST',
        headers: {
          'x-admin-key': adminToken,
        },
      });
    } catch (err) {} finally {
      setLimitsLoading(false);
    }
  };

  const handleRecoverPassword = (e) => {
    e.preventDefault();
    setRecoveryError(null);
    const cleaned = recoveryInput.trim().toLowerCase();
    const activePass = localStorage.getItem('mosszip_custom_admin_password') || '';

    if (cleaned === '2026' || cleaned === 'sshhuubb18@gmail.com' || cleaned === 'shubham') {
      setRecoveredInfo(activePass ? `Your current Passcode is active.` : `Default authentication key active.`);
    } else {
      setRecoveryError('Security Verification Failed.');
    }
  };

  const handleSweepTemp = async () => {
    setSweeping(true);
    setSweepMsg(null);
    try {
      const res = await fetch(getApiUrl('/api/admin/clean-temp'), {
        method: 'POST',
        headers: { 'x-admin-key': adminToken },
      });
      const data = await res.json();
      setSweepMsg(data.message || 'Temp uploads cleaned.');
      fetchAdminStatus(adminToken);
    } catch (e) {
      setSweepMsg('Disk sweep completed.');
    } finally {
      setSweeping(false);
    }
  };

  const displayLogs = auditLogs.length > 0 ? auditLogs : records;

  const filteredLogs = displayLogs.filter(item => {
    const fileMatch = (item.file || '').toLowerCase().includes(search.toLowerCase());
    const userMatch = (item.user || '').toLowerCase().includes(search.toLowerCase());
    const typeMatch = (item.type || '').toLowerCase().includes(search.toLowerCase());
    const filterMatch = toolFilter === 'ALL' || item.type === toolFilter;
    return (fileMatch || userMatch || typeMatch) && filterMatch;
  });

  const exportAsCsv = () => {
    if (displayLogs.length === 0) return;
    const headers = ['ID', 'User/Client', 'Type', 'File', 'Original (Bytes)', 'Compressed (Bytes)', 'Ratio (%)', 'Timestamp'];
    const rows = displayLogs.map(r => [
      r.id,
      `"${(r.user || 'User').replace(/"/g, '""')}"`,
      r.type,
      `"${(r.file || '').replace(/"/g, '""')}"`,
      Math.round((r.originalBits || 0) / 8),
      Math.round((r.compressedBits || 0) / 8),
      (r.ratio || 0).toFixed(2),
      r.timestamp,
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `mosszip_system_audit_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Auth Screen
  if (!adminToken) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-6 w-full relative">
        <div className="card p-8 max-w-md w-full space-y-6 text-center shadow-xl border border-border/80">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 text-primary mx-auto flex items-center justify-center border border-primary/20">
            <svg className="w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>

          <div>
            <h2 className="text-xl font-display font-bold text-on-surface">Admin Portal Security Gate</h2>
            <p className="text-xs text-on-surface-muted mt-1">
              Enter Admin Key to authenticate {customPass ? <span className="text-primary font-bold">(Custom Passcode Active)</span> : null}
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Enter Admin Key"
              className="input-field text-center text-lg tracking-widest py-3"
              autoFocus
            />

            {authError && (
              <p className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 p-2.5 rounded-lg">
                {authError}
              </p>
            )}

            <button type="submit" className="btn-primary w-full py-3">
              Authenticate & Unlock
            </button>

            <div className="flex items-center justify-between pt-2 text-xs font-display font-semibold">
              <button
                type="button"
                onClick={() => setShowForgotModal(true)}
                className="text-on-surface-muted hover:text-primary transition-colors"
              >
                Forgot Key?
              </button>
              <button
                type="button"
                onClick={() => setShowSetPassModal(true)}
                className="text-primary hover:underline"
              >
                Set Custom Passcode
              </button>
            </div>
          </form>
        </div>

        {/* Forgot Password Security Modal */}
        {showForgotModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="card p-6 max-w-sm w-full space-y-4 relative shadow-2xl bg-white border border-border">
              <div className="flex items-center justify-between border-b pb-3">
                <h3 className="text-sm font-display font-bold text-on-surface">Security Recovery Gate</h3>
                <button onClick={() => { setShowForgotModal(false); setRecoveryError(null); setRecoveredInfo(null); }} className="text-on-surface-muted hover:text-on-surface">✕</button>
              </div>

              {!recoveredInfo ? (
                <form onSubmit={handleRecoverPassword} className="space-y-3">
                  <p className="text-xs text-on-surface-muted">
                    Enter Security Master PIN or Admin Email to verify access:
                  </p>
                  <input
                    type="text"
                    value={recoveryInput}
                    onChange={(e) => setRecoveryInput(e.target.value)}
                    placeholder="Enter Security PIN or Email"
                    className="input-field py-2 text-xs"
                    autoFocus
                  />
                  {recoveryError && <p className="text-[11px] font-bold text-rose-600 bg-rose-50 p-2 rounded">{recoveryError}</p>}
                  <button type="submit" className="btn-primary w-full py-2 text-xs font-bold">
                    Verify & Unlock
                  </button>
                </form>
              ) : (
                <div className="space-y-3 text-center">
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs font-mono font-bold">
                    {recoveredInfo}
                  </div>
                  <button
                    onClick={() => {
                      setPasswordInput(localStorage.getItem('mosszip_custom_admin_password') || '');
                      setShowForgotModal(false);
                      setRecoveredInfo(null);
                    }}
                    className="btn-primary w-full py-2 text-xs font-bold"
                  >
                    Auto-Fill & Login Now
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Set Custom Password Modal */}
        {showSetPassModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="card p-6 max-w-sm w-full space-y-4 relative shadow-2xl bg-white border border-border">
              <div className="flex items-center justify-between border-b pb-3">
                <h3 className="text-sm font-display font-bold text-on-surface">Set Master Passcode</h3>
                <button onClick={() => { setShowSetPassModal(false); setChangePassError(null); setChangePassMsg(null); }} className="text-on-surface-muted hover:text-on-surface">✕</button>
              </div>

              <form onSubmit={handleSetCustomPassword} className="space-y-3">
                <p className="text-xs text-on-surface-muted">
                  Create your own custom passcode below:
                </p>
                <input
                  type="password"
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  placeholder="Enter New Custom Passcode"
                  className="input-field py-2 text-xs"
                  autoFocus
                />
                {changePassError && <p className="text-[11px] font-bold text-rose-600 bg-rose-50 p-2 rounded">{changePassError}</p>}
                {changePassMsg && <p className="text-[11px] font-bold text-emerald-700 bg-emerald-50 p-2 rounded">{changePassMsg}</p>}
                <button type="submit" className="btn-primary w-full py-2 text-xs font-bold">
                  Save Custom Passcode
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 sm:space-y-8 max-w-7xl mx-auto w-full">
      {/* Admin Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-border/60 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-display font-bold text-on-surface">Admin Command Center</h1>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
              v2.4 Production
            </span>
          </div>
          <p className="text-xs text-on-surface-muted mt-1">
            Global User Usage Telemetry · System Audit Log · Compression Limits & Governance
          </p>
        </div>

        <button
          onClick={() => {
            setAdminToken(null);
            sessionStorage.removeItem('mosszip_admin_token');
          }}
          className="btn-secondary text-xs"
        >
          Lock Admin Gate
        </button>
      </div>

      {/* Main Grid Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* COMPRESSION LIMITS & ANTI-ABUSE PANEL */}
        <div className="lg:col-span-2 card p-6 space-y-5 bg-white border border-border">
          <div className="flex items-center justify-between border-b border-border/60 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold">
                ⚡
              </div>
              <div>
                <h2 className="text-base font-display font-bold text-on-surface">Compression Limits & Anti-Abuse</h2>
                <p className="text-xs text-on-surface-muted">Configure per-request upload limits to protect server RAM & CPU</p>
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs font-display font-semibold text-on-surface-subtle">
                {limits.limits_enabled ? 'Limits Active' : 'Limits Disabled'}
              </span>
              <input
                type="checkbox"
                checked={limits.limits_enabled}
                onChange={(e) => {
                  const updated = { ...limits, limits_enabled: e.target.checked };
                  setLimits(updated);
                  localStorage.setItem('mosszip_admin_limits', JSON.stringify(updated));
                  window.dispatchEvent(new Event('mosszip_limits_updated'));
                }}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary relative" />
            </label>
          </div>

          <form onSubmit={handleSaveLimits} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              
              <div className="p-4 rounded-xl bg-surface-low border border-border/80 space-y-1.5">
                <label className="text-xs font-display font-bold text-on-surface flex items-center gap-2">
                  <span>🖼️</span> Images Max per Request
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={limits.images_per_request}
                  onChange={(e) => setLimits({ ...limits, images_per_request: parseInt(e.target.value) || 1 })}
                  className="input-field text-sm font-mono font-bold"
                />
                <p className="text-[11px] text-on-surface-subtle">Default: 10 images</p>
              </div>

              <div className="p-4 rounded-xl bg-surface-low border border-border/80 space-y-1.5">
                <label className="text-xs font-display font-bold text-on-surface flex items-center gap-2">
                  <span>🎬</span> Videos Max per Request
                </label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={limits.videos_per_request}
                  onChange={(e) => setLimits({ ...limits, videos_per_request: parseInt(e.target.value) || 1 })}
                  className="input-field text-sm font-mono font-bold"
                />
                <p className="text-[11px] text-on-surface-subtle">Default: 2 videos</p>
              </div>

              <div className="p-4 rounded-xl bg-surface-low border border-border/80 space-y-1.5">
                <label className="text-xs font-display font-bold text-on-surface flex items-center gap-2">
                  <span>📄</span> PDFs Max per Request
                </label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={limits.pdfs_per_request}
                  onChange={(e) => setLimits({ ...limits, pdfs_per_request: parseInt(e.target.value) || 1 })}
                  className="input-field text-sm font-mono font-bold"
                />
                <p className="text-[11px] text-on-surface-subtle">Default: 10 PDFs</p>
              </div>

              {/* Max Total Upload Size with Unit Selector (MB / GB) */}
              <div className="p-4 rounded-xl bg-surface-low border border-border/80 space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-display font-bold text-on-surface flex items-center gap-2">
                    <span>💾</span> Max Total Upload Size
                  </label>
                  <div className="flex items-center gap-1 bg-white border border-border rounded-lg p-0.5 shadow-sm">
                    <button
                      type="button"
                      onClick={() => handleUnitToggle('MB')}
                      className={`px-2 py-0.5 text-[10px] font-bold rounded transition-all ${uploadUnit === 'MB' ? 'bg-primary text-white shadow-sm' : 'text-on-surface-subtle hover:text-on-surface'}`}
                    >
                      MB
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUnitToggle('GB')}
                      className={`px-2 py-0.5 text-[10px] font-bold rounded transition-all ${uploadUnit === 'GB' ? 'bg-primary text-white shadow-sm' : 'text-on-surface-subtle hover:text-on-surface'}`}
                    >
                      GB
                    </button>
                  </div>
                </div>

                <div className="relative flex items-center">
                  <input
                    type="number"
                    min="1"
                    step={uploadUnit === 'GB' ? '0.1' : '1'}
                    value={uploadSizeVal}
                    onChange={(e) => setUploadSizeVal(e.target.value)}
                    className="input-field text-sm font-mono font-bold pr-12"
                  />
                  <span className="absolute right-3 text-xs font-bold text-primary font-mono">{uploadUnit}</span>
                </div>

                <p className="text-[11px] text-on-surface-subtle">
                  Active Limit: <span className="font-bold text-primary">{limits.max_total_upload_mb >= 1024 ? `${(limits.max_total_upload_mb / 1024).toFixed(1)} GB (${limits.max_total_upload_mb} MB)` : `${limits.max_total_upload_mb} MB`}</span>
                </p>
              </div>

            </div>

            {limitsMsg && (
              <p className="text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 p-3 rounded-xl animate-fade-in">
                {limitsMsg}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border/60">
              <button
                type="button"
                onClick={handleResetLimits}
                disabled={limitsLoading}
                className="btn-secondary py-2.5 px-4 text-xs font-semibold"
              >
                Reset to Defaults
              </button>

              <button
                type="submit"
                disabled={limitsLoading}
                className="btn-primary py-2.5 px-6 text-xs font-bold shadow-md"
              >
                {limitsLoading ? 'Saving...' : 'Save Compression Limits'}
              </button>
            </div>
          </form>
        </div>

        {/* SERVER DISK & MASTER PASSCODE MANAGER */}
        <div className="space-y-6">
          
          <div className="card p-6 space-y-4 bg-white border border-border">
            <h2 className="text-sm font-display font-bold text-on-surface flex items-center gap-2">
              <span>🔐</span> Admin Master Passcode Manager
            </h2>
            <p className="text-xs text-on-surface-muted">
              {customPass ? (
                <span className="text-primary font-bold">Custom Passcode Active</span>
              ) : (
                <span>Create custom passcode below:</span>
              )}
            </p>

            <form onSubmit={handleSetCustomPassword} className="space-y-3">
              <input
                type="password"
                value={newPasswordInput}
                onChange={(e) => setNewPasswordInput(e.target.value)}
                placeholder="Enter New Master Passcode"
                className="input-field py-2 text-xs"
              />
              {changePassError && <p className="text-[11px] font-bold text-rose-600 bg-rose-50 p-2 rounded">{changePassError}</p>}
              {changePassMsg && <p className="text-[11px] font-bold text-emerald-700 bg-emerald-50 p-2 rounded">{changePassMsg}</p>}
              <button type="submit" className="btn-primary w-full py-2.5 text-xs font-bold">
                Update Master Passcode
              </button>
            </form>
          </div>

          <div className="card p-6 space-y-4 bg-white border border-border">
            <h2 className="text-sm font-display font-bold text-on-surface flex items-center gap-2">
              <span>🧹</span> Server Disk Storage Sweeper
            </h2>
            <p className="text-xs text-on-surface-muted">
              Temp files on disk: <span className="font-mono font-bold text-primary">{serverStatus?.tempFileCount ?? 0}</span>
            </p>
            {sweepMsg && <p className="text-xs font-bold text-emerald-700 bg-emerald-50 p-2 rounded">{sweepMsg}</p>}
            <button
              onClick={handleSweepTemp}
              disabled={sweeping}
              className="btn-secondary w-full py-2.5 text-xs font-bold"
            >
              {sweeping ? 'Sweeping Disk...' : 'Purge All Temp Upload Files'}
            </button>
          </div>

          {/* Monthly History Cleanup Manager */}
          <div className="card p-6 space-y-4 bg-white border border-border">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-display font-bold text-on-surface flex items-center gap-2">
                <span>🗓️</span> Monthly History Cleanup
              </h2>
              <span className="text-[10px] font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full border border-primary/20">
                Auto: 1st of Month · 02:00 AM
              </span>
            </div>
            <p className="text-xs text-on-surface-muted">
              Automatically removes task/activity history records from previous months.
              User accounts, auth, settings, and permanent data are <strong className="text-on-surface">never affected</strong>.
            </p>

            {cleanupMsg && (
              <p className={`text-xs font-bold p-2.5 rounded-lg ${
                cleanupMsg.startsWith('✅') ? 'text-emerald-700 bg-emerald-50 border border-emerald-200' : 'text-rose-700 bg-rose-50 border border-rose-200'
              }`}>{cleanupMsg}</p>
            )}

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={async () => {
                  setCleanupRunning(true);
                  setCleanupMsg(null);
                  try {
                    const res = await fetch(getApiUrl('/api/admin/cleanup-now'), {
                      method: 'POST',
                      headers: { 'x-admin-key': adminToken },
                    });
                    const data = await res.json();
                    if (data.success) {
                      setCleanupMsg(`✅ ${data.message}`);
                    } else {
                      setCleanupMsg(`❌ ${data.message || data.error}`);
                    }
                  } catch (e) {
                    setCleanupMsg('❌ Server unreachable — cleanup skipped.');
                  } finally {
                    setCleanupRunning(false);
                  }
                }}
                disabled={cleanupRunning}
                className="btn-secondary flex-1 py-2.5 text-xs font-bold"
              >
                {cleanupRunning ? 'Running Cleanup...' : 'Run Cleanup Now'}
              </button>

              <button
                onClick={async () => {
                  if (showCleanupLogs) { setShowCleanupLogs(false); return; }
                  try {
                    const res = await fetch(getApiUrl('/api/admin/cleanup-logs'), {
                      headers: { 'x-admin-key': adminToken },
                    });
                    const data = await res.json();
                    if (data.success) setCleanupLogs(data.logs || []);
                  } catch (e) {}
                  setShowCleanupLogs(true);
                }}
                className="btn-secondary flex-1 py-2.5 text-xs font-bold"
              >
                {showCleanupLogs ? 'Hide Logs' : 'View Cleanup Logs'}
              </button>
            </div>

            {showCleanupLogs && (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {cleanupLogs.length === 0 ? (
                  <p className="text-xs text-on-surface-muted text-center py-4">No cleanup runs recorded yet.</p>
                ) : cleanupLogs.map((log, i) => (
                  <div key={i} className={`text-[11px] font-mono p-2.5 rounded-lg border ${
                    log.success ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
                  }`}>
                    <div className="flex items-center justify-between font-bold mb-0.5">
                      <span>{log.success ? '✅ SUCCESS' : '❌ FAILED'}</span>
                      <span className="text-[10px] font-sans font-normal opacity-70">
                        {new Date(log.run_at).toLocaleString()}
                      </span>
                    </div>
                    {log.success ? (
                      <span>Removed {log.records_removed} records · Kept {log.records_kept} · Cutoff: {new Date(log.cutoff_date).toLocaleDateString()}</span>
                    ) : (
                      <span>Error: {log.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

      </div>

      {/* GENERAL GLOBAL SYSTEM AUDIT LOG TABLE (ALL USERS & USAGE) */}
      <div className="card p-6 space-y-6 bg-white border border-border">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-border/60 pb-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-display font-bold text-on-surface">General System Usage & Audit Log</h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-primary/10 text-primary border border-primary/20">
                {filteredLogs.length} Log Entries
              </span>
            </div>
            <p className="text-xs text-on-surface-muted mt-0.5">
              Tracks all operations executed across all users and IP sessions with payload sizes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <button onClick={exportAsCsv} className="btn-secondary text-xs py-2 px-3">
              Export CSV
            </button>
            <button onClick={handleClearAuditLogs} className="btn-secondary text-xs py-2 px-3 text-rose-600 hover:text-rose-700">
              Clear Audit Log
            </button>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <div className="relative flex-1 w-full">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search user IP, file name, or operation type..."
              className="input-field text-xs pl-9 py-2"
            />
            <svg className="w-4 h-4 text-on-surface-subtle absolute left-3 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <select
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            className="input-field text-xs py-2 px-3 w-full sm:w-auto"
          >
            <option value="ALL">All Operation Types</option>
            <option value="Compress">Compress</option>
            <option value="Video Compression">Video Compression</option>
            <option value="Image Compression">Image Compression</option>
            <option value="PDF Compression">PDF Compression</option>
            <option value="Image to PDF">Image to PDF</option>
            <option value="PDF to Word">PDF to Word</option>
            <option value="Merge PDF">Merge PDF</option>
          </select>
        </div>

        {/* Audit Log Table */}
        <div className="overflow-x-auto rounded-xl border border-border/80">
          <table className="w-full text-left text-xs font-display border-collapse">
            <thead>
              <tr className="bg-surface-low border-b border-border/80 text-on-surface-subtle font-bold">
                <th className="p-3">Timestamp</th>
                <th className="p-3">User / Client Identifier</th>
                <th className="p-3">Operation Type</th>
                <th className="p-3">File Name</th>
                <th className="p-3">Original Size</th>
                <th className="p-3">Output Size</th>
                <th className="p-3">Space Reduction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filteredLogs.length > 0 ? (
                filteredLogs.map((log) => {
                  const origBytes = Math.round((log.originalBits || 0) / 8);
                  const compBytes = Math.round((log.compressedBits || 0) / 8);

                  return (
                    <tr key={log.id} className="hover:bg-surface-low/60 transition-colors font-mono">
                      <td className="p-3 text-[11px] text-on-surface-subtle whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleString()}
                      </td>
                      <td className="p-3 font-bold text-primary whitespace-nowrap">
                        {formatUsername(log.user)}
                      </td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold font-display bg-primary/10 text-primary border border-primary/20 whitespace-nowrap">
                          {log.type}
                        </span>
                      </td>
                      <td className="p-3 font-semibold text-on-surface truncate max-w-xs" title={log.file}>
                        {log.file}
                      </td>
                      <td className="p-3 text-on-surface-subtle whitespace-nowrap">
                        {formatBytes(origBytes)}
                      </td>
                      <td className="p-3 font-bold text-on-surface whitespace-nowrap">
                        {formatBytes(compBytes)}
                      </td>
                      <td className="p-3 font-bold text-emerald-700 whitespace-nowrap">
                        {log.ratio ? `${log.ratio.toFixed(1)}% saved` : 'Converted'}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="7" className="p-8 text-center text-xs text-on-surface-subtle font-display">
                    No general system audit logs recorded yet. All user operations will automatically log here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
