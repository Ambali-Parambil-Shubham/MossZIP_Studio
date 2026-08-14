import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useAuth } from './context/AuthContext.jsx';
import { supabase } from './lib/supabaseClient.js';
import { getApiUrl } from './lib/api.js';
import logoImg from './assets/logo.png';

// ── Lazy-load all page components ──────────────────────────────────────────────
// Pages load only when first visited, dramatically reducing initial bundle size
const Sidebar          = lazy(() => import('./components/Sidebar.jsx'));
const CompressorPage   = lazy(() => import('./pages/CompressorPage.jsx'));
const ImageToPdfPage   = lazy(() => import('./pages/ImageToPdfPage.jsx'));
const PdfToWordPage    = lazy(() => import('./pages/PdfToWordPage.jsx'));
const MergePdfPage     = lazy(() => import('./pages/MergePdfPage.jsx'));
const SplitPdfPage     = lazy(() => import('./pages/SplitPdfPage.jsx'));
const HistoryPage      = lazy(() => import('./pages/HistoryPage.jsx'));
const AdminPage        = lazy(() => import('./pages/AdminPage.jsx'));
const AuthModal        = lazy(() => import('./components/AuthModal.jsx'));
const DesktopAppModal  = lazy(() => import('./components/DesktopAppModal.jsx'));

// ── Nav items — defined outside component so it's never recreated ───────────────
const NAV_ITEMS = [
  { id: 'compressor', label: 'Compress', icon: '📄' },
  { id: 'imageToPdf', label: 'Img→PDF', icon: '🖼️' },
  { id: 'pdfToWord', label: 'PDF→Word', icon: '📝' },
  { id: 'mergePdf',  label: 'Merge',    icon: '📑' },
  { id: 'splitPdf',  label: 'Split',    icon: '✂️' },
  { id: 'history',   label: 'History',  icon: '📜' },
];

// ── Skeleton shown during lazy page load ────────────────────────────────────────
function PageSkeleton() {
  return (
    <div className="page-skeleton">
      <div className="page-skeleton-bar w-48" />
      <div className="page-skeleton-bar w-72" />
      <div className="page-skeleton-card" />
      <div className="page-skeleton-card" />
    </div>
  );
}

// ── Helper: detect web browser context (memoized outside component) ─────────────
function detectIsWeb() {
  return (
    typeof window !== 'undefined' &&
    !window.navigator?.userAgent?.toLowerCase().includes('electron') &&
    !window.Capacitor &&
    window.location.protocol.startsWith('http')
  );
}
const IS_WEB = detectIsWeb();

