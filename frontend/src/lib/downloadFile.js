/**
 * downloadFile — Universal cross-platform file downloader
 *
 * • Web / Electron (Desktop): standard <a download> trick
 * • Android (Capacitor WebView): <a download> is silently ignored by the
 *   Android WebView, so we use @capacitor/filesystem to save the file to the
 *   Downloads folder and @capacitor/share to surface the Android share sheet,
 *   which lets the user open it with any compatible app.
 *
 * @param {Blob}   blob      — the file content
 * @param {string} fileName  — suggested filename including extension
 */
export async function downloadFile(blob, fileName) {
  // ── Detect Capacitor (Android / iOS) ──────────────────────────────────────
  const isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  if (isCapacitor) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');

      // Convert blob to base64
      const base64 = await blobToBase64(blob);
      const base64Data = base64.split(',')[1]; // strip the "data:...;base64," prefix

      // Write to the Downloads directory
      await Filesystem.writeFile({
        path: fileName,
        data: base64Data,
        directory: Directory.Documents, // accessible on Android
        recursive: true,
      });

      // Get the URI so we can pass it to Share
      const fileUri = await Filesystem.getUri({
        path: fileName,
        directory: Directory.Documents,
      });

      // Open Android share sheet — user can open with their preferred app
      await Share.share({
        title: `Download: ${fileName}`,
        text: `Your file "${fileName}" is ready.`,
        url: fileUri.uri,
        dialogTitle: 'Open or save your file',
      });
    } catch (err) {
      console.error('[downloadFile] Capacitor save failed:', err);
      // Fallback: attempt browser download anyway
      browserDownload(blob, fileName);
    }
  } else {
    // ── Standard web / Electron download ────────────────────────────────────
    browserDownload(blob, fileName);
  }
}

/** Standard <a download> browser trigger */
function browserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    try {
      if (document.body.contains(a)) {
        document.body.removeChild(a);
      }
    } catch (e) {}

    // Safe 60-second delayed revocation to allow complete disk flushing on large files
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }, 60000);
  }, 100);
}

/** Convert a Blob to a base64 data URL */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
