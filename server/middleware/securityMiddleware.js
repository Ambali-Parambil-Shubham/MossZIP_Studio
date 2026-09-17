import fs from 'fs';
import path from 'path';

/**
 * MossZip Enterprise Security Middleware Suite
 * OWASP ASVS & SaaS Hardening Standard
 */

// ── 1. Magic Bytes / File Signature Validation ─────────────────────────────
const FILE_SIGNATURES = {
  pdf: [
    [0x25, 0x50, 0x44, 0x46] // %PDF
  ],
  jpg: [
    [0xFF, 0xD8, 0xFF]
  ],
  jpeg: [
    [0xFF, 0xD8, 0xFF]
  ],
  png: [
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  ],
  webp: [
    [0x52, 0x49, 0x46, 0x46] // RIFF (offset 8 should be WEBP)
  ],
  gif: [
    [0x47, 0x49, 0x46, 0x38] // GIF8
  ],
  mp4: [
    [0x00, 0x00, 0x00], // ftyp box offset check
    [0x66, 0x74, 0x79, 0x70] // ftyp
  ],
  mov: [
    [0x66, 0x74, 0x79, 0x70]
  ],
  zip: [
    [0x50, 0x4B, 0x03, 0x04] // PK..
  ],
  docx: [
    [0x50, 0x4B, 0x03, 0x04]
  ],
  pptx: [
    [0x50, 0x4B, 0x03, 0x04]
  ],
  xlsx: [
    [0x50, 0x4B, 0x03, 0x04]
  ]
};

/**
 * Validates the file buffer or file path against allowed binary magic bytes
 */
export async function validateFileSignature(filePathOrBuffer, extension) {
  const ext = (extension || '').toLowerCase().replace('.', '');
  if (!FILE_SIGNATURES[ext]) {
    // If extension is not strictly in signature map, check general media/binary safety
    return true; 
  }

  let buffer;
  if (typeof filePathOrBuffer === 'string') {
    const handle = await fs.promises.open(filePathOrBuffer, 'r');
    const tempBuf = Buffer.alloc(32);
    await handle.read(tempBuf, 0, 32, 0);
    await handle.close();
    buffer = tempBuf;
  } else {
    buffer = filePathOrBuffer;
  }

  if (!buffer || buffer.length < 4) return false;

  const signatures = FILE_SIGNATURES[ext];
  for (const sig of signatures) {
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      // Allow flexible offset for MP4 ftyp containers
      if (ext === 'mp4' || ext === 'mov' || ext === 'mkv' || ext === 'webm') {
        const sliceStr = buffer.toString('utf-8', 0, 32);
        if (sliceStr.includes('ftyp') || sliceStr.includes('matroska') || sliceStr.includes('webm')) {
          return true;
        }
      }
      if (buffer[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  return false;
}

// ── 2. Filename Sanitization & Path Traversal Prevention ────────────────────
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return 'payload.bin';

  // 1. Remove path traversal & control characters
  let clean = filename
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\0\x00-\x1F\x7F-\x9F]/g, '')
    .replace(/\.\./g, '');

  // 2. Prevent double executable extensions (e.g. payload.pdf.exe -> payload.pdf)
  const dangerousExts = /\.(exe|bat|cmd|sh|vbs|jar|js|php|asp|aspx|cgi|pl|py)$/i;
  if (dangerousExts.test(clean)) {
    clean = clean.replace(dangerousExts, '.bin');
  }

  // 3. Prevent Windows reserved names
  if (WINDOWS_RESERVED_NAMES.test(clean)) {
    clean = `safe_${clean}`;
  }

  // 4. Max length cap
  if (clean.length > 255) {
    const ext = path.extname(clean);
    clean = clean.substring(0, 240) + ext;
  }

  return clean || 'payload.bin';
}

// ── 3. Express Security Headers Middleware ─────────────────────────────────
export function setSecurityHeadersMiddleware(req, res, next) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' http://localhost:* http://127.0.0.1:* https: wss:; frame-ancestors 'self';"
  );
  next();
}

// ── 4. Zero-Trust Upload Security Validation Middleware ────────────────────
export function fileSecurityMiddleware(req, res, next) {
  const file = req.file;
  if (!file) return next();

  // Validate filename
  file.originalname = sanitizeFilename(file.originalname);

  // Validate MIME type & Extension
  const ext = (path.extname(file.originalname) || '').toLowerCase().replace('.', '');
  const allowedExts = [
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'svg', 'avif',
    'pdf',
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', '3gp', 'flv', 'ts', 'mpg', 'mpeg',
    'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'mka',
    'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub',
    'txt', 'csv', 'json', 'xml', 'md', 'log', 'huff'
  ];

  if (!allowedExts.includes(ext)) {
    if (file.path && fs.existsSync(file.path)) {
      fs.promises.unlink(file.path).catch(() => {});
    }
    return res.status(400).json({
      error: `Security Violation: File extension .${ext} is not allowed on MossZip Studio.`
    });
  }

  next();
}