export default function App() {
  const { user, isAuthenticated, logout, openAuthModal } = useAuth();
  const [activePage, setActivePage] = useState('compressor');
  const [isAdminRoute, setIsAdminRoute] = useState(false);
  const [lastCompressed, setLastCompressed] = useState(null);
  const [preserveFormat, setPreserveFormat] = useState(true);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showDesktopModal, setShowDesktopModal] = useState(false);

  // ── Admin route detection ────────────────────────────────────────────────────
  useEffect(() => {
    const checkAdminRoute = () => {
      const isHashAdmin   = window.location.hash === '#/admin' || window.location.hash === '#admin';
      const isSearchAdmin = window.location.search.includes('admin=1') || window.location.pathname.startsWith('/admin');
      setIsAdminRoute(isHashAdmin || isSearchAdmin);
    };
    checkAdminRoute();
    window.addEventListener('hashchange', checkAdminRoute);
    return () => window.removeEventListener('hashchange', checkAdminRoute);
  }, []);

  // ── Close profile menu on outside click ─────────────────────────────────────
  const profileMenuRef = useRef(null);
  useEffect(() => {
    if (!showProfileMenu) return;
    const handleOutside = (e) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target)) {
        setShowProfileMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [showProfileMenu]);

  // ── History records — initialised from localStorage with monthly pruning ─────
  const [records, setRecords] = useState(() => {
    try {
      const saved  = localStorage.getItem('mosszip_history_records');
      const parsed = saved ? JSON.parse(saved) : [];

      const startOfCurrentMonth = new Date(
        new Date().getFullYear(), new Date().getMonth(), 1, 0, 0, 0, 0
      );
      const pruned = parsed.filter((r) => {
        try { return new Date(r.timestamp || r.created_at || 0) >= startOfCurrentMonth; }
        catch { return true; }
      });

      if (pruned.length < parsed.length) {
        try {
          localStorage.setItem('mosszip_history_records', JSON.stringify(pruned));
          localStorage.setItem('mosszip_last_local_cleanup', new Date().toISOString());
        } catch (e) {}
      }
      return pruned;
    } catch { return []; }
  });

  // ── Supabase history sync — runs once on mount, only required columns ─────────
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    async function loadCentralRecords() {
      try {
        const [{ data: jobsData, error: jobErr }, { data: usersData }] = await Promise.all([
          supabase
            .from('compression_jobs')
            .select('id, job_type, name, file_name, original_bits, compressed_bits_count, ratio, stats, created_at, user_id')
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('app_users')
            .select('id, full_name, email, mobile')
        ]);

        if (cancelled || jobErr || !jobsData || jobsData.length === 0) return;

        const userMap = new Map();
        (usersData || []).forEach(u => userMap.set(u.id, u.full_name));

        const supaRecords = jobsData.map((job) => {
          const matchedUser = job.stats?.user || (job.user_id ? userMap.get(job.user_id) : null) || 'Guest';
          return {
            id:             job.id,
            user:           matchedUser,
            type:           job.job_type || 'Compress',
            file:           job.name || job.file_name || 'payload.bin',
            originalBits:   job.stats?.originalBits   || job.original_bits          || 0,
            compressedBits: job.stats?.compressedBits  || job.compressed_bits_count  || 0,
            ratio:          job.stats?.ratio            || job.ratio                  || 0,
            timestamp:      job.created_at,
          };
        });

        setRecords(prev => {
          const map = new Map();
          // Supabase records as base, then overlay local records on top
          supaRecords.forEach(r => map.set(String(r.id || r.timestamp), r));
          prev.forEach(r => { if (!map.has(String(r.id || r.timestamp))) map.set(String(r.id || r.timestamp), r); });
          const result = Array.from(map.values());
          try { localStorage.setItem('mosszip_history_records', JSON.stringify(result)); } catch (e) {}
          return result;
        });
      } catch (err) {
        console.warn('[Supabase Sync Notice]:', err.message);
      }
    }

    loadCentralRecords();
    return () => { cancelled = true; };
  }, []);

  const handleRecord = useCallback(async (record) => {
    const activeUserName = (user?.full_name ? user.full_name.trim() : null) || (() => {
      try {
        const s = localStorage.getItem('mosszip_user');
        return s ? (JSON.parse(s)?.full_name || JSON.parse(s)?.name) : null;
      } catch (e) { return null; }
    })() || 'Guest';
    const recordWithUser = { ...record, user: activeUserName };

    setRecords(prev => {
      const updated = [recordWithUser, ...prev];
      try { localStorage.setItem('mosszip_history_records', JSON.stringify(updated)); } catch (e) {}
      return updated;
    });

    if (supabase) {
      try {
        await supabase.from('compression_jobs').insert({
          name:                  record.file,
          file_name:             record.file,
          job_type:              record.type || 'Compress',
          user_id:               user?.id || null,
          original_bits:         record.originalBits        || 0,
          compressed_bits_count: record.compressedBits      || 0,
          ratio:                 record.ratio               || 0,
          original_text:         '[Job Entry]',
          compressed_bits:       '[Bit Stream]',
          stats: {
            originalBits:   record.originalBits,
            compressedBits: record.compressedBits,
            ratio:          record.ratio,
            user:           activeUserName,
          },
        });
      } catch (err) {
        console.warn('[Supabase Insert Notice]:', err.message);
      }
    }
  }, [user]);

  const handleClearHistory = useCallback(async () => {
    setRecords([]);
    try { localStorage.removeItem('mosszip_history_records'); } catch (e) {}
  }, []);

  // ── Page renderer — memoized so it only rerenders when activePage changes ─────
  const pageContent = useMemo(() => {
    switch (activePage) {
      case 'compressor':
        return (
          <CompressorPage
            onRecord={handleRecord}
            setLastCompressed={setLastCompressed}
            preserveFormat={preserveFormat}
            setPreserveFormat={setPreserveFormat}
          />
        );
      case 'imageToPdf': return <ImageToPdfPage onRecord={handleRecord} />;
      case 'pdfToWord':  return <PdfToWordPage  onRecord={handleRecord} />;
      case 'mergePdf':   return <MergePdfPage   onRecord={handleRecord} />;
      case 'splitPdf':   return <SplitPdfPage   onRecord={handleRecord} />;
      case 'history':    return <HistoryPage records={records} onClear={handleClearHistory} />;
      default:
        return (
          <CompressorPage
            onRecord={handleRecord}
            setLastCompressed={setLastCompressed}
            preserveFormat={preserveFormat}
            setPreserveFormat={setPreserveFormat}
          />
        );
    }
  }, [activePage, handleRecord, handleClearHistory, records, preserveFormat]);

  // ── Breadcrumb label — memoized ───────────────────────────────────────────────
  const breadcrumb = useMemo(() => {
    const labels = {
      compressor: '📄 Binary & Media Compressor',
      imageToPdf: '🖼️ Images to PDF Converter',
      pdfToWord:  '📝 PDF to Word (.docx) Converter',
      mergePdf:   '📑 Merge PDF Documents',
      splitPdf:   '✂️ Split PDF Document',
      history:    '📜 Compression Task History',
    };
    return labels[activePage] || '';
  }, [activePage]);

  // ── Dedicated Admin Command Center Mode ───────────────────────────────────────
  if (isAdminRoute) {
    return (
      <div className="min-h-screen bg-surface-low text-on-surface font-sans antialiased">
        <div className="bg-[#121A13] text-[#FFF7E2] px-6 py-3 border-b border-[#4F633D]/40 flex items-center justify-between text-xs font-display">
          <div className="flex items-center gap-2 font-bold">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>MossZip Enterprise — Standalone Protected Admin Command Center</span>
          </div>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              window.location.hash   = '';
              window.location.search = '';
              setIsAdminRoute(false);
            }}
            className="px-3 py-1 bg-white/10 hover:bg-white/20 text-[#FFF7E2] rounded-lg transition-all border border-white/20 font-semibold"
          >
            ← Return to Customer Portal
          </a>
        </div>
        <Suspense fallback={<PageSkeleton />}>
          <AdminPage records={records} onClearHistory={handleClearHistory} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] bg-surface-low text-on-surface overflow-hidden font-sans antialiased">
      {/* Desktop Left Navigation Sidebar */}
      <Suspense fallback={null}>
        <Sidebar
          activePage={activePage}
          setActivePage={setActivePage}
          onOpenDesktopModal={() => setShowDesktopModal(true)}
        />
      </Suspense>

      {/* Main Workspace Frame */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Top Header Navigation Bar */}
        <header className="h-16 border-b border-border bg-surface-low flex items-center justify-between px-4 sm:px-6 shrink-0 z-10 shadow-sm">
          <div className="flex items-center gap-3">
            {/* Mobile Header Branding */}
            <div className="lg:hidden flex items-center gap-2 shrink-0">
              <img
                src={logoImg}
                alt="MossZip Logo"
                className="w-7 h-7 rounded-lg object-contain bg-surface-container shrink-0"
                fetchpriority="high"
                decoding="async"
              />
              <span className="font-display font-bold text-sm text-on-surface whitespace-nowrap">MossZip Studio</span>
            </div>

            {/* Breadcrumb Context */}
            <div className="hidden lg:flex items-center gap-2 text-xs font-display font-medium text-on-surface-subtle">
              <span className="text-on-surface font-semibold capitalize">{breadcrumb}</span>
            </div>
          </div>

          {/* Right Header Navigation Controls */}
          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <div className="relative" ref={profileMenuRef}>
                <button
                  onClick={() => setShowProfileMenu(p => !p)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-high border border-border/80 text-xs font-display font-semibold text-on-surface transition-all shadow-sm"
                >
                  <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-[10px]">👤</span>
                  <span className="max-w-[100px] truncate">{user?.full_name || 'User'}</span>
                  <span className="text-[10px] text-on-surface-subtle">▼</span>
                </button>

                {showProfileMenu && (
                  <div className="absolute right-0 mt-2 w-48 bg-white border border-border/80 rounded-2xl shadow-xl p-2 z-50 animate-fade-in text-xs font-display gpu-layer">
                    <div className="px-3 py-2 border-b border-border/40">
                      <p className="font-bold text-on-surface truncate">{user?.full_name}</p>
                      <p className="text-[10px] font-mono text-on-surface-subtle truncate">+91 {user?.mobile}</p>
                    </div>
                    <button
                      onClick={() => { logout(); setShowProfileMenu(false); }}
                      className="w-full text-left px-3 py-2 text-amber-900 hover:bg-amber-50 font-bold rounded-xl transition-all mt-1 flex items-center justify-between"
                    >
                      <span>Sign Out</span>
                      <span>🚪</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => openAuthModal()}
                className="px-3.5 py-1.5 rounded-xl text-xs font-display font-bold bg-primary text-white shadow-md hover:bg-primary-dark transition-all flex items-center gap-1.5"
              >
                <span>🔐</span>
                <span>Log In with PIN</span>
              </button>
            )}

            {/* Download Windows Desktop App Button — only on Web */}
            {IS_WEB && (
              <button
                onClick={() => setShowDesktopModal(true)}
                className="px-3 py-1.5 rounded-xl text-xs font-display font-bold bg-primary/10 text-primary hover:bg-primary/20 transition-all border border-primary/20 flex items-center gap-2 shadow-sm shrink-0"
                title="Download Desktop App for Windows"
              >
                <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 0121 5.25zM12 6v6m0 0l-2.25-2.25M12 12l2.25-2.25" />
                </svg>
                <span className="hidden sm:inline">Desktop App</span>
              </button>
            )}
          </div>
        </header>

        {/* Customer Dynamic Page View — must scroll past fixed bottom nav */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden"
          style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
        >
          <Suspense fallback={<PageSkeleton />}>
            {pageContent}
          </Suspense>
        </div>
      </main>

      {/* Customer Mobile Bottom Navigation Bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 h-16 bg-white/95 backdrop-blur border-t border-border flex items-center justify-around z-50 px-1 select-none shadow-lg pb-[env(safe-area-inset-bottom)]">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setActivePage(item.id)}
            className={`flex flex-col items-center justify-center flex-1 min-w-[50px] min-h-[44px] py-1 px-0.5 rounded-xl text-[10px] font-display transition-all ${
              activePage === item.id
                ? 'text-primary font-bold bg-primary/10 border border-primary/20 shadow-sm'
                : 'text-on-surface-subtle hover:text-on-surface font-medium'
            }`}
          >
            <span className="text-sm leading-none mb-0.5">{item.icon}</span>
            <span className="truncate max-w-full leading-tight text-[10px]">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Lazy-loaded modals */}
      <Suspense fallback={null}>
        <AuthModal />
      </Suspense>
      <Suspense fallback={null}>
        <DesktopAppModal isOpen={showDesktopModal} onClose={() => setShowDesktopModal(false)} />
      </Suspense>
    </div>
  );
}
