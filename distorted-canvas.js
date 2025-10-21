async function addDraggablePolygon(viewer) {
  // Initial 4 corners (lon, lat)
  const positions = [
    Cesium.Cartesian3.fromDegrees(-75, 35),
    Cesium.Cartesian3.fromDegrees(-75, 40),
    Cesium.Cartesian3.fromDegrees(-70, 40),
    Cesium.Cartesian3.fromDegrees(-70, 35),
  ];

  // Create draggable points
  const points = positions.map(pos =>
    viewer.entities.add({
      position: pos,
      point: { pixelSize: 10, color: Cesium.Color.RED },
    })
  );

  // Two canvases for swapping
  const canvasA = document.createElement("canvas");
  const canvasB = document.createElement("canvas");
  canvasA.width = canvasB.width = 1024;
  canvasA.height = canvasB.height = 1024;

  // Append for debugging (optional)
  canvasA.style.position = canvasB.style.position = "absolute";
  canvasA.style.top = canvasB.style.top = "-9999px";
  document.body.appendChild(canvasA);
  document.body.appendChild(canvasB);

  let curCanvas = "a";
  // const baseImage = new Image();
  // baseImage.src = "nature.jpg";
  
  const videoElement = await loadVideo("truck.mp4");

  // Create contexts and initialize Perspective ONCE
  const ctxA = canvasA.getContext("2d");
  const ctxB = canvasB.getContext("2d");
  const perspectiveA = new Perspective(ctxA, videoElement);
  const perspectiveB = new Perspective(ctxB, videoElement);

  function getCartographics() {
    return points.map(p =>
      Cesium.Cartographic.fromCartesian(
        p.position.getValue(Cesium.JulianDate.now())
      )
    );
  }

  /** Warp and redraw into the "current" canvas */
  function warpImageToPolygon(activeCanvas) {
    // if (!baseImage.complete) return;

    const ctx = activeCanvas.getContext("2d");
    ctx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);

    const cartographics = getCartographics();
    if (cartographics.some(c => !c)) return;

    const lons = cartographics.map(c => c.longitude);
    const lats = cartographics.map(c => c.latitude);

    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const eps = 1e-9;
    const width = Math.max(maxLon - minLon, eps);
    const height = Math.max(maxLat - minLat, eps);

    // Map vertices into canvas space
    const dstRaw = cartographics.map(c => [
      ((c.longitude - minLon) / width) * activeCanvas.width,
      ((maxLat - c.latitude) / height) * activeCanvas.height,
    ]);

    const dstOrdered = dstRaw;
    if (!dstOrdered) return;

    // Use the correct pre-initialized Perspective instance
    if (activeCanvas === canvasA) {
      perspectiveA.draw(dstOrdered);
    } else {
      perspectiveB.draw(dstOrdered);
    }
  }

  // CallbackProperty returning alternating canvases
  function canvasCallback() {
    const activeCanvas = curCanvas === "a" ? canvasA : canvasB;
    warpImageToPolygon(activeCanvas);
    curCanvas = curCanvas === "a" ? "b" : "a";
    return activeCanvas; // <-- return actual canvas element
  }

  // Polygon entity with dynamic canvas
  const poly = viewer.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => {
        // Get the live positions of the 4 draggable points
        return new Cesium.PolygonHierarchy(points.map(p =>
          p.position.getValue(Cesium.JulianDate.now())
        ));
      }, false),
      material: new Cesium.ImageMaterialProperty({
        image: new Cesium.CallbackProperty(canvasCallback, false),
        transparent: true,
      }),
      classificationType: Cesium.ClassificationType.TERRAIN,
      clampToGround: true,
    },
  });

  // Dragging interaction
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
      if (viewer.scene.pickPositionSupported) {
        cartesian = viewer.scene.pickPosition(movement.endPosition);
      }
    } catch {
      cartesian = undefined;
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = viewer.camera.pickEllipsoid(
        movement.endPosition,
        viewer.scene.globe.ellipsoid
      );
    }
    if (Cesium.defined(cartesian)) {
      picked.position = cartesian;
      viewer.scene.requestRender();
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    picked = undefined;
    viewer.scene.screenSpaceCameraController.enableInputs = true;
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  // Initial draw
  // baseImage.onload = () => {
  //   viewer.scene.requestRender();
  // };
}
