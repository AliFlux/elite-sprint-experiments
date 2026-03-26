async function addDraggablePolygon(viewer, N = 4) {
  // Build NxN grid of (lon, lat) spanning a default region
  // Grid is stored row-major: index = row*N + col
  const lonMin = -75, lonMax = -70;
  const latMin =  35, latMax =  40;

  const positions = [];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const lon = lonMin + (col / (N - 1)) * (lonMax - lonMin);
      const lat = latMax - (row / (N - 1)) * (latMax - latMin); // top-row = high lat
      positions.push(Cesium.Cartesian3.fromDegrees(lon, lat));
    }
  }

  // Draggable point entities
  const points = positions.map((pos, i) =>
    viewer.entities.add({
      position: pos,
      point: {
        pixelSize: N <= 4 ? 10 : 7,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
      },
    })
  );

  // Double-buffered canvases
  const canvasA = document.createElement("canvas");
  const canvasB = document.createElement("canvas");
  canvasA.width = canvasB.width = 1024;
  canvasA.height = canvasB.height = 1024;
  canvasA.style.cssText = canvasB.style.cssText = "position:absolute;top:-9999px";
  document.body.append(canvasA, canvasB);

  let curCanvas = "a";

  const videoElement = await loadVideo("raw/videos/truck.mp4");

  const ctxA = canvasA.getContext("2d");
  const ctxB = canvasB.getContext("2d");
  const perspA = new Perspective(ctxA, videoElement, N);
  const perspB = new Perspective(ctxB, videoElement, N);

  // --- helpers ---

  function getCartographics() {
    const now = Cesium.JulianDate.now();
    return points.map(p =>
      Cesium.Cartographic.fromCartesian(p.position.getValue(now))
    );
  }

  function warpImageToPolygon(activeCanvas) {
    const ctx = activeCanvas.getContext("2d");
    ctx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);

    const carts = getCartographics();
    if (carts.some(c => !c)) return;

    const lons = carts.map(c => c.longitude);
    const lats = carts.map(c => c.latitude);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);

    const eps = 1e-9;
    const wLon = Math.max(maxLon - minLon, eps);
    const hLat = Math.max(maxLat - minLat, eps);

    // Map every grid point into canvas pixel space [0, canvasSize]
    const dstPoints = carts.map(c => [
      ((c.longitude - minLon) / wLon) * activeCanvas.width,
      ((maxLat - c.latitude) / hLat) * activeCanvas.height,
    ]);

    const persp = activeCanvas === canvasA ? perspA : perspB;
    persp.draw(dstPoints);
  }

  function canvasCallback() {
    const active = curCanvas === "a" ? canvasA : canvasB;
    warpImageToPolygon(active);
    curCanvas = curCanvas === "a" ? "b" : "a";
    return active;
  }

  // Polygon using all NxN points as a convex hull
  // For a grid we build a PolygonHierarchy from the outline path
  function getOutlinePositions() {
    const now = Cesium.JulianDate.now();
    // Walk the border: top row L→R, right col T→B, bottom row R→L, left col B→T
    const outline = [];
    for (let col = 0; col < N; col++)          outline.push(points[0 * N + col]);
    for (let row = 1; row < N; row++)          outline.push(points[row * N + (N - 1)]);
    for (let col = N - 2; col >= 0; col--)     outline.push(points[(N - 1) * N + col]);
    for (let row = N - 2; row >= 1; row--)     outline.push(points[row * N + 0]);
    return outline.map(p => p.position.getValue(now));
  }

  viewer.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() =>
        new Cesium.PolygonHierarchy(getOutlinePositions()), false),
      material: new Cesium.ImageMaterialProperty({
        image: new Cesium.CallbackProperty(canvasCallback, false),
        transparent: true,
      }),
      classificationType: Cesium.ClassificationType.TERRAIN,
      clampToGround: true,
    },
  });

  // --- drag interaction ---
  let picked;
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction(click => {
    const pick = viewer.scene.pick(click.position);
    if (Cesium.defined(pick) && points.includes(pick.id)) {
      picked = pick.id;
      viewer.scene.screenSpaceCameraController.enableInputs = false;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction(movement => {
    if (!picked) return;
    let cartesian;
    try {
      if (viewer.scene.pickPositionSupported)
        cartesian = viewer.scene.pickPosition(movement.endPosition);
    } catch { cartesian = undefined; }
    if (!Cesium.defined(cartesian))
      cartesian = viewer.camera.pickEllipsoid(
        movement.endPosition, viewer.scene.globe.ellipsoid
      );
    if (Cesium.defined(cartesian)) {
      picked.position = cartesian;
      viewer.scene.requestRender();
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    picked = undefined;
    viewer.scene.screenSpaceCameraController.enableInputs = true;
  }, Cesium.ScreenSpaceEventType.LEFT_UP);
}