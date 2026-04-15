export const getBackendUrl = async () => {
  console.log("getBackendUrl: determining backend URL...");
  
  let port: any = null;

  // 1. Try to use the exposed electronAPI from preload
  // @ts-ignore
  if (window.electronAPI && window.electronAPI.getBackendPort) {
    try {
      port = await window.electronAPI.getBackendPort();
      if (port) {
        console.log(`getBackendUrl: Using port from electronAPI -> ${port}`);
        return `http://127.0.0.1:${port}`;
      }
    } catch (e) {
      console.error("getBackendUrl: Failed to get port from electronAPI:", e);
    }
  }

  // 2. Fallback for window.require (legacy/compatibility)
  // @ts-ignore
  if (window.require) {
    try {
      // @ts-ignore
      const { ipcRenderer } = window.require('electron');
      port = await ipcRenderer.invoke('get-port');
      if (port) {
        console.log(`getBackendUrl: Using port from window.require -> ${port}`);
        return `http://127.0.0.1:${port}`;
      }
    } catch (e) {
      console.error("getBackendUrl: Failed to get port from window.require:", e);
    }
  }

  // 3. Try query parameter (useful for dev mode reloads)
  const searchParams = new URLSearchParams(window.location.search);
  const queryPort = searchParams.get('backendPort');
  if (queryPort) {
    console.log(`getBackendUrl: Using port from query param -> ${queryPort}`);
    return `http://127.0.0.1:${queryPort}`;
  }

  // 4. Last resort
  console.warn("getBackendUrl: All dynamic port lookups failed. Defaulting to 8000.");
  return 'http://127.0.0.1:8000';
};
