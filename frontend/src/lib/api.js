export function getApiUrl(path) {
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  // Explicit env override
  if (import.meta.env.VITE_API_URL) {
    const base = import.meta.env.VITE_API_URL.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';

    // Native mobile Capacitor, Electron file://, or ANY local dev server port not running Express on 3001
    if (
      window.location.protocol === 'file:' || 
      window.location.protocol === 'capacitor:' || 
      (isLocalhost && window.location.port !== '3001')
    ) {
      return `http://localhost:3001${path}`;
    }
  }

  // Unified production server (port 3001 or cloud host): frontend & API served on same origin
  return path;
}
