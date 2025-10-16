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
    #uavEntity = null;
    #polygonEntity = null;
    #offsetEntity = null;
    #rayEntities = [];

    // runtime state
    #sensorPos = null;
    #platformOrientation = null;
    #lastCorners = null;

    // immutable snapshots used by CallbackProperties (set only in #triggerWarpUpdate)
    #snapshotSensorPos = null;      // Cesium.Cartesian3
    #snapshotCorners = null;        // Array<Cesium.Cartesian3>

    constructor(options = {}) {
        const {
            videoElement,
            modelUrl = null,
            showRays = false,
            showOffsetPolygon = false,
            showModel = true
        } = options;

        if (!(videoElement instanceof HTMLVideoElement)) {
            throw new Error("Footprint expects opts.videoElement as an HTMLVideoElement");
        }

        this.#opts = { modelUrl, showRays, showOffsetPolygon, showModel };
        this.#baseVideo = videoElement;
        this.#curCanvas = "a";

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
        const ents = [this.#uavEntity, this.#polygonEntity, this.#offsetEntity];
        ents.forEach(e => e && this.#viewer.entities.remove(e));
        this.#rayEntities.forEach(e => this.#viewer.entities.remove(e));
        this.#rayEntities = [];
        this.#uavEntity = this.#polygonEntity = this.#offsetEntity = null;
        // clear snapshots
        this.#snapshotSensorPos = null;
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
        if (this.#opts.showModel) {
            this.#uavEntity = this.#viewer.entities.add({
                position: new Cesium.CallbackProperty(() => {
                    // return a clone so Cesium doesn't hold your live object
                    return this.#snapshotSensorPos ? this.#snapshotSensorPos.clone() : undefined;
                }, false),
                orientation: new Cesium.CallbackProperty(() => {
                    // orientation is allowed to be the live quaternion; clone if needed.
                    return this.#platformOrientation;
                }, false),
                model: {
                    uri: this.#opts.modelUrl,
                    minimumPixelSize: 350,
                    maximumScale: 200,
                    color: Cesium.Color.WHITE.withAlpha(1.0),
                    colorBlendMode: Cesium.ColorBlendMode.MIX,
                    colorBlendAmount: 0.15
                }
            });
        }

        // Rays (optional) — create 4 separate ray entities; each uses its own index
        if (this.#opts.showRays) {
            for (let i = 0; i < 4; i++) {
                ((idx) => {
                    const rayEntity = this.#viewer.entities.add({
                        polyline: {
                            positions: new Cesium.CallbackProperty(() => {
                                // Read from immutable snapshots only
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
        }

        // Main warped video polygon
        this.#polygonEntity = this.#viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.CallbackProperty(() => {
                    // return a fresh PolygonHierarchy built from the snapshot (cloned)
                    if (!this.#snapshotCorners) return undefined;
                    const cloned = this.#snapshotCorners.map(c => c.clone());
                    return new Cesium.PolygonHierarchy(cloned);
                }, false),
                material: new Cesium.ImageMaterialProperty({
                    image: new Cesium.CallbackProperty(() => {
                        const activeCanvas = this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
                        return activeCanvas;
                    }, false),
                    transparent: true
                }),
                classificationType: Cesium.ClassificationType.TERRAIN,
                clampToGround: true
            }
        });

        // Offset polygon (optional)
        if (this.#opts.showOffsetPolygon) {
            this.#offsetEntity = this.#viewer.entities.add({
                polygon: {
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
                    material: Cesium.Color.TOMATO.withAlpha(0.25)
                }
            });
        }
    }

    // -----------------------------
    // TRIGGER UPDATES
    // -----------------------------
    #triggerWarpUpdate() {
        if (!this.#metadata) return;

        // preserve your math exactly
        const sensorPos = this.#computeSensorPosition(this.#metadata);
        const platformOrientation = this.#computePlatformOrientation(this.#metadata, sensorPos);
        const cornerIntersections = this.#computeCornerIntersections(this.#metadata, sensorPos, platformOrientation);

        this.#sensorPos = sensorPos;
        this.#platformOrientation = platformOrientation;

        if (cornerIntersections && cornerIntersections.length === 4) {
            // store the live lastCorners for internal use
            this.#lastCorners = cornerIntersections.map(c => c.clone());

            // create immutable snapshots that CallbackProperties will read until next update
            // clone deeply so Cesium won't see mutations; freeze array to be extra-safe
            const snapped = cornerIntersections.map(c => c.clone());
            Object.freeze(snapped);
            this.#snapshotCorners = snapped;

            // snapshot sensor position (clone)
            this.#snapshotSensorPos = sensorPos ? sensorPos.clone() : null;

            // update view / warping as before
            this.#updateWarpedView();
        }
    }

    #updateWarpedView() {
        this.#curCanvas = this.#curCanvas === "a" ? "b" : "a";
        const activeCanvas = this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
        this.#warpImageToPolygon(activeCanvas, this.#lastCorners);
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

        const corners = [
            { dAz: halfHFov.neg(), dEl: halfVFov },  // top-left
            { dAz: halfHFov,        dEl: halfVFov },  // top-right
            { dAz: halfHFov,        dEl: halfVFov.neg() }, // bottom-right
            { dAz: halfHFov.neg(),  dEl: halfVFov.neg() }  // bottom-left
        ];

        const scene = this.#viewer.scene;
        const cornerIntersections = [];

        for (let i = 0; i < corners.length; i++) {
            const corner = corners[i];
            const cornerHpr = new HeadingPitchRoll(
                toDecimal(sensorAzimuth).add(corner.dAz),
                toDecimal(sensorElevation).add(corner.dEl),
                toDecimal(sensorRoll).neg()
            );

            const rotMat = matrix3fromHeadingPitchRoll(cornerHpr);
            let forwardLocal = multiplyMatrix3ByVector(
                rotMat,
                new Cesium.Cartesian3(1, 0, 0),
                new Cesium.Cartesian3()
            );
            const forwardWorld = this.#rotateVectorByQuaternion(forwardLocal, platformOrientation);
            const ray = new Cesium.Ray(sensorPos, {
                x: forwardWorld.x.toNumber(),
                y: forwardWorld.y.toNumber(),
                z: forwardWorld.z.toNumber()
            });

            const intersection = scene.globe.pick(ray, scene);

            if (intersection) {
                cornerIntersections.push(intersection);
            }
        }

        return cornerIntersections;
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
