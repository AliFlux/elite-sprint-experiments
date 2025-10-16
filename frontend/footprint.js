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
    #rayEntities = [];

    // runtime state
    #platformOrientation = null;

    // immutable snapshots used by CallbackProperties (set only in #triggerWarpUpdate)
    #snapshotSensorPos = null;      // Cesium.Cartesian3
    #snapshotPlatformPos = null;      // Cesium.Cartesian3
    #snapshotCorners = null;        // Array<Cesium.Cartesian3>

    
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

    constructor(options = {}) {
        const {
            videoElement,
            modelUrl = null,
            showModel = true,
            showRays = true,
            showOffsetPolygon = true,
            showVideoOverlay = true,
            videoOverlayOpacity = 1,
            modelMinimumPixelSize = 250,
            modelOpacity = 1,
            offsetPolygonOpacity = 0.2,
            offsetPolygonColor = [255, 0, 0],
            sensorRelativePosition = [0, 0, 0]
        } = options;

        if (!(videoElement instanceof HTMLVideoElement)) {
            throw new Error("Footprint expects opts.videoElement as an HTMLVideoElement");
        }

        this.#opts = { modelUrl };
        this.#baseVideo = videoElement;
        this.#curCanvas = "a";
        
        // assign reactive properties
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
        this.#platformEntity = this.#polygonEntity = this.#offsetEntity = null;
        // clear snapshots
        this.#snapshotSensorPos = null;
        this.#snapshotPlatformPos = null;
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
        this.#perspectiveA = new Perspective(this.#canvasContextA, this.#baseVideo);
        this.#perspectiveB = new Perspective(this.#canvasContextB, this.#baseVideo);
    }

    
    #createEntities() {
        // UAV model (optional)
        this.#platformEntity = this.#viewer.entities.add({
            position: new Cesium.CallbackProperty(() => this.#snapshotPlatformPos ? this.#snapshotPlatformPos.clone() : undefined, false),
            orientation: new Cesium.CallbackProperty(() => this.#platformOrientation, false),
            model: {
                show: new Cesium.CallbackProperty(() => this.#showModel, false),
                uri: this.#opts.modelUrl,
                minimumPixelSize: new Cesium.CallbackProperty(() => this.#modelMinimumPixelSize, false),
                color: new Cesium.CallbackProperty(() => Cesium.Color.WHITE.withAlpha(this.#modelOpacity), false),
                colorBlendMode: Cesium.ColorBlendMode.MIX,
                colorBlendAmount: 0.15,
                runAnimations: new Cesium.CallbackProperty(() => {
                    return this.#baseVideo && !this.#baseVideo.paused && !this.#baseVideo.ended;
                }, false),
            }
        });

        // Rays (4 lines)
        for (let i = 0; i < 4; i++) {
            ((idx) => {
                const rayEntity = this.#viewer.entities.add({
                    polyline: {
                        show: new Cesium.CallbackProperty(() => this.#showRays, false),
                        positions: new Cesium.CallbackProperty(() => {
                            if (!this.#snapshotSensorPos || !this.#snapshotCorners) return undefined;
                            const start = this.#snapshotSensorPos.clone();
                            const end = (this.#snapshotCorners[idx] && this.#snapshotCorners[idx].clone()) || start.clone();
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
            })(i);
        }

        const self = this;

        // Main warped video polygon
        this.#polygonEntity = this.#viewer.entities.add({
            polygon: {
                show: new Cesium.CallbackProperty(() => this.#showVideoOverlay, false),
                hierarchy: new Cesium.CallbackProperty(() => {
                    if (!this.#snapshotCorners) return undefined;
                    const cloned = this.#snapshotCorners.map(c => c.clone());
                    return new Cesium.PolygonHierarchy(cloned);
                }, false),
                material: new Cesium.ImageMaterialProperty({
                    image: new Cesium.CallbackProperty(() => {
                        const activeCanvas = self.#curCanvas === "a" ? self.#canvasA : self.#canvasB;
                        return activeCanvas;
                    }, false),
                    transparent: true,
                    color: new Cesium.CallbackProperty(() => Cesium.Color.WHITE.withAlpha(this.#videoOverlayOpacity), false)
                }),
                classificationType: Cesium.ClassificationType.TERRAIN,
                clampToGround: true
            }
        });

        // Offset polygon
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
                            Cesium.Cartesian3.fromDegrees(frameCenterLon + offsetLon, frameCenterLat + offsetLat, 0)
                        );
                    }
                    return offsetCorners.length === 4 ? new Cesium.PolygonHierarchy(offsetCorners) : undefined;
                }, false),
                material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
                        return Cesium.Color.fromBytes(
                            this.#offsetPolygonColor[0],
                            this.#offsetPolygonColor[1],
                            this.#offsetPolygonColor[2]
                        ).withAlpha(this.#offsetPolygonOpacity);
                    }, false),
                ),
            }
        });

        return;
    }

    // -----------------------------
    // TRIGGER UPDATES
    // -----------------------------
    #triggerWarpUpdate() {
        if (!this.#metadata) return;

        // preserve your math exactly
        const sensorPos = this.#computeSensorPosition(this.#metadata);
        const platformOrientation = this.#computePlatformOrientation(this.#metadata, sensorPos);
        const [cornerIntersections, platformPosition] = this.#computeCornerIntersections(this.#metadata, sensorPos, platformOrientation);

        this.#platformOrientation = platformOrientation;

        if (cornerIntersections && cornerIntersections.length === 4) {
            // store the live lastCorners for internal use

            // create immutable snapshots that CallbackProperties will read until next update
            // clone deeply so Cesium won't see mutations; freeze array to be extra-safe
            const snapped = cornerIntersections.map(c => c.clone());
            Object.freeze(snapped);
            this.#snapshotCorners = snapped;

            // snapshot sensor position (clone)
            this.#snapshotSensorPos = sensorPos ? sensorPos.clone() : null;
            this.#snapshotPlatformPos = platformPosition ? platformPosition.clone() : null;

            // update view / warping as before
            this.#updateWarpedView();
        } else {
            this.#snapshotCorners = null;
            this.#updateWarpedView();
        }
    }

    #updateWarpedView() {
        this.#curCanvas = this.#curCanvas === "a" ? "b" : "a";
        const activeCanvas = this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
        this.#warpImageToPolygon(activeCanvas, this.#snapshotCorners);
    }

    // everything below is *untouched math logic*
    #computeSensorPosition(metadata) {
        const sensorLat = toDecimal(metadata["Sensor Latitude"]);
        const sensorLon = toDecimal(metadata["Sensor Longitude"]);
        const sensorAlt = toDecimal(metadata["Sensor True Altitude"]) ?? 0;
        const sensorCarto = Cesium.Cartographic.fromDegrees(sensorLon, sensorLat, sensorAlt);
        return Cesium.Ellipsoid.WGS84.cartographicToCartesian(sensorCarto);
    }

    #computePlatformOrientation(metadata, sensorPos) {
        const platformHeading = toDecimal(metadata["Platform Heading Angle"]) ?? 0;
        const platformPitch = toDecimal(metadata["Platform Pitch Angle"]) ?? 0;
        const platformRoll = toDecimal(metadata["Platform Roll Angle"]) ?? 0;
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

    #computeCornerIntersections(metadata, sensorPos, platformOrientation) {
        const sensorAzimuth = toRad(toDecimal(metadata["Sensor Relative Azimuth Angle"]) ?? 0);
        const sensorElevation = toRad(toDecimal(metadata["Sensor Relative Elevation Angle"]) ?? 0);
        const sensorRoll = toRad(toDecimal(metadata["Sensor Relative Roll Angle"]) ?? 0);

        const hFov = toRad((toDecimal(metadata["Sensor Horizontal Field of View"] ?? metadata["Sensor Horizontal FOV"])) ?? 0);
        const vFov = toRad((toDecimal(metadata["Sensor Vertical Field of View"] ?? metadata["Sensor Vertical FOV"])) ?? 0);

        const halfHFov = toDecimal(hFov).div(2);
        const halfVFov = toDecimal(vFov).div(2);

        const cornersLocal = [
            new Cesium.Cartesian3(1, Decimal.tan(halfHFov).toNumber(),  Decimal.tan(halfVFov).toNumber()),  // top-left
            new Cesium.Cartesian3(1, Decimal.tan(-halfHFov).toNumber(), Decimal.tan(halfVFov).toNumber()),  // top-right
            new Cesium.Cartesian3(1, Decimal.tan(-halfHFov).toNumber(), Decimal.tan(-halfVFov).toNumber()), // bottom-right
            new Cesium.Cartesian3(1, Decimal.tan(halfHFov).toNumber(),  Decimal.tan(-halfVFov).toNumber())  // bottom-left
        ];

        const scene = this.#viewer.scene;
        const cornerIntersections = [];

        for (let i = 0; i < cornersLocal.length; i++) {
            const cornerHpr = new HeadingPitchRoll(
                toDecimal(sensorAzimuth),
                toDecimal(sensorElevation),
                toDecimal(sensorRoll)
            );

            const rotMat = matrix3fromHeadingPitchRoll(cornerHpr);
            let forwardLocal = multiplyMatrix3ByVector(
                rotMat,
                cornersLocal[i],
                new Cesium.Cartesian3()
            );
            const forwardWorld = this.#rotateVectorByQuaternion(forwardLocal, platformOrientation);
            const ray = new Cesium.Ray(sensorPos, {
                x: forwardWorld.x.toNumber(),
                y: forwardWorld.y.toNumber(),
                z: forwardWorld.z.toNumber()
            });

            let intersection = scene.globe.pick(ray, scene);
            // intersection = undefined;


            // fallback to ellipsoid intersection if globe.pick fails (e.g. no terrain)
            if(!intersection) {
                const ellipsoid = scene.globe.ellipsoid;
                const intersectionResult = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid);

                if (Cesium.defined(intersectionResult)) {
                    // intersectionResult.start is the scalar distance along the ray
                    const t = intersectionResult.start;
                    if (isFinite(t) && t > 0) {
                        intersection = Cesium.Ray.getPoint(ray, t);
                    }
                }
            }

            if (intersection) {
                cornerIntersections.push(intersection);
            } else {
                cornerIntersections = [];
                break;
                // return [null, null];
            }
        }

        
        const rotMatrix = Cesium.Matrix3.fromQuaternion(platformOrientation);

        // +X -> back
        // -X -> front
        // +Y -> right
        // -Y -> left
        // +Z -> down
        // -Z -> up
        const localForward = new Cesium.Cartesian3(this.#sensorRelativePosition[0], this.#sensorRelativePosition[1], this.#sensorRelativePosition[2]);
        const worldForward = Cesium.Matrix3.multiplyByVector(rotMatrix, localForward, new Cesium.Cartesian3());
        const platformPosition = Cesium.Cartesian3.add(sensorPos, worldForward, new Cesium.Cartesian3());


        return [cornerIntersections, platformPosition];
    }

    #warpImageToPolygon(activeCanvas, cornerIntersections) {
        if (!this.#baseVideo || this.#baseVideo.readyState < 1 || !this.#perspectiveA || !cornerIntersections) return;

        const cartographics = cornerIntersections.map(c => Cesium.Cartographic.fromCartesian(c));
        const lons = cartographics.map(c => c.longitude);
        const lats = cartographics.map(c => c.latitude);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const width = Math.max(maxLon - minLon, 1e-9);
        const height = Math.max(maxLat - minLat, 1e-9);
        const dstRaw = cartographics.map(c => [
            ((c.longitude - minLon) / width) * activeCanvas.width,
            ((maxLat - c.latitude) / height) * activeCanvas.height,
        ]);

        if (this.#curCanvas === "a") {
            this.#canvasContextA.clearRect(0, 0, this.#canvasA.width, this.#canvasA.height);
            this.#perspectiveA.draw(dstRaw);
        } else {
            this.#canvasContextB.clearRect(0, 0, this.#canvasB.width, this.#canvasB.height);
            this.#perspectiveB.draw(dstRaw);
        }
    }
}
