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
    // Native mobile Capacitor, Electron file://, or Vite dev server (port 5173) -> target backend port 3001 directly
    if (
      window.location.protocol === 'file:' || 
      window.location.protocol === 'capacitor:' || 
      window.location.port === '5173'
    ) {
      return `http://localhost:3001${path}`;
    }
  }

  // Unified production server (port 3001 or cloud host): frontend & API served on same origin
  return path;
}
