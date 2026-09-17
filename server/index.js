import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import compressRouter from './routes/compress.js';
import imageToPdfRouter from './routes/imageToPdf.js';
import pdfToWordRouter from './routes/pdfToWord.js';
import mergePdfRouter from './routes/mergePdf.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import { startMonthlyCleanupScheduler } from './services/monthlyCleanupService.js';
import { setSecurityHeadersMiddleware } from './middleware/securityMiddleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Enforce OWASP Security Headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options)
app.use(setSecurityHeadersMiddleware);

// Fully permissive CORS for seamless production deployment across static site & API web service
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-admin-key',
    'x-user-name',
    'X-Original-Size',
    'X-Compressed-Size',
    'Accept',
    'Origin',
    'X-Requested-With',
  ],
  exposedHeaders: ['X-Original-Size', 'X-Compressed-Size', 'Content-Disposition'],
}));
app.options('*', cors());

// Live API Request Logger
app.use((req, res, next) => {
  if (req.url.startsWith('/api')) {
    console.log(`[HTTP ${req.method}] ${req.url} (Origin: ${req.headers.origin || 'same-origin'}, IP: ${req.ip})`);
  }
  next();
});

app.use(compression());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// Register backend API routes
app.use('/api/compress', compressRouter);
app.use('/api/image-to-pdf', imageToPdfRouter);
app.use('/api/pdf-to-word', pdfToWordRouter);
app.use('/api/merge-pdfs', mergePdfRouter);
app.use('/api/admin', adminRouter);
app.use('/api/auth', authRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'MossZip Engine v2.4' });
});

// GET /api/download/desktop - Direct Desktop Application Download
app.get('/api/download/desktop', (req, res) => {
  const zipPathPublic = path.join(__dirname, '../frontend/public/MossZip_Studio.zip');
  const zipPathDist = path.join(__dirname, '../frontend/dist/MossZip_Studio.zip');
  const zipPathDesktop = path.join(__dirname, '../dist-desktop/MossZip_Studio.zip');

  if (fs.existsSync(zipPathPublic)) {
    return res.download(zipPathPublic, 'MossZip_Studio.zip');
  }
  if (fs.existsSync(zipPathDist)) {
    return res.download(zipPathDist, 'MossZip_Studio.zip');
  }
  if (fs.existsSync(zipPathDesktop)) {
    return res.download(zipPathDesktop, 'MossZip_Studio.zip');
  }

  // Production Fallback: Render clean download info page instead of cross-origin 404
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>MossZip Studio — Desktop App Download</title>
        <style>
          body { font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; background: #121A13; color: #FFF7E2; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { max-width: 480px; width: 100%; background: #1C271D; padding: 36px; border-radius: 24px; border: 1px solid rgba(79, 99, 61, 0.4); text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          h2 { margin: 0 0 12px 0; color: #FFF7E2; font-size: 24px; }
          p { color: #A6B49B; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
          .btn { display: inline-flex; align-items: center; gap: 8px; padding: 14px 28px; background: #4F633D; color: #FFF7E2; text-decoration: none; border-radius: 14px; font-weight: 700; font-size: 14px; transition: all 0.2s; }
          .btn:hover { background: #61794C; transform: translateY(-2px); }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>💻 MossZip Studio Desktop App</h2>
          <p>Download the standalone Windows Desktop application for offline high-speed compression and conversion tools.</p>
          <a class="btn" href="https://github.com/Ambali-Parambil-Shubham/MossZIP_File-Compressor" target="_blank">
            <span>🚀 Download on GitHub Releases</span>
          </a>
        </div>
      </body>
    </html>
  `);
});

// Serve Frontend Static Build Assets for 1-Click Unified Web Service Deployment on Render / Vercel
const distPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API route not found' });
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// High-Speed Uploads Directory Garbage Collector (sweeps files > 10 minutes old every 5 minutes)
const uploadDirs = [
  path.join(__dirname, 'uploads'),
  path.join(os.tmpdir(), 'mosszip_uploads')
];

setInterval(async () => {
  const now = Date.now();
  for (const dir of uploadDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (stat && now - stat.mtimeMs > 10 * 60 * 1000) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
      }
    } catch (e) {}
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`[MossZip Server] Express server listening on http://localhost:${PORT}`);

  // Start the monthly history cleanup scheduler (fires on 1st of each month at 02:00 AM)
  startMonthlyCleanupScheduler();
});
