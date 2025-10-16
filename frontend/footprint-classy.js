class FootprintGenerator {
    #viewer;
    #opts;
    #canvasA;
    #canvasB;
    #curCanvas;
    #baseImage;

    constructor(viewer, opts = {}) {
        this.#viewer = viewer;
        this.#opts = opts;

        this.#setupScene();
        this.#setupCanvases();
        this.#loadBaseImage(opts.imageUri || "./file_first.jpg");
    }

    // Public method: generate footprint with given metadata
    showFootprint(metadata) {
        const sensorPos = this.#computeSensorPosition(metadata);
        const platformOrientation = this.#computePlatformOrientation(metadata, sensorPos);

        if (!this.#opts.skipUav) {
            this.#addUavModel(sensorPos, platformOrientation);
        }

        const cornerIntersections = this.#computeCornerIntersections(metadata, sensorPos, platformOrientation);

        this.#drawWarpedImagePolygon(cornerIntersections);
        this.#drawOffsetPolygon(metadata);
    }

    // -------------------------------
    // Private helpers
    // -------------------------------

    #setupScene() {
        this.#viewer.entities.removeAll();
        this.#viewer.scene.primitives.removeAll();
    }

    #setupCanvases() {
        this.#canvasA = document.createElement("canvas");
        this.#canvasB = document.createElement("canvas");
        this.#canvasA.width = this.#canvasB.width = 1024;
        this.#canvasA.height = this.#canvasB.height = 1024;

        // Keep them offscreen
        this.#canvasA.style.position = this.#canvasB.style.position = "absolute";
        this.#canvasA.style.top = this.#canvasB.style.top = "-9999px";
        document.body.appendChild(this.#canvasA);
        document.body.appendChild(this.#canvasB);

        this.#curCanvas = "a";
    }

    #loadBaseImage(uri) {
        this.#baseImage = new Image();
        this.#baseImage.src = uri;
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
        this.#viewer.entities.add({
            name: "Dummy UAV",
            position: sensorPos,
            orientation: platformOrientation,
            model: {
                uri: "./model.glb",
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

    const hFov = toRad(metadata["Sensor Horizontal Field of View"] ?? 0);
    const vFov = toRad(metadata["Sensor Vertical Field of View"] ?? 0);

    const halfHFov = hFov / 2.0;
    const halfVFov = vFov / 2.0;

    const corners = [
        { dAz: -halfHFov, dEl: +halfVFov }, // top-left
        { dAz: +halfHFov, dEl: +halfVFov }, // top-right
        { dAz: +halfHFov, dEl: -halfVFov }, // bottom-right
        { dAz: -halfHFov, dEl: -halfVFov }  // bottom-left
    ];

    const scene = this.#viewer.scene;
    const cornerIntersections = [];

    for (let i = 0; i < corners.length; i++) {
        const corner = corners[i];

        // 💡 EXACT copy of your original math
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
        const intersection = scene.globe.pick(ray, scene);
        console.log(intersection)

        if (intersection) {
            cornerIntersections.push(intersection);

            if (!this.#opts.skipRays) {
                this.#viewer.entities.add({
                    name: `Sensor Ray ${i}`,
                    polyline: {
                        positions: [sensorPos, intersection],
                        width: 2,
                        material: Cesium.Color.BLUE
                    }
                });
            }
        }
    }

    return cornerIntersections;
}

    #drawWarpedImagePolygon(cornerIntersections) {
        if (cornerIntersections.length !== 4) return;
        
        const frozenCorners = cornerIntersections.map(c => c.clone());

        const polygonEntity = this.#viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(frozenCorners),
                material: new Cesium.ImageMaterialProperty({
                    image: new Cesium.CallbackProperty(() => {
                        const activeCanvas = this.#curCanvas === "a" ? this.#canvasA : this.#canvasB;
                        this.#warpImageToPolygon(activeCanvas, frozenCorners);
                        this.#curCanvas = this.#curCanvas === "a" ? "b" : "a";
                        return activeCanvas;
                    }, false),
                    transparent: true,
                }),
                classificationType: Cesium.ClassificationType.TERRAIN,
                clampToGround: true,
            },
        });

        return polygonEntity;
    }
#warpImageToPolygon(activeCanvas, cornerIntersections) {
    if (!this.#baseImage.complete) return;

    const ctx = activeCanvas.getContext("2d");
    ctx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);

    // Project globe positions into 2D "normalized" space
    const cartographics = cornerIntersections.map(c =>
        Cesium.Cartographic.fromCartesian(c)
    );

    const lons = cartographics.map(c => c.longitude);
    const lats = cartographics.map(c => c.latitude);

    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const width = Math.max(maxLon - minLon, 1e-9);
    const height = Math.max(maxLat - minLat, 1e-9);

    // Preserve same order as intersections array!
    const dstRaw = cartographics.map(c => [
        ((c.longitude - minLon) / width) * activeCanvas.width,
        ((maxLat - c.latitude) / height) * activeCanvas.height,
    ]);

    new Perspective(ctx, this.#baseImage).draw(dstRaw);
}


    #drawOffsetPolygon(metadata) {
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
            this.#viewer.entities.add({
                name: "Offset Polygon",
                polygon: {
                    hierarchy: offsetCorners,
                    material: Cesium.Color.YELLOW.withAlpha(0.5),
                }
            });
        }
    }

    #rotateVectorByQuaternion(vec, quat) {
        const rotationMatrix = Cesium.Matrix3.fromQuaternion(quat);
        return Cesium.Matrix3.multiplyByVector(rotationMatrix, vec, new Cesium.Cartesian3());
    }
}
