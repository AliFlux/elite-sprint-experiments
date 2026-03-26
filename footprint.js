class Footprint {
    #viewer;
    #opts;
    #canvasA;
    #canvasB;
    #canvasContextA;
    #canvasContextB;
    #curCanvas;
    #baseVideo;
    #perspectiveA;
    #perspectiveB;
    #metadata;

    // persistent entities
    #platformEntity = null;
    #polygonEntity = null;
    #offsetEntity = null;
    #mouseRayEntity = null;
    #rayEntities = [];

    // runtime state
    #platformOrientation = null;

    // immutable snapshots
    #snapshotSensorPos = null;
    #snapshotPlatformPos = null;
    #snapshotGrid = null;       // 4×4 grid of Cartesian3, row-major
    #snapshotCorners = null;    // just the 4 outer corners (for polygon outline + rays)

    #mousePosition = null;
    #mouseRayEnd = null;

    // grid dimension
    static #GRID_N = 4;

    // public reactive properties
    #showModel;
    #showRays;
    #showOffsetPolygon;
    #showVideoOverlay;
    #videoOverlayOpacity;
    #modelMinimumPixelSize;
    #modelOpacity;
    #offsetPolygonOpacity;
    #offsetPolygonColor;
    #sensorRelativePosition;
    #videoFilter;
    #videoBackground;
    #intersectionWith;

    // ---------- PUBLIC GETTERS/SETTERS ----------
    get showModel() { return this.#showModel; }
    set showModel(v) { this.#showModel = !!v; }

    get showRays() { return this.#showRays; }
    set showRays(v) { this.#showRays = !!v; }

    get showOffsetPolygon() { return this.#showOffsetPolygon; }
    set showOffsetPolygon(v) { this.#showOffsetPolygon = !!v; }

    get showVideoOverlay() { return this.#showVideoOverlay; }
    set showVideoOverlay(v) { this.#showVideoOverlay = !!v; }

    get videoOverlayOpacity() { return this.#videoOverlayOpacity; }
    set videoOverlayOpacity(v) { this.#videoOverlayOpacity = Math.max(0, Math.min(1, v)); }

    get modelMinimumPixelSize() { return this.#modelMinimumPixelSize; }
    set modelMinimumPixelSize(v) { this.#modelMinimumPixelSize = v; }

    get modelOpacity() { return this.#modelOpacity; }
    set modelOpacity(v) { this.#modelOpacity = Math.max(0, Math.min(1, v)); }

    get offsetPolygonOpacity() { return this.#offsetPolygonOpacity; }
    set offsetPolygonOpacity(v) { this.#offsetPolygonOpacity = Math.max(0, Math.min(1, v)); }

    get offsetPolygonColor() { return this.#offsetPolygonColor; }
    set offsetPolygonColor(v) {
        if (Array.isArray(v) && v.length === 3) this.#offsetPolygonColor = v;
    }

    get sensorRelativePosition() { return this.#sensorRelativePosition; }
    set sensorRelativePosition(v) { this.#sensorRelativePosition = v; }

    get videoFilter() { return this.#videoFilter; }
    set videoFilter(v) {
        this.#videoFilter = v === "sobel" ? "sobel" : null;
        this.#initPerspective();
        this.#updateWarpedView();
    }

    get videoBackground() { return this.#videoBackground; }
    set videoBackground(v) {
        if (Array.isArray(v) && v.length === 4) this.#videoBackground = v;
        this.#initPerspective();
        this.#updateWarpedView();
    }

    get intersectionWith() { return this.#intersectionWith; }
    set intersectionWith(v) {
        this.#intersectionWith = (v === "terrain" || v === "ellipsoid") ? v : "terrain";
        this.#initPerspective();
        this.#updateWarpedView();
    }

    constructor(options = {}) {
        const {
            videoElement,
            modelUrl = null,
            showModel = true,
            showRays = true,
            showOffsetPolygon = false,
            showVideoOverlay = true,
            videoOverlayOpacity = 1,
            modelMinimumPixelSize = 250,
            modelOpacity = 1,
            offsetPolygonOpacity = 0.2,
            offsetPolygonColor = [255, 0, 0],
            sensorRelativePosition = [0, 0, 0],
            videoFilter = null,
            videoBackground = [0, 0, 0, 0],
            intersectionWith = "terrain"
        } = options;

        if (!(videoElement instanceof HTMLVideoElement)) {
            throw new Error("Footprint expects opts.videoElement as an HTMLVideoElement");
        }

        this.#opts = { modelUrl };
        this.#baseVideo = videoElement;
        this.#curCanvas = "a";

        this.#showModel = showModel;
        this.#showRays = showRays;
        this.#showOffsetPolygon = showOffsetPolygon;
        this.#showVideoOverlay = showVideoOverlay;
        this.#videoOverlayOpacity = videoOverlayOpacity;
        this.#modelMinimumPixelSize = modelMinimumPixelSize;
        this.#modelOpacity = modelOpacity;
        this.#offsetPolygonOpacity = offsetPolygonOpacity;
        this.#offsetPolygonColor = offsetPolygonColor;
        this.#sensorRelativePosition = sensorRelativePosition;
        this.#videoFilter = videoFilter;
        this.#videoBackground = videoBackground;
        this.#intersectionWith = intersectionWith;

        this.#baseVideo.onmouseenter = (e) => {};

        this.#baseVideo.onmousemove = (e) => {
            const position = getFitContentPosition(this.#baseVideo, e.clientX, e.clientY, true);
            if (!position) {
                this.#mouseRayEnd = null;
                return;
            }
            this.#mousePosition = position;
            this.#computeMouseRay();
        };

        this.#baseVideo.onmouseleave = (e) => {
            this.#mouseRayEnd = null;
        };

        if (this.#baseVideo.readyState >= 1) {
            this.#initOffscreenFromVideo();
        } else {
            this.#baseVideo.addEventListener("loadedmetadata", () => {
                this.#initOffscreenFromVideo();
                this.#triggerWarpUpdate();
            }, { once: true });
        }
    }

    add(viewer) {
        this.#viewer = viewer;
        this.#setupScene();
        this.#createEntities();
    }

    update(metadata) {
        if (!this.#viewer) return;
        this.#metadata = metadata;
        this.#triggerWarpUpdate();
    }

    remove() {
        if (!this.#viewer) return;
        const ents = [this.#platformEntity, this.#polygonEntity, this.#offsetEntity];
        ents.forEach(e => e && this.#viewer.entities.remove(e));
        this.#rayEntities.forEach(e => this.#viewer.entities.remove(e));
        this.#rayEntities = [];
        this.#platformEntity = this.#polygonEntity = this.#offsetEntity = this.#mouseRayEntity = null;
        this.#snapshotSensorPos = null;
        this.#snapshotPlatformPos = null;
        this.#snapshotGrid = null;
        this.#snapshotCorners = null;
    }

    #setupScene() {
        this.#viewer.entities.removeAll();
        this.#viewer.scene.primitives.removeAll();
    }

    #initOffscreenFromVideo() {
        this.#canvasA = document.createElement("canvas");
        this.#canvasB = document.createElement("canvas");
        this.#canvasA.width = this.#canvasB.width = this.#baseVideo.videoWidth;
        this.#canvasA.height = this.#canvasB.height = this.#baseVideo.videoHeight;
        this.#canvasContextA = this.#canvasA.getContext("2d");
        this.#canvasContextB = this.#canvasB.getContext("2d");
        this.#initPerspective();
    }

    #initPerspective() {
        const N = Footprint.#GRID_N;
        this.#perspectiveA = new Perspective(this.#canvasContextA, this.#baseVideo, N, {
            filter: this.#videoFilter,
            background: this.#videoBackground,
        });
        this.#perspectiveB = new Perspective(this.#canvasContextB, this.#baseVideo, N, {
            filter: this.#videoFilter,
            background: this.#videoBackground,
        });
    }

    #createEntities() {
        // UAV model (optional)
        this.#platformEntity = this.#viewer.entities.add({
            position: new Cesium.CallbackProperty(() =>
                this.#snapshotPlatformPos ? this.#snapshotPlatformPos.clone() : undefined, false),
            orientation: new Cesium.CallbackProperty(() => this.#platformOrientation, false),
            model: {
                show: new Cesium.CallbackProperty(() => this.#showModel, false),
                uri: this.#opts.modelUrl,
                minimumPixelSize: new Cesium.CallbackProperty(() => this.#modelMinimumPixelSize, false),
                color: new Cesium.CallbackProperty(() => Cesium.Color.WHITE.withAlpha(this.#modelOpacity), false),
                colorBlendMode: Cesium.ColorBlendMode.MIX,
                colorBlendAmount: 0.15,
                runAnimations: new Cesium.CallbackProperty(() =>
                    this.#baseVideo && !this.#baseVideo.paused && !this.#baseVideo.ended, false),
            }
        });

        // 4 corner rays only (indices into the 4×4 grid: TL, TR, BR, BL)
        const N = Footprint.#GRID_N;
        const cornerIndices = [
            0,              // TL: row 0, col 0
            N - 1,          // TR: row 0, col N-1
            N * N - 1,      // BR: row N-1, col N-1
            N * (N - 1),    // BL: row N-1, col 0
        ];

        for (let i = 0; i < 4; i++) {
            const gridIdx = cornerIndices[i];
            const rayEntity = this.#viewer.entities.add({
                polyline: {
                    show: new Cesium.CallbackProperty(() => this.#showRays, false),
                    positions: new Cesium.CallbackProperty(() => {
                        if (!this.#snapshotSensorPos || !this.#snapshotGrid) return undefined;
                        const start = this.#snapshotSensorPos.clone();
                        const end = this.#snapshotGrid[gridIdx]?.clone() ?? start.clone();
                        return [start, end];
                    }, false),
                    width: 2,
                    material: new Cesium.PolylineGlowMaterialProperty({
                        color: Cesium.Color.CYAN,
                        glowPower: 0.3
                    })
                }
            });
            this.#rayEntities.push(rayEntity);
        }

        this.#mouseRayEntity = this.#viewer.entities.add({
            polyline: {
                show: new Cesium.CallbackProperty(() => this.#showRays, false),
                positions: new Cesium.CallbackProperty(() => {
                    if (!this.#mouseRayEnd) return undefined;
                    return [this.#snapshotSensorPos.clone(), this.#mouseRayEnd.clone()];
                }, false),
                width: 1,
                material: new Cesium.PolylineGlowMaterialProperty({
                    color: Cesium.Color.TOMATO,
                    glowPower: 2
                })
            }
        });

        // Main warped video polygon — hierarchy uses only the 4 outer corners
        this.#polygonEntity = this.#viewer.entities.add({
            polygon: {
                show: new Cesium.CallbackProperty(() => this.#showVideoOverlay, false),
                hierarchy: new Cesium.CallbackProperty(() => {
                    if (!this.#snapshotCorners) return undefined;
                    return new Cesium.PolygonHierarchy(
                        this.#snapshotCorners.map(c => c.clone())
                    );
                }, false),
                material: new Cesium.ImageMaterialProperty({
                    image: new Cesium.CallbackProperty(() => {
                        return this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
                    }, false),
                    transparent: true,
                    color: new Cesium.CallbackProperty(() =>
                        Cesium.Color.WHITE.withAlpha(this.#videoOverlayOpacity), false)
                }),
                classificationType: Cesium.ClassificationType.TERRAIN,
                clampToGround: true
            }
        });

        // Offset polygon (unchanged)
        this.#offsetEntity = this.#viewer.entities.add({
            polygon: {
                show: new Cesium.CallbackProperty(() => this.#showOffsetPolygon, false),
                hierarchy: new Cesium.CallbackProperty(() => {
                    if (!this.#metadata) return undefined;
                    const frameCenterLat = Number(this.#metadata[`Frame Center Latitude`] ?? 0);
                    const frameCenterLon = Number(this.#metadata[`Frame Center Longitude`] ?? 0);
                    const offsetCorners = [];
                    for (let i = 1; i <= 4; i++) {
                        const offsetLat = Number(this.#metadata[`Offset Corner Latitude Point ${i}`] ?? 0);
                        const offsetLon = Number(this.#metadata[`Offset Corner Longitude Point ${i}`] ?? 0);
                        offsetCorners.push(
                            Cesium.Cartesian3.fromDegrees(
                                frameCenterLon + offsetLon,
                                frameCenterLat + offsetLat,
                                0
                            )
                        );
                    }
                    return offsetCorners.length === 4
                        ? new Cesium.PolygonHierarchy(offsetCorners)
                        : undefined;
                }, false),
                material: new Cesium.ColorMaterialProperty(
                    new Cesium.CallbackProperty(() =>
                        Cesium.Color.fromBytes(
                            this.#offsetPolygonColor[0],
                            this.#offsetPolygonColor[1],
                            this.#offsetPolygonColor[2]
                        ).withAlpha(this.#offsetPolygonOpacity), false)
                ),
            }
        });
    }

    // -----------------------------
    // TRIGGER UPDATES
    // -----------------------------
    #triggerWarpUpdate() {
        if (!this.#metadata) return;

        const sensorPos = this.#computeSensorPosition(this.#metadata);
        const platformOrientation = this.#computePlatformOrientation(this.#metadata, sensorPos);
        const [grid, platformPosition] = this.#computeGridIntersections(
            this.#metadata, sensorPos, platformOrientation
        );

        this.#platformOrientation = platformOrientation;

        const N = Footprint.#GRID_N;
        const expectedCount = N * N;

        if (grid && grid.length === expectedCount) {
            const snappedGrid = grid.map(c => c.clone());
            Object.freeze(snappedGrid);
            this.#snapshotGrid = snappedGrid;

            // Extract the 4 outer corners for the polygon outline
            // TL, TR, BR, BL in order expected by Cesium PolygonHierarchy
            this.#snapshotCorners = Object.freeze([
                snappedGrid[0],               // TL
                snappedGrid[N - 1],           // TR
                snappedGrid[N * N - 1],       // BR
                snappedGrid[N * (N - 1)],     // BL
            ]);

            this.#snapshotSensorPos = sensorPos?.clone() ?? null;
            this.#snapshotPlatformPos = platformPosition?.clone() ?? null;

            this.#updateWarpedView();
        } else {
            this.#snapshotGrid = null;
            this.#snapshotCorners = null;
            this.#updateWarpedView();
        }
    }

    #updateWarpedView() {
        this.#curCanvas = this.#curCanvas === "a" ? "b" : "a";
        const activeCanvas = this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
        this.#warpImageToPolygon(activeCanvas, this.#snapshotGrid);
    }

    // -----------------------------
    // GRID RAY CASTING
    // -----------------------------

    // Replaces #computeCornerIntersections.
    // Shoots N×N rays through a regular grid of pixel positions across the FOV,
    // returns [grid, platformPosition] where grid is N*N Cartesian3 row-major.
    #computeGridIntersections(metadata, sensorPos, platformOrientation) {
        const N = Footprint.#GRID_N;

        const sensorAzimuth   = toRad(toDecimal(metadata["Sensor Relative Azimuth Angle"])   ?? 0);
        const sensorElevation = toRad(toDecimal(metadata["Sensor Relative Elevation Angle"]) ?? 0);
        const sensorRoll      = toRad(toDecimal(metadata["Sensor Relative Roll Angle"])      ?? 0);

        const hFov = toRad((toDecimal(metadata["Sensor Horizontal Field of View"] ?? metadata["Sensor Horizontal FOV"])) ?? 0);
        const vFov = toRad((toDecimal(metadata["Sensor Vertical Field of View"]   ?? metadata["Sensor Vertical FOV"]))   ?? 0);

        const halfHFov = toDecimal(hFov).div(2);
        const halfVFov = toDecimal(vFov).div(2);

        const scene = this.#viewer.scene;
        const cornerHpr = new HeadingPitchRoll(
            toDecimal(sensorAzimuth),
            toDecimal(sensorElevation),
            toDecimal(sensorRoll)
        );
        const rotMat = matrix3fromHeadingPitchRoll(cornerHpr);

        const grid = [];

        for (let row = 0; row < N; row++) {
            for (let col = 0; col < N; col++) {
                // Normalised pixel position: row 0 = top (positive vFov),
                // col 0 = left (negative hFov)
                // t=0 → -half, t=1 → +half
                const s = col / (N - 1);  // 0→1 left→right
                const t = row / (N - 1);  // 0→1 top→bottom
                
                const tanH = Decimal.tan(halfHFov.mul(1 - 2 * s)).toNumber(); // was: 2*s - 1
                const tanV = Decimal.tan(halfVFov.mul(1 - 2 * t)).toNumber(); // flip: top = positive

                const localDir = new Cesium.Cartesian3(1, tanH, tanV);
                const forwardLocal = multiplyMatrix3ByVector(rotMat, localDir, new Cesium.Cartesian3());
                const forwardWorld = this.#rotateVectorByQuaternion(forwardLocal, platformOrientation);

                const ray = new Cesium.Ray(sensorPos, {
                    x: forwardWorld.x.toNumber(),
                    y: forwardWorld.y.toNumber(),
                    z: forwardWorld.z.toNumber()
                });

                let intersection;

                if (this.#intersectionWith === "ellipsoid") {
                    const res = Cesium.IntersectionTests.rayEllipsoid(ray, scene.globe.ellipsoid);
                    if (Cesium.defined(res) && isFinite(res.start) && res.start > 0)
                        intersection = Cesium.Ray.getPoint(ray, res.start);
                } else {
                    intersection = scene.globe.pick(ray, scene);
                    if (!intersection) {
                        const res = Cesium.IntersectionTests.rayEllipsoid(ray, scene.globe.ellipsoid);
                        if (Cesium.defined(res) && isFinite(res.start) && res.start > 0)
                            intersection = Cesium.Ray.getPoint(ray, res.start);
                    }
                }

                if (!intersection) {
                    // One ray missed — bail out entirely
                    return [null, null];
                }

                grid.push(intersection);
            }
        }

        // Platform position (unchanged)
        const rotMatrix = Cesium.Matrix3.fromQuaternion(platformOrientation);
        const localOffset = new Cesium.Cartesian3(
            this.#sensorRelativePosition[0],
            this.#sensorRelativePosition[1],
            this.#sensorRelativePosition[2]
        );
        const worldOffset = Cesium.Matrix3.multiplyByVector(
            rotMatrix, localOffset, new Cesium.Cartesian3()
        );
        const platformPosition = Cesium.Cartesian3.add(sensorPos, worldOffset, new Cesium.Cartesian3());

        return [grid, platformPosition];
    }

    // -----------------------------
    // WARP
    // -----------------------------
    #warpImageToPolygon(activeCanvas, grid) {
        if (!this.#baseVideo || this.#baseVideo.readyState < 1
            || !this.#perspectiveA || !grid) return;

        const N = Footprint.#GRID_N;
        const cartographics = grid.map(c => Cesium.Cartographic.fromCartesian(c));

        const lons = cartographics.map(c => c.longitude);
        const lats = cartographics.map(c => c.latitude);
        const minLon = Math.min(...lons), maxLon = Math.max(...lons);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const wLon = Math.max(maxLon - minLon, 1e-9);
        const hLat = Math.max(maxLat - minLat, 1e-9);

        // Map all N×N grid points into canvas pixel space
        const dstPoints = cartographics.map(c => [
            ((c.longitude - minLon) / wLon) * activeCanvas.width,
            ((maxLat - c.latitude)  / hLat) * activeCanvas.height,
        ]);

        if (this.#curCanvas === "a") {
            this.#canvasContextA.clearRect(0, 0, this.#canvasA.width, this.#canvasA.height);
            this.#perspectiveA.draw(dstPoints);
        } else {
            this.#canvasContextB.clearRect(0, 0, this.#canvasB.width, this.#canvasB.height);
            this.#perspectiveB.draw(dstPoints);
        }
    }

    // -----------------------------
    // UNCHANGED MATH HELPERS
    // -----------------------------
    #computeSensorPosition(metadata) {
        const sensorLat = toDecimal(metadata["Sensor Latitude"]);
        const sensorLon = toDecimal(metadata["Sensor Longitude"]);
        const sensorAlt = toDecimal(metadata["Sensor True Altitude"]) ?? 0;
        const sensorCarto = Cesium.Cartographic.fromDegrees(sensorLon, sensorLat, sensorAlt);
        return Cesium.Ellipsoid.WGS84.cartographicToCartesian(sensorCarto);
    }

    #computePlatformOrientation(metadata, sensorPos) {
        const platformHeading = toDecimal(metadata["Platform Heading Angle"]) ?? 0;
        const platformPitch   = toDecimal(metadata["Platform Pitch Angle"])   ?? 0;
        const platformRoll    = toDecimal(metadata["Platform Roll Angle"])    ?? 0;
        const platformHpr = new HeadingPitchRoll(
            toRad(platformHeading.plus(-90)),
            toRad(platformPitch),
            toRad(platformRoll)
        );
        return Cesium.Transforms.headingPitchRollQuaternion(sensorPos, platformHpr);
    }

    #rotateVectorByQuaternion(vec, quat) {
        const rotationMatrix = matrix3FromQuaternion(quat);
        return multiplyMatrix3ByVector(rotationMatrix, vec, new Cesium.Cartesian3());
    }

    #computeMouseRay() {
        if (!this.#mousePosition || !this.#viewer || !this.#snapshotSensorPos) return;

        const scene    = this.#viewer.scene;
        const metadata = this.#metadata;
        const platformOrientation = this.#platformOrientation;

        const sensorAzimuth   = toRad(toDecimal(metadata["Sensor Relative Azimuth Angle"])   ?? 0);
        const sensorElevation = toRad(toDecimal(metadata["Sensor Relative Elevation Angle"]) ?? 0);
        const sensorRoll      = toRad(toDecimal(metadata["Sensor Relative Roll Angle"])      ?? 0);

        const hFov = toRad((toDecimal(metadata["Sensor Horizontal Field of View"] ?? metadata["Sensor Horizontal FOV"])) ?? 0);
        const vFov = toRad((toDecimal(metadata["Sensor Vertical Field of View"]   ?? metadata["Sensor Vertical FOV"]))   ?? 0);

        const halfHFov = toDecimal(hFov).div(2);
        const halfVFov = toDecimal(vFov).div(2);

        const nx = 1 - this.#mousePosition[0] * 2;
        const ny = 1 - this.#mousePosition[1] * 2;

        const localDir = new Cesium.Cartesian3(
            1,
            Decimal.tan(nx * halfHFov).toNumber(),
            Decimal.tan(ny * halfVFov).toNumber()
        );

        const cornerHpr = new HeadingPitchRoll(
            toDecimal(sensorAzimuth),
            toDecimal(sensorElevation),
            toDecimal(sensorRoll)
        );
        const rotMat = matrix3fromHeadingPitchRoll(cornerHpr);
        const forwardLocal = multiplyMatrix3ByVector(rotMat, localDir, new Cesium.Cartesian3());
        const forwardWorld = this.#rotateVectorByQuaternion(forwardLocal, platformOrientation);

        const ray = new Cesium.Ray(this.#snapshotSensorPos, {
            x: forwardWorld.x,
            y: forwardWorld.y,
            z: forwardWorld.z
        });

        const distance = 20000.0;
        this.#mouseRayEnd = Cesium.Cartesian3.add(
            ray.origin,
            Cesium.Cartesian3.multiplyByScalar(ray.direction, distance, new Cesium.Cartesian3()),
            new Cesium.Cartesian3()
        );
    }
}