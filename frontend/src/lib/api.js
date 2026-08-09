export function getApiUrl(path) {
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  // Explicit env override
  if (import.meta.env.VITE_API_URL) {
    const base = import.meta.env.VITE_API_URL.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  // Native mobile Capacitor container or Electron file:// protocol
  if (typeof window !== 'undefined') {
    if (window.location.protocol === 'file:' || window.location.protocol === 'capacitor:') {
      return `http://localhost:3001${path}`;
    }
  }

  // Unified production server: frontend and API are served on same origin
  return path;
}
