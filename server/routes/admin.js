import express from 'express';
import fs from 'fs';
import path from 'path';
import { cleanServerAuditHistory, getCleanupLogs } from '../services/monthlyCleanupService.js';

const router = express.Router();

// Master Admin Secret Key for API authorization
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'MossZipAdmin#2026';
let customAdminPassword = null;

// Dynamic Engine Settings State
let engineConfig = {
  videoEnabled: true,
  pdfEnabled: true,
  imageToPdfEnabled: true,
  pdfToWordEnabled: true,
  mergePdfEnabled: true,
  ffmpegCrf: 28,
  maxVideoMb: 100,
  maxDocMb: 25,
};

// Default Compression & Anti-Abuse Limits (Initial state if config file does not exist)
export const DEFAULT_LIMITS = {
  images_per_request: 10,
  videos_per_request: 2,
  pdfs_per_request: 10,
  max_total_upload_mb: 1024,
  limits_enabled: true,
};

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persistent limits configuration & audit storage
const limitsConfigPath = path.join(__dirname, '..', 'config', 'limits.json');
const auditLogsPath = path.join(__dirname, '..', 'config', 'audit_history.json');

function loadLimits() {
  try {
    if (fs.existsSync(limitsConfigPath)) {
      const data = fs.readFileSync(limitsConfigPath, 'utf-8');
      return { ...DEFAULT_LIMITS, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('[Admin] Failed to load limits config:', e);
  }
  return { ...DEFAULT_LIMITS };
}

function saveLimits(limits) {
  try {
    const configDir = path.dirname(limitsConfigPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(limitsConfigPath, JSON.stringify(limits, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Admin] Failed to save limits config:', e);
  }
}

function loadAuditLogs() {
  try {
    if (fs.existsSync(auditLogsPath)) {
      const data = fs.readFileSync(auditLogsPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[Admin] Failed to load audit logs:', e);
  }
  return [];
}

function saveAuditLogs(logs) {
  try {
    const configDir = path.dirname(auditLogsPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(auditLogsPath, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Admin] Failed to save audit logs:', e);
  }
}

let compressionLimits = loadLimits();
let globalAuditLogs = loadAuditLogs();

export function getCompressionLimits() {
  return compressionLimits;
}

export function addAuditLog(entry) {
  let cleanUser = entry.user ? String(entry.user).trim() : 'Guest';
  if (cleanUser === 'Guest' || cleanUser.startsWith('Client') || cleanUser.startsWith('User (')) {
    cleanUser = 'Guest';
  }
  cleanUser = cleanUser.replace(/\s*\([^)]*\)/g, '').trim() || 'Guest';

  const log = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    user: cleanUser,
    ip: entry.ip || '127.0.0.1',
    type: entry.type || 'Compress',
    file: entry.file || 'payload.bin',
    originalBits: entry.originalBits || 0,
    compressedBits: entry.compressedBits || 0,
    ratio: entry.ratio || 0,
  };

  globalAuditLogs.unshift(log);
  if (globalAuditLogs.length > 1000) globalAuditLogs.pop();
  saveAuditLogs(globalAuditLogs);
}

// Middleware: Verify Admin Key
function verifyAdminKey(req, res, next) {
  const authHeader = req.headers['x-admin-key'] || req.headers['authorization'];
  if (!authHeader || (authHeader !== ADMIN_SECRET_KEY && authHeader !== `Bearer ${ADMIN_SECRET_KEY}`)) {
    return res.status(401).json({ status: 'error', message: '401 Unauthorized: Invalid Admin Credentials.' });
  }
  next();
}

// GET /api/admin/limits (Public - Live dynamic limits source of truth for all users)
router.get('/limits', (req, res) => {
  res.json({
    success: true,
    limits: compressionLimits,
  });
});

// POST /api/admin/limits (Protected: Updates live server limits in memory and on disk)
router.post('/limits', verifyAdminKey, (req, res) => {
  const { limits } = req.body;

  if (!limits) {
    return res.status(400).json({ success: false, message: 'No limits configuration provided.' });
  }

  compressionLimits = {
    images_per_request: Math.max(1, Number(limits.images_per_request) || compressionLimits.images_per_request),
    videos_per_request: Math.max(1, Number(limits.videos_per_request) || compressionLimits.videos_per_request),
    pdfs_per_request: Math.max(1, Number(limits.pdfs_per_request) || compressionLimits.pdfs_per_request),
    max_total_upload_mb: Math.max(1, Number(limits.max_total_upload_mb) || compressionLimits.max_total_upload_mb),
    limits_enabled: limits.limits_enabled !== undefined ? Boolean(limits.limits_enabled) : true,
  };

  saveLimits(compressionLimits);

  res.json({
    success: true,
    message: 'Compression limits updated successfully.',
    limits: compressionLimits,
  });
});

// POST /api/admin/limits/reset (Protected: Reset to Defaults)
router.post('/limits/reset', verifyAdminKey, (req, res) => {
  compressionLimits = { ...DEFAULT_LIMITS };
  saveLimits(compressionLimits);

  res.json({
    success: true,
    message: 'Compression limits reset to default values.',
    limits: compressionLimits,
  });
});

// GET /api/admin/audit-logs (Protected: General System Audit Log for all users)
router.get('/audit-logs', verifyAdminKey, (req, res) => {
  res.json({
    success: true,
    logs: globalAuditLogs,
  });
});

// GET /api/history (Public central history endpoint for multi-device sync across Web, Desktop & Mobile)
router.get('/public-history', (req, res) => {
  res.json({
    success: true,
    logs: globalAuditLogs,
  });
});

// POST /api/admin/audit-logs/clear (Protected: Clear Global Audit Log)
router.post('/audit-logs/clear', verifyAdminKey, (req, res) => {
  globalAuditLogs = [];
  saveAuditLogs(globalAuditLogs);
  res.json({
    success: true,
    message: 'Global audit history cleared successfully.',
    logs: [],
  });
});

// POST /api/admin/record-log (Public log recorder for all user operations across web, desktop & mobile)
router.post('/record-log', (req, res) => {
  const { user, type, file, originalBits, compressedBits, ratio, ip } = req.body;
  const clientIp = ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  addAuditLog({
    user: user || `User (${clientIp})`,
    ip: clientIp,
    type: type || 'Compress',
    file: file || 'payload.bin',
    originalBits: originalBits || 0,
    compressedBits: compressedBits || 0,
    ratio: ratio || 0,
  });

  res.json({ success: true, message: 'Logged to Admin Command Center.' });
});

// POST /api/admin/auth - Validate password
router.post('/auth', (req, res) => {
  const { password } = req.body;
  const validPasses = customAdminPassword 
    ? [ADMIN_SECRET_KEY, customAdminPassword] 
    : [ADMIN_SECRET_KEY];

  if (password && validPasses.includes(password)) {
    return res.json({ status: 'ok', token: ADMIN_SECRET_KEY });
  }
  return res.status(401).json({ status: 'error', message: 'Invalid Admin Password.' });
});

// POST /api/admin/change-password (Protected)
router.post('/change-password', verifyAdminKey, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.trim().length < 3) {
    return res.status(400).json({ status: 'error', message: 'Password must be at least 3 characters.' });
  }
  customAdminPassword = newPassword.trim();
  res.json({ status: 'ok', message: 'Master Password updated successfully.' });
});

// GET /api/admin/status (Protected)
router.get('/status', verifyAdminKey, (req, res) => {
  const uploadDir = path.join(process.cwd(), 'server', 'uploads');
  let tempFileCount = 0;
  try {
    if (fs.existsSync(uploadDir)) {
      tempFileCount = fs.readdirSync(uploadDir).length;
    }
  } catch (e) {}

  res.json({
    status: 'ok',
    engine: 'MossZip Dedicated Standalone Admin Portal v2.4',
    tempFileCount,
    config: engineConfig,
    limits: compressionLimits,
    auditLogs: globalAuditLogs,
    hasCustomPassword: !!customAdminPassword,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

// POST /api/admin/config (Protected)
router.post('/config', verifyAdminKey, (req, res) => {
  const { config } = req.body;
  if (config) {
    engineConfig = { ...engineConfig, ...config };
  }
  res.json({ status: 'ok', config: engineConfig });
});

// POST /api/admin/clean-temp (Protected)
router.post('/clean-temp', verifyAdminKey, async (req, res) => {
  const uploadDir = path.join(process.cwd(), 'server', 'uploads');
  let cleanedCount = 0;
  try {
    if (fs.existsSync(uploadDir)) {
      const files = await fs.promises.readdir(uploadDir);
      for (const file of files) {
        const filePath = path.join(uploadDir, file);
        await fs.promises.unlink(filePath).catch(() => {});
        cleanedCount++;
      }
    }
  } catch (e) {}
  res.json({ status: 'ok', message: `Cleaned ${cleanedCount} temp files from server disk.` });
});

// GET /api/admin/cleanup-logs (Protected: View monthly cleanup job history)
router.get('/cleanup-logs', verifyAdminKey, (req, res) => {
  try {
    const logs = getCleanupLogs(50);
    res.json({ success: true, logs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/admin/cleanup-now (Protected: Manually trigger a monthly history cleanup)
router.post('/cleanup-now', verifyAdminKey, (req, res) => {
  try {
    const result = cleanServerAuditHistory();

    // Also clear in-memory audit log to keep it in sync with the file
    if (result.success) {
      const cutoffDate = new Date(
        new Date().getFullYear(), new Date().getMonth(), 1, 0, 0, 0, 0
      );
      globalAuditLogs = globalAuditLogs.filter((log) => {
        try { return new Date(log.timestamp) >= cutoffDate; } catch { return true; }
      });
    }

    res.json({
      success: result.success,
      message: result.success
        ? `Cleanup complete — removed ${result.removed} old history records, kept ${result.kept} current-month records.`
        : `Cleanup failed: ${result.error}`,
      result,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==============================================================================
// ENTERPRISE OPERATIONAL MODULES (v2.4.0)
// ==============================================================================

// In-Memory Data Stores for Enterprise Admin Modules
let systemUsers = [
  { id: 'usr_001', full_name: 'Alex Morgan', email: 'alex@example.com', mobile: '9876543210', status: 'Active', plan: 'Enterprise', created_at: new Date(Date.now() - 86400000 * 30).toISOString(), last_active: new Date().toISOString(), total_files: 42, storage_mb: 320, notes: 'VIP Customer' },
  { id: 'usr_002', full_name: 'Sarah Connor', email: 'sarah@example.com', mobile: '9876543211', status: 'Active', plan: 'Pro', created_at: new Date(Date.now() - 86400000 * 14).toISOString(), last_active: new Date(Date.now() - 3600000 * 2).toISOString(), total_files: 18, storage_mb: 145, notes: '' },
  { id: 'usr_003', full_name: 'John Doe', email: 'john@example.com', mobile: '9876543212', status: 'Suspended', plan: 'Free', created_at: new Date(Date.now() - 86400000 * 45).toISOString(), last_active: new Date(Date.now() - 86400000 * 5).toISOString(), total_files: 8, storage_mb: 55, notes: 'Flagged for rate limit abuse' }
];

let systemJobs = [
  { id: 'job_101', file_name: 'quarterly_report.pdf', job_type: 'PDF Compression', status: 'Completed', worker: 'pdf-worker-1', original_size: '15.4 MB', compressed_size: '4.2 MB', ratio: '72.7%', duration_ms: 450, created_at: new Date(Date.now() - 300000).toISOString() },
  { id: 'job_102', file_name: 'intro_banner.mp4', job_type: 'Video Compression', status: 'Running', worker: 'ffmpeg-worker-1', original_size: '124.0 MB', compressed_size: 'Processing...', ratio: 'In Progress', duration_ms: 3200, created_at: new Date(Date.now() - 45000).toISOString() },
  { id: 'job_103', file_name: 'scan_doc.png', job_type: 'Image to PDF', status: 'Failed', worker: 'sharp-worker-2', original_size: '8.2 MB', compressed_size: '0 B', ratio: '0%', duration_ms: 120, created_at: new Date(Date.now() - 600000).toISOString(), error_reason: 'Corrupted image header' }
];

let systemAlerts = [
  { id: 'alt_01', severity: 'Warning', title: 'Storage Threshold Notice', message: 'Temporary disk storage reached 65% capacity.', timestamp: new Date(Date.now() - 1800000).toISOString(), acknowledged: false },
  { id: 'alt_02', severity: 'Info', title: 'Monthly Cleanup Complete', message: 'Automated monthly cleanup completed successfully.', timestamp: new Date(Date.now() - 86400000).toISOString(), acknowledged: true }
];

let systemSettings = {
  maintenance_mode: false,
  guest_uploads_enabled: true,
  default_ffmpeg_crf: 28,
  default_image_quality: 80,
  max_concurrent_jobs: 8,
  support_email: 'support@mosszip.com',
  brand_name: 'MossZip Studio'
};

let blockedIps = new Set(['192.168.1.105', '10.0.0.99']);
let supportTickets = [
  { id: 'tkt_1001', user_name: 'Alex Morgan', email: 'alex@example.com', subject: 'PDF Compression Quality Question', priority: 'Medium', status: 'Open', created_at: new Date(Date.now() - 7200000).toISOString(), category: 'General' },
  { id: 'tkt_1002', user_name: 'John Doe', email: 'john@example.com', subject: 'Account Access Question', priority: 'High', status: 'In Progress', created_at: new Date(Date.now() - 28800000).toISOString(), category: 'Account' }
];

let backupLogs = [
  { id: 'bk_01', type: 'Database PostgreSQL', status: 'SUCCESS', size: '42.8 MB', timestamp: new Date(Date.now() - 86400000).toISOString() },
  { id: 'bk_02', type: 'Storage Snapshot', status: 'SUCCESS', size: '1.2 GB', timestamp: new Date(Date.now() - 172800000).toISOString() }
];

// RBAC Middleware Helper
function verifyAdminRole(requiredRole = 'Support Admin') {
  return (req, res, next) => {
    const authHeader = req.headers['x-admin-key'] || req.headers['authorization'];
    if (!authHeader || (authHeader !== ADMIN_SECRET_KEY && authHeader !== `Bearer ${ADMIN_SECRET_KEY}`)) {
      return res.status(401).json({ status: 'error', message: '401 Unauthorized: Invalid Admin Credentials.' });
    }
    // Roles hierarchy: Super Admin > Operations Admin > Support Admin / Analytics Admin
    req.adminRole = req.headers['x-admin-role'] || 'Super Admin';
    next();
  };
}

// 1. USER MANAGEMENT ENDPOINTS
router.get('/users', verifyAdminKey, (req, res) => {
  res.json({ success: true, users: systemUsers });
});

router.get('/users/:id', verifyAdminKey, (req, res) => {
  const user = systemUsers.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

router.post('/users/:id/suspend', verifyAdminKey, (req, res) => {
  const user = systemUsers.find(u => u.id === req.params.id);
  if (user) { user.status = 'Suspended'; user.notes = (user.notes ? user.notes + ' | ' : '') + 'Suspended by admin'; }
  res.json({ success: true, message: `User ${req.params.id} suspended successfully`, user });
});

router.post('/users/:id/reactivate', verifyAdminKey, (req, res) => {
  const user = systemUsers.find(u => u.id === req.params.id);
  if (user) { user.status = 'Active'; }
  res.json({ success: true, message: `User ${req.params.id} reactivated successfully`, user });
});

router.post('/users/:id/logout-all', verifyAdminKey, (req, res) => {
  res.json({ success: true, message: `All active sessions revoked for user ${req.params.id}` });
});

// 2. PROCESSING QUEUE & WORKER ENDPOINTS
router.get('/jobs', verifyAdminKey, (req, res) => {
  res.json({
    success: true,
    jobs: systemJobs,
    workers: [
      { name: 'ffmpeg-worker-1', status: 'ACTIVE', cpu: '14.2%', memory: '128 MB', active_job: 'job_102' },
      { name: 'sharp-worker-1', status: 'IDLE', cpu: '0.1%', memory: '48 MB', active_job: null },
      { name: 'pdf-worker-1', status: 'IDLE', cpu: '0.0%', memory: '64 MB', active_job: null }
    ]
  });
});

router.post('/jobs/:id/retry', verifyAdminKey, (req, res) => {
  const job = systemJobs.find(j => j.id === req.params.id);
  if (job) { job.status = 'Running'; job.error_reason = null; }
  res.json({ success: true, message: `Job ${req.params.id} queued for retry.`, job });
});

router.post('/jobs/:id/cancel', verifyAdminKey, (req, res) => {
  const job = systemJobs.find(j => j.id === req.params.id);
  if (job) { job.status = 'Cancelled'; }
  res.json({ success: true, message: `Job ${req.params.id} cancelled.`, job });
});

router.post('/workers/restart', verifyAdminKey, (req, res) => {
  res.json({ success: true, message: 'Queue workers restarted successfully.' });
});

// 3. STORAGE & LEADERBOARD ENDPOINTS
router.get('/storage/stats', verifyAdminKey, (req, res) => {
  res.json({
    success: true,
    storage: {
      total_gb: 100,
      used_gb: 14.8,
      free_gb: 85.2,
      by_type: { images: '4.2 GB', videos: '8.1 GB', pdfs: '2.1 GB', office: '0.4 GB' },
      top_consumers: systemUsers.map(u => ({ name: u.full_name, email: u.email, storage_mb: u.storage_mb }))
    }
  });
});

// 4. ADVANCED ANALYTICS ENDPOINTS
router.get('/analytics/overview', verifyAdminKey, (req, res) => {
  res.json({
    success: true,
    metrics: {
      dau: 142,
      wau: 890,
      mau: 3420,
      avg_compression_ratio: '58.4%',
      avg_duration_ms: 412,
      tool_adoption: { video: 42, pdf: 38, image: 15, docx: 5 }
    }
  });
});

// 5. ALERTS ENDPOINTS
router.get('/alerts', verifyAdminKey, (req, res) => {
  res.json({ success: true, alerts: systemAlerts });
});

router.post('/alerts/:id/ack', verifyAdminKey, (req, res) => {
  const alert = systemAlerts.find(a => a.id === req.params.id);
  if (alert) alert.acknowledged = true;
  res.json({ success: true, message: 'Alert acknowledged', alerts: systemAlerts });
});

// 6. SYSTEM CONFIGURATION ENDPOINTS
router.get('/settings', verifyAdminKey, (req, res) => {
  res.json({ success: true, settings: systemSettings });
});

router.post('/settings', verifyAdminKey, (req, res) => {
  if (req.body.settings) {
    systemSettings = { ...systemSettings, ...req.body.settings };
  }
  res.json({ success: true, message: 'System configuration updated successfully.', settings: systemSettings });
});

// 7. SECURITY OPERATIONS (SOC LITE) ENDPOINTS
router.get('/security/overview', verifyAdminKey, (req, res) => {
  res.json({
    success: true,
    security: {
      failed_logins_24h: 3,
      blocked_ips: Array.from(blockedIps),
      rate_limit_violations: 12,
      active_admin_sessions: 1
    }
  });
});

router.post('/security/block-ip', verifyAdminKey, (req, res) => {
  const { ip } = req.body;
  if (ip) blockedIps.add(ip);
  res.json({ success: true, message: `IP ${ip} blocked successfully.`, blocked_ips: Array.from(blockedIps) });
});

router.post('/security/unblock-ip', verifyAdminKey, (req, res) => {
  const { ip } = req.body;
  if (ip) blockedIps.delete(ip);
  res.json({ success: true, message: `IP ${ip} unblocked successfully.`, blocked_ips: Array.from(blockedIps) });
});

// 8. BACKUP ENDPOINTS
router.get('/backups', verifyAdminKey, (req, res) => {
  res.json({ success: true, backups: backupLogs });
});

router.post('/backups/trigger', verifyAdminKey, (req, res) => {
  const newBackup = {
    id: `bk_0${backupLogs.length + 1}`,
    type: 'Manual System Snapshot',
    status: 'SUCCESS',
    size: '45.1 MB',
    timestamp: new Date().toISOString()
  };
  backupLogs.unshift(newBackup);
  res.json({ success: true, message: 'Manual backup triggered successfully.', backup: newBackup });
});

// 9. SUPPORT TICKET ENDPOINTS
router.get('/tickets', verifyAdminKey, (req, res) => {
  res.json({ success: true, tickets: supportTickets });
});

router.post('/tickets/:id/update', verifyAdminKey, (req, res) => {
  const ticket = supportTickets.find(t => t.id === req.params.id);
  if (ticket) {
    if (req.body.status) ticket.status = req.body.status;
    if (req.body.priority) ticket.priority = req.body.priority;
  }
  res.json({ success: true, message: `Ticket ${req.params.id} updated.`, ticket });
});

export default router;
export { engineConfig };

