
function addPermalink(window, Cesium) {
  const viewer = window.viewer; // assume viewer already created

  // Convert Cartesian to camera state (degrees)
  function getCameraState() {
    const camera = viewer.camera;
    const center = camera.positionCartographic || Cesium.Cartographic.fromCartesian(camera.position);
    const lon = Cesium.Math.toDegrees(center.longitude);
    const lat = Cesium.Math.toDegrees(center.latitude);
    const height = center.height;
    const heading = Cesium.Math.toDegrees(camera.heading);
    const pitch = Cesium.Math.toDegrees(camera.pitch);
    const roll = Cesium.Math.toDegrees(camera.roll || 0);
    return { lon, lat, height, heading, pitch, roll };
  }

  // Move camera to saved state (assumes degrees)
  function setCameraState(state, options = {}) {
    if (!state) return;
    const { lon, lat, height, heading, pitch, roll } = state;
    if ([lon, lat, height].some(v => v === undefined || Number.isNaN(+v))) return;

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(
        Cesium.Math.toRadians(lon),
        Cesium.Math.toRadians(lat),
        Number(height)
      ),
      orientation: {
        heading: Cesium.Math.toRadians(Number(heading) || 0),
        pitch: Cesium.Math.toRadians(Number(pitch) || 0),
        roll: Cesium.Math.toRadians(Number(roll) || 0)
      },
      ...options
    });
  }

  // Parse hash like "#camera=12.3,45.6,1000,30,-20,0"
  function parseHash(hash) {
    if (!hash) hash = window.location.hash;
    if (hash.startsWith('#')) hash = hash.slice(1);
    const params = new URLSearchParams(hash.replace(/&/g, '&'));
    const cam = params.get('camera');
    if (!cam) return null;
    const parts = cam.split(',').map(p => p.trim());
    if (parts.length < 3) return null; // need at least lon,lat,height
    return {
      lon: parseFloat(parts[0]),
      lat: parseFloat(parts[1]),
      height: parseFloat(parts[2]),
      heading: parts[3] !== undefined ? parseFloat(parts[3]) : 0,
      pitch: parts[4] !== undefined ? parseFloat(parts[4]) : 0,
      roll: parts[5] !== undefined ? parseFloat(parts[5]) : 0
    };
  }

  // Build hash string from state
  function buildHash(state) {
    const s = [
      state.lon.toFixed(6),
      state.lat.toFixed(6),
      Math.round(state.height),
      (state.heading || 0).toFixed(3),
      (state.pitch || 0).toFixed(3),
      (state.roll || 0).toFixed(3)
    ].join(',');
    return `#camera=${s}`;
  }

  // Replace hash without adding history entry
  function replaceHash(hash) {
    if (history && history.replaceState) {
      history.replaceState(null, '', window.location.pathname + window.location.search + hash);
    } else {
      window.location.hash = hash;
    }
  }

  /* --- Restore camera from hash on load --- */
  const existing = parseHash(window.location.hash);
  if (existing) {
    // jump there instantly on load
    setCameraState(existing, { duration: 0 });
  }

  /* --- Update hash when camera moves (debounced) --- */
  let updateTimer = null;
  const DEBOUNCE_MS = 200; // adjust to taste

  function scheduleHashUpdate() {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      const st = getCameraState();
      const h = buildHash(st);
      replaceHash(h);
      updateTimer = null;
    }, DEBOUNCE_MS);
  }

  // Use moveEnd (fires once camera movement finishes) if available.
  if (viewer.camera && viewer.camera.moveEnd) {
    viewer.camera.moveEnd.addEventListener(scheduleHashUpdate);
  } else {
    // fallback: listen for changed events (more noisy)
    viewer.camera.changed.addEventListener(scheduleHashUpdate);
  }

};
