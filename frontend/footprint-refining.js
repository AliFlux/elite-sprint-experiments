// Assumes Perspective (html5jp.perspective) is available globally as Perspective
// and Cesium is available globally.

class Footprint {
    #viewer;
    #opts;
    #canvasA;
    #canvasB;
    #canvasContextA;
    #canvasContextB;
    #curCanvas;
    #baseVideo;
    #offscreenCanvasA;
    #offscreenCanvasContextA;
    #perspectiveA;
    #offscreenCanvasB;
    #offscreenCanvasContextB;
    #perspectiveB;
    #modelUrl;
    #metadata;

    #uavEntity = null;
    #polygonEntity = null;
    #offsetEntity = null;

    // new: terrain watcher
    #terrainWatcherInterval = null;
    #lastTerrainHeight = null;
    #lastTerrainCheckTime = 0;
    #lastCorners = null;
    #videoFrameHandle = null;

    constructor(videoElement, modelUrl, opts = {}) {
        if (!(videoElement instanceof HTMLVideoElement)) {
            throw new Error("Footprint expects an HTMLVideoElement as first argument.");
        }
        this.#baseVideo = videoElement;
        this.#modelUrl = modelUrl;
        this.#opts = opts;

        this.#viewer = null;
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
    }

    update(metadata) {
        if (!this.#viewer) return;
        this.#metadata = metadata;

        this.#drawOffsetPolygon(metadata);

        // 🟢 trigger warp refresh immediately when metadata updates
        this.#triggerWarpUpdate();
    }

    remove() {
        if (!this.#viewer) return;
        if (this.#uavEntity) {
            this.#viewer.entities.remove(this.#uavEntity);
            this.#uavEntity = null;
        }
        if (this.#polygonEntity) {
            this.#viewer.entities.remove(this.#polygonEntity);
            this.#polygonEntity = null;
        }
        if (this.#offsetEntity) {
            this.#viewer.entities.remove(this.#offsetEntity);
            this.#offsetEntity = null;
        }

        if (this.#canvasA && this.#canvasA.parentNode) this.#canvasA.parentNode.removeChild(this.#canvasA);
        if (this.#canvasB && this.#canvasB.parentNode) this.#canvasB.parentNode.removeChild(this.#canvasB);

        if (this.#terrainWatcherInterval) {
            clearInterval(this.#terrainWatcherInterval);
            this.#terrainWatcherInterval = null;
        }
        
        if (this.#videoFrameHandle) {
            cancelAnimationFrame(this.#videoFrameHandle);
            this.#videoFrameHandle = null;
        }
    }

    #setupScene() {
        if (!this.#viewer) return;
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

        this.#canvasA.style.position = this.#canvasB.style.position = "absolute";
        document.body.appendChild(this.#canvasA);
        document.body.appendChild(this.#canvasB);

        this.#offscreenCanvasA = document.createElement("canvas");
        this.#offscreenCanvasA.width = this.#baseVideo.videoWidth;
        this.#offscreenCanvasA.height = this.#baseVideo.videoHeight;
        this.#offscreenCanvasContextA = this.#offscreenCanvasA.getContext("2d");
        this.#perspectiveA = new Perspective(this.#canvasContextA, this.#offscreenCanvasA);

        this.#offscreenCanvasB = document.createElement("canvas");
        this.#offscreenCanvasB.width = this.#baseVideo.videoWidth;
        this.#offscreenCanvasB.height = this.#baseVideo.videoHeight;
        this.#offscreenCanvasContextB = this.#offscreenCanvasB.getContext("2d");
        this.#perspectiveB = new Perspective(this.#canvasContextB, this.#offscreenCanvasB);

        // 🟢 start watching for video frame updates
        this.#watchVideoFrames();
    }

    #computeSensorPosition(metadata) {
        const sensorLat = Number(metadata["Sensor Latitude"]);
        const sensorLon = Number(metadata["Sensor Longitude"]);
        const sensorAlt = Number(metadata["Sensor True Altitude"] ?? 0);
        const sensorCarto = Cesium.Cartographic.fromDegrees(sensorLon, sensorLat, sensorAlt);
        return Cesium.Ellipsoid.WGS84.cartographicToCartesian(sensorCarto);
    }

    #computePlatformOrientation(metadata, sensorPos) {
        const toRad = Cesium.Math.toRadians;
        const platformHeading = Number(metadata["Platform Heading Angle"] ?? 0);
        const platformPitch = Number(metadata["Platform Pitch Angle"] ?? 0);
        const platformRoll = Number(metadata["Platform Roll Angle"] ?? 0);
        const platformHpr = new Cesium.HeadingPitchRoll(
            toRad(-90 + platformHeading),
            toRad(platformPitch),
            toRad(platformRoll)
        );
        return Cesium.Transforms.headingPitchRollQuaternion(sensorPos, platformHpr);
    }

    #addUavModel(sensorPos, platformOrientation) {
        return this.#viewer.entities.add({
            name: "Dummy UAV",
            position: sensorPos,
            orientation: platformOrientation,
            model: {
                uri: this.#modelUrl,
                minimumPixelSize: 350,
                maximumScale: 200
            }
        });
    }

    #computeCornerIntersections(metadata, sensorPos, platformOrientation) {
        const toRad = Cesium.Math.toRadians;
        const sensorAzimuth = toRad(metadata["Sensor Relative Azimuth Angle"] ?? 0);
        const sensorElevation = toRad(metadata["Sensor Relative Elevation Angle"] ?? 0);
        const sensorRoll = toRad(metadata["Sensor Relative Roll Angle"] ?? 0);

        const hFov = toRad((metadata["Sensor Horizontal Field of View"] ?? metadata["Sensor Horizontal FOV"]) ?? 0);
        const vFov = toRad((metadata["Sensor Vertical Field of View"] ?? metadata["Sensor Vertical FOV"]) ?? 0);

        const halfHFov = hFov / 2.0;
        const halfVFov = vFov / 2.0;

        const corners = [
            { dAz: -halfHFov, dEl: +halfVFov },
            { dAz: +halfHFov, dEl: +halfVFov },
            { dAz: +halfHFov, dEl: -halfVFov },
            { dAz: -halfHFov, dEl: -halfVFov }
        ];

        const scene = this.#viewer.scene;
        const cornerIntersections = [];

        for (let i = 0; i < corners.length; i++) {
            const corner = corners[i];
            const cornerHpr = new Cesium.HeadingPitchRoll(
                sensorAzimuth + corner.dAz,
                sensorElevation + corner.dEl,
                -sensorRoll
            );

            const rotMat = Cesium.Matrix3.fromHeadingPitchRoll(cornerHpr);
            let forwardLocal = Cesium.Matrix3.multiplyByVector(
                rotMat,
                new Cesium.Cartesian3(1, 0, 0),
                new Cesium.Cartesian3()
            );
            Cesium.Cartesian3.normalize(forwardLocal, forwardLocal);
            const forwardWorld = this.#rotateVectorByQuaternion(forwardLocal, platformOrientation);
            Cesium.Cartesian3.normalize(forwardWorld, forwardWorld);
            const ray = new Cesium.Ray(sensorPos, forwardWorld);
            // TODO compute ray in serverside for more accuracy...

            const intersection = scene.globe.pick(ray, scene);

            if (intersection) {
                // cornerIntersections.push(intersection);
                // if (!this.#opts.skipRays) {
                //     this.#viewer.entities.add({
                //         name: `Sensor Ray ${i}`,
                //         polyline: {
                //             positions: [sensorPos, intersection],
                //             width: 3,
                //             // material: Cesium.Color.BLUE
                //             material: new Cesium.PolylineGlowMaterialProperty({
                //                 color: Cesium.Color.TEAL,
                //                 glowPower: 0.5,
                //             }),
                //         }
                //     });
                // }
            }
        }

        const frameCenterLat = Number(metadata[`Frame Center Latitude`] ?? 0);
        const frameCenterLon = Number(metadata[`Frame Center Longitude`] ?? 0);
        
        for (let i = 1; i <= 4; i++) {
            const offsetLat = Number(metadata[`Offset Corner Latitude Point ${i}`] ?? 0);
            const offsetLon = Number(metadata[`Offset Corner Longitude Point ${i}`] ?? 0);
            cornerIntersections.push(
                Cesium.Cartesian3.fromDegrees(frameCenterLon + offsetLon, frameCenterLat + offsetLat, 0)
            );
        }

        return cornerIntersections;
    }

    #drawWarpedImagePolygon(cornerIntersections) {
        if (cornerIntersections.length !== 4) return;

        const frozenCorners = cornerIntersections.map(c => c.clone());
        this.#lastCorners = frozenCorners;

        const polygonEntity = this.#viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(frozenCorners),
                material: new Cesium.ImageMaterialProperty({
                    image: new Cesium.CallbackProperty(() => {
                        const activeCanvas = this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
                        return activeCanvas;
                    }, false),
                    transparent: true,
                }),
                classificationType: Cesium.ClassificationType.TERRAIN,
                clampToGround: true,
            },
        });

        // 🟢 Start watching terrain changes at polygon center
        this.#startTerrainWatcher(frozenCorners);

        return polygonEntity;
    }

    #updateWarpedView() {
        this.#curCanvas = this.#curCanvas === "a" ? "b" : "a";
        const activeCanvas = this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
        this.#warpImageToPolygon(activeCanvas, this.#lastCorners);
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
            this.#offscreenCanvasContextA.clearRect(0, 0, this.#offscreenCanvasA.width, this.#offscreenCanvasA.height);
            this.#offscreenCanvasContextA.drawImage(this.#baseVideo, 0, 0, this.#offscreenCanvasA.width, this.#offscreenCanvasA.height);
            this.#perspectiveA.p.ctxo.clearRect(0, 0, this.#perspectiveA.p.cvso.width, this.#perspectiveA.p.cvso.height);
            this.#perspectiveA.p.ctxo.drawImage(this.#offscreenCanvasA, 0, 0, this.#perspectiveA.p.cvso.width, this.#perspectiveA.p.cvso.height);
            this.#perspectiveA.draw(dstRaw);
        } else {
            this.#canvasContextB.clearRect(0, 0, this.#canvasB.width, this.#canvasB.height);
            this.#offscreenCanvasContextB.clearRect(0, 0, this.#offscreenCanvasB.width, this.#offscreenCanvasB.height);
            this.#offscreenCanvasContextB.drawImage(this.#baseVideo, 0, 0, this.#offscreenCanvasB.width, this.#offscreenCanvasB.height);
            this.#perspectiveB.p.ctxo.clearRect(0, 0, this.#perspectiveB.p.cvso.width, this.#perspectiveB.p.cvso.height);
            this.#perspectiveB.p.ctxo.drawImage(this.#offscreenCanvasB, 0, 0, this.#perspectiveB.p.cvso.width, this.#perspectiveB.p.cvso.height);
            this.#perspectiveB.draw(dstRaw);
        }
    }

    #drawOffsetPolygon(metadata) {
        return;

        const frameCenterLat = Number(metadata[`Frame Center Latitude`] ?? 0);
        const frameCenterLon = Number(metadata[`Frame Center Longitude`] ?? 0);
        const offsetCorners = [];
        for (let i = 1; i <= 4; i++) {
            const offsetLat = Number(metadata[`Offset Corner Latitude Point ${i}`] ?? 0);
            const offsetLon = Number(metadata[`Offset Corner Longitude Point ${i}`] ?? 0);
            offsetCorners.push(
                Cesium.Cartesian3.fromDegrees(frameCenterLon + offsetLon, frameCenterLat + offsetLat, 0)
            );
        }

        if (offsetCorners.length === 4) {
            if (this.#offsetEntity) {
                this.#viewer.entities.remove(this.#offsetEntity);
                this.#offsetEntity = null;
            }
            this.#offsetEntity = this.#viewer.entities.add({
                name: "Offset Polygon",
                polygon: {
                    hierarchy: offsetCorners,
                    material: Cesium.Color.TOMATO.withAlpha(0.25),
                }
            });
        }
    }

    #rotateVectorByQuaternion(vec, quat) {
        const rotationMatrix = Cesium.Matrix3.fromQuaternion(quat);
        return Cesium.Matrix3.multiplyByVector(rotationMatrix, vec, new Cesium.Cartesian3());
    }

    // -------------------------------
    // New logic: terrain watcher + trigger
    // -------------------------------

    #startTerrainWatcher(cornerIntersections) {
        return;
        if (!this.#viewer) return;

        const center = Cesium.BoundingSphere.fromPoints(cornerIntersections).center;
        const centerCarto = Cesium.Cartographic.fromCartesian(center);
        const globe = this.#viewer.scene.globe;

        if (this.#terrainWatcherInterval) {
            clearInterval(this.#terrainWatcherInterval);
        }

        this.#lastTerrainHeight = globe.getHeight(centerCarto) ?? 0;

        this.#terrainWatcherInterval = setInterval(() => {
            const now = Date.now();
            if (now - this.#lastTerrainCheckTime < 1000) return;
            this.#lastTerrainCheckTime = now;

            const currentHeight = globe.getHeight(centerCarto);
            if (currentHeight == null) return;

            const delta = Math.abs(currentHeight - this.#lastTerrainHeight);
            if (delta > 0.25) { // 25 cm threshold
                this.#lastTerrainHeight = currentHeight;
                this.#triggerWarpUpdate();
            }
        }, 1000);
    }

    #triggerWarpUpdate() {
        if(!this.#metadata) {
            return;
        }

        const sensorPos = this.#computeSensorPosition(this.#metadata);
        const platformOrientation = this.#computePlatformOrientation(this.#metadata, sensorPos);

        if (!this.#opts.skipUav) {
            if (!this.#uavEntity) {
                this.#uavEntity = this.#addUavModel(sensorPos, platformOrientation);
            } else {
                this.#uavEntity.position = sensorPos;
                this.#uavEntity.orientation = platformOrientation;
            }
        }

        const cornerIntersections = this.#computeCornerIntersections(this.#metadata, sensorPos, platformOrientation);

        if (cornerIntersections.length === 4) {
            if (this.#polygonEntity) {
                this.#viewer.entities.remove(this.#polygonEntity);
                this.#polygonEntity = null;
            }
            this.#polygonEntity = this.#drawWarpedImagePolygon(cornerIntersections);
        }

        this.#updateWarpedView();
    }

    // 🟢 watch video frame updates
    #watchVideoFrames() {
        return;
        if (!this.#baseVideo) return;
        const loop = () => {
            this.#videoFrameHandle = requestAnimationFrame(loop);
            if (!this.#lastCorners) return;
            this.#updateWarpedView();
        };

        if ("requestVideoFrameCallback" in this.#baseVideo) {
            const handleFrame = () => {
                if (this.#lastCorners) {
                    this.#updateWarpedView();
                }
                this.#baseVideo.requestVideoFrameCallback(handleFrame);
            };
            this.#baseVideo.requestVideoFrameCallback(handleFrame);
        } else {
            this.#videoFrameHandle = requestAnimationFrame(loop);
        }
    }

}
