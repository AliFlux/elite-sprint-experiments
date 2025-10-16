function addDraggablePolygon(viewer) {
  // --- Configuration: initial corners (order: bottom-left, bottom-right, top-right, top-left)
  const initialPositions = [
    Cesium.Cartesian3.fromDegrees(-75, 35),
    Cesium.Cartesian3.fromDegrees(-70, 35),
    Cesium.Cartesian3.fromDegrees(-70, 40),
    Cesium.Cartesian3.fromDegrees(-75, 40),
  ];

  // per-corner colors (same order)
  const cornerColors = [
    Cesium.Color.RED,
    Cesium.Color.GREEN,
    Cesium.Color.BLUE,
    Cesium.Color.YELLOW,
  ];

  // Register shader material once
  if (!Cesium.Material._materialCache.getMaterial('CornerColors')) {
    Cesium.Material._materialCache.addMaterial('CornerColors', {
      fabric: {
        type: 'CornerColors',
        uniforms: {
          color0: cornerColors[0],
          color1: cornerColors[1],
          color2: cornerColors[2],
          color3: cornerColors[3],
        },
        source: `
          czm_material czm_getMaterial(czm_materialInput materialInput)
          {
              czm_material material = czm_getDefaultMaterial(materialInput);

              vec2 st = materialInput.st;

              vec4 bottom = mix(color0, color1, st.x);
              vec4 top    = mix(color3, color2, st.x);
              vec4 finalColor = mix(bottom, top, st.y);

              material.diffuse = finalColor.rgb;
              material.alpha   = finalColor.a;
              return material;
          }
        `
      }
    });
  }

  // Create draggable point entities
  const points = initialPositions.map((pos) =>
    viewer.entities.add({
      position: pos,
      point: {
        pixelSize: 10,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    })
  );

  let primitive = null;
  let updateTimeout = null;
  let pendingUpdate = false;
  let updating = false;

  // Inverse bilinear mapping (Newton's method) in 2D:
  function inverseBilinear(target, p00, p10, p11, p01) {
    // all points are [x, y] (we'll use lon/lat in radians)
    // initial guess: normalized to bbox
    const xs = [p00[0], p10[0], p11[0], p01[0]];
    const ys = [p00[1], p10[1], p11[1], p01[1]];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const eps = 1e-12;

    let u = (target[0] - minX) / Math.max(maxX - minX, eps);
    let v = (target[1] - minY) / Math.max(maxY - minY, eps);
    u = Math.max(0.0, Math.min(1.0, u));
    v = Math.max(0.0, Math.min(1.0, v));

    for (let iter = 0; iter < 10; iter++) {
      // B(u,v)
      const one_u = 1.0 - u;
      const one_v = 1.0 - v;

      const bx = one_u * one_v * p00[0] + u * one_v * p10[0] + u * v * p11[0] + one_u * v * p01[0];
      const by = one_u * one_v * p00[1] + u * one_v * p10[1] + u * v * p11[1] + one_u * v * p01[1];

      const fx = bx - target[0];
      const fy = by - target[1];
      const err = Math.sqrt(fx * fx + fy * fy);
      if (err < 1e-10) break;

      // partials
      const dBdu_x = one_v * (p10[0] - p00[0]) + v * (p11[0] - p01[0]);
      const dBdu_y = one_v * (p10[1] - p00[1]) + v * (p11[1] - p01[1]);

      const dBdv_x = one_u * (p01[0] - p00[0]) + u * (p11[0] - p10[0]);
      const dBdv_y = one_u * (p01[1] - p00[1]) + u * (p11[1] - p10[1]);

      // Jacobian determinant
      const det = dBdu_x * dBdv_y - dBdu_y * dBdv_x;
      if (Math.abs(det) < 1e-14) break;

      // Solve for delta = J^{-1} * (-f)
      const deltaU = (-dBdv_y * fx + dBdv_x * fy) / det; // derived from inverse formula
      const deltaV = ( dBdu_y * fx - dBdu_x * fy) / det;

      u += deltaU;
      v += deltaV;

      // clamp iterate a bit
      if (u < -0.5 || u > 1.5 || v < -0.5 || v > 1.5) {
        u = Math.max(0.0, Math.min(1.0, u));
        v = Math.max(0.0, Math.min(1.0, v));
        break;
      }
    }

    // final clamp
    return [Math.max(0.0, Math.min(1.0, u)), Math.max(0.0, Math.min(1.0, v))];
  }

  // Main update (async because we sample terrain)
  async function updatePolygon() {
    // debounce guard
    if (updating) {
      pendingUpdate = true;
      return;
    }
    updating = true;
    pendingUpdate = false;

    try {
      // remove old primitive if any
      if (primitive) {
        viewer.scene.primitives.remove(primitive);
        primitive = null;
      }

      // collect Cartographic corners (lon, lat). We'll sample heights.
      const cartographics = points.map((p) => {
        const pos = p.position.getValue(Cesium.JulianDate.now());
        return Cesium.Cartographic.fromCartesian(pos);
      });

      // sample terrain heights if possible
      let sampledCartographics = cartographics;
      if (viewer.terrainProvider && Cesium.sampleTerrainMostDetailed) {
        try {
          sampledCartographics = await Cesium.sampleTerrainMostDetailed(
            viewer.terrainProvider,
            cartographics
          );
        } catch (err) {
          // sampling failed — fallback to zero heights
          sampledCartographics = cartographics.map((c) => {
            return new Cesium.Cartographic(c.longitude, c.latitude, c.height || 0);
          });
        }
      } else {
        // no terrain provider -> keep current heights or zero
        sampledCartographics = cartographics.map((c) => {
          return new Cesium.Cartographic(c.longitude, c.latitude, c.height || 0);
        });
      }

      // Build Cartesian3 positions that *include* terrain heights
      const cartesianPositions = sampledCartographics.map((c) =>
        Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height || 0)
      );

      // Create PolygonGeometry (POSITION_ONLY) and then createGeometry to get final tessellation
      const polygonGeom = new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(cartesianPositions),
        vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
      });

      const geometry = Cesium.PolygonGeometry.createGeometry(polygonGeom);
      if (!geometry || !geometry.attributes || !geometry.attributes.position) {
        console.error('Failed to create polygon geometry.');
        updating = false;
        return;
      }

      // Prepare corners in lon/lat (radians) for inverse mapping
      // Use the sampledCartographics order (same as points array)
      const c00 = [sampledCartographics[0].longitude, sampledCartographics[0].latitude];
      const c10 = [sampledCartographics[1].longitude, sampledCartographics[1].latitude];
      const c11 = [sampledCartographics[2].longitude, sampledCartographics[2].latitude];
      const c01 = [sampledCartographics[3].longitude, sampledCartographics[3].latitude];

      // For every final geometry vertex compute its lon/lat and invert bilinear to get (u,v)
      const positions = geometry.attributes.position.values; // Float64Array [x,y,z,...]
      const vertexCount = positions.length / 3;
      const st = new Float32Array(vertexCount * 2);

      for (let i = 0; i < vertexCount; i++) {
        const x = positions[3 * i];
        const y = positions[3 * i + 1];
        const z = positions[3 * i + 2];
        const cart = new Cesium.Cartesian3(x, y, z);
        const carto = Cesium.Cartographic.fromCartesian(cart);

        const target = [carto.longitude, carto.latitude];

        // invert bilinear mapping to find u,v in [0,1]
        let uv = inverseBilinear(target, c00, c10, c11, c01);

        // fallback if something went wrong
        if (!isFinite(uv[0]) || !isFinite(uv[1])) {
          // simple bbox projection as fallback
          const lonArr = [c00[0], c10[0], c11[0], c01[0]];
          const latArr = [c00[1], c10[1], c11[1], c01[1]];
          const minLon = Math.min(...lonArr), maxLon = Math.max(...lonArr);
          const minLat = Math.min(...latArr), maxLat = Math.max(...latArr);
          uv = [
            (carto.longitude - minLon) / Math.max(maxLon - minLon, 1e-12),
            (carto.latitude - minLat) / Math.max(maxLat - minLat, 1e-12),
          ];
        }

        st[2 * i] = uv[0];
        st[2 * i + 1] = uv[1];
      }

      // Build GeometryInstance using the already-created Geometry and the computed 'st' attribute.
      const geometryInstance = new Cesium.GeometryInstance({
        geometry: geometry,
        attributes: {
          // The name 'st' will be exposed to the material as materialInput.st
          st: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: st,
          }),
        },
      });

      // Create primitive using MaterialAppearance that will read materialInput.st
      primitive = new Cesium.Primitive({
        geometryInstances: geometryInstance,
        appearance: new Cesium.MaterialAppearance({
          material: new Cesium.Material({
            fabric: { type: 'CornerColors' },
          }),
          translucent: true,
        }),
        asynchronous: false,
      });

      viewer.scene.primitives.add(primitive);
    } catch (err) {
      // keep console-visible error for debugging
      console.error('updatePolygon error', err);
    } finally {
      updating = false;
      if (pendingUpdate) {
        pendingUpdate = false;
        // schedule next update (immediately)
        updatePolygon();
      }
    }
  }

  // Schedule (debounced) update to avoid spamming terrain requests on fast mousemove
  function scheduleUpdateDebounced() {
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    updateTimeout = setTimeout(() => {
      updateTimeout = null;
      updatePolygon();
    }, 80); // 80ms debounce — tweak as needed
  }

  // initial build (no terrain heights yet; updatePolygon will sample terrain)
  scheduleUpdateDebounced();

  // Drag handling (drag entities by updating their entity.position value)
  let picked;
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((click) => {
    picked = viewer.scene.pick(click.position);
    // if picked an entity point, disable camera pan/rotate
    if (picked && picked.id && points.includes(picked.id)) {
      viewer.scene.screenSpaceCameraController.enableInputs = false;
    } else {
      picked = undefined;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((movement) => {
    if (picked && picked.id && points.includes(picked.id)) {
      // Prefer pickPosition (works with depth) and fallback to pickEllipsoid
      let cartesian = null;
      if (viewer.scene.pickPositionSupported) {
        try {
          cartesian = viewer.scene.pickPosition(movement.endPosition);
        } catch (e) {
          cartesian = null;
        }
      }
      if (!cartesian) {
        cartesian = viewer.camera.pickEllipsoid(
          movement.endPosition,
          viewer.scene.globe.ellipsoid
        );
      }
      if (cartesian) {
        // update entity position (use setValue to keep it a Property)
        picked.id.position.setValue(cartesian);
        // schedule a debounced polygon rebuild (which will sample terrain)
        scheduleUpdateDebounced();
      }
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    // re-enable camera controls
    viewer.scene.screenSpaceCameraController.enableInputs = true;
    // ensure final geometry update
    scheduleUpdateDebounced();
    picked = undefined;
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  // Return the points and handler so caller can remove them later if desired
  return { points, handler, destroy: () => {
    if (primitive) viewer.scene.primitives.remove(primitive);
    points.forEach(p=>viewer.entities.remove(p));
    handler.destroy();
  } };
}
