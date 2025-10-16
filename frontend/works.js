async function createFootprintFromMISB(metadata, viewer, opts = {}) {
    const toRad = Cesium.Math.toRadians;

    // -------------------------------
    // Extract metadata
    // -------------------------------
    const sensorLat = Number(metadata["Sensor Latitude"]);
    const sensorLon = Number(metadata["Sensor Longitude"]);
    const sensorAlt = Number(metadata["Sensor True Altitude"] ?? 0);

    const platformHeading = Number(metadata["Platform Heading Angle"] ?? 0);
    const platformPitch = Number(metadata["Platform Pitch Angle"] ?? 0);
    const platformRoll = Number(metadata["Platform Roll Angle"] ?? 0);

    const sensorAzimuth = toRad(metadata["Sensor Relative Azimuth Angle"] ?? 0);
    const sensorElevation = toRad(metadata["Sensor Relative Elevation Angle"] ?? 0);
    const sensorRoll = toRad(metadata["Sensor Relative Roll Angle"] ?? 0);

    const hFov = toRad(metadata["Sensor Horizontal Field of View"] ?? 0);
    const vFov = toRad(metadata["Sensor Vertical Field of View"] ?? 0);

    // -------------------------------
    // Sensor position
    // -------------------------------
    const sensorCarto = Cesium.Cartographic.fromDegrees(sensorLon, sensorLat, sensorAlt);
    const sensorPos = Cesium.Ellipsoid.WGS84.cartographicToCartesian(sensorCarto);

    // -------------------------------
    // UAV orientation
    // -------------------------------
    const platformHpr = new Cesium.HeadingPitchRoll(
        toRad(-90 + platformHeading),
        toRad(platformPitch),
        toRad(platformRoll)
    );

    const platformOrientation = Cesium.Transforms.headingPitchRollQuaternion(sensorPos, platformHpr);

    // -------------------------------
    // Load UAV model
    // -------------------------------
    viewer.entities.add({
        name: "Dummy UAV",
        position: sensorPos,
        orientation: platformOrientation,
        model: {
            uri: "./model.glb",
            minimumPixelSize: 350,
            maximumScale: 200
        }
    });

    // -------------------------------
    // Utility: rotate vector by quaternion
    // -------------------------------
    function rotateVectorByQuaternion(vec, quat) {
        const qVec = new Cesium.Cartesian3(quat.x, quat.y, quat.z);
        const uv = Cesium.Cartesian3.cross(qVec, vec, new Cesium.Cartesian3());
        const uuv = Cesium.Cartesian3.cross(qVec, uv, new Cesium.Cartesian3());
        Cesium.Cartesian3.multiplyByScalar(uv, 2.0 * quat.w, uv);
        Cesium.Cartesian3.multiplyByScalar(uuv, 2.0, uuv);
        return Cesium.Cartesian3.add(
            vec,
            Cesium.Cartesian3.add(uv, uuv, new Cesium.Cartesian3()),
            new Cesium.Cartesian3()
        );
    }

    // -------------------------------
    // Compute corner rays
    // -------------------------------
    const halfHFov = hFov / 2.0;
    const halfVFov = vFov / 2.0;

    const corners = [
        { dAz: -halfHFov, dEl: +halfVFov }, // top-left
        { dAz: +halfHFov, dEl: +halfVFov }, // top-right
        { dAz: +halfHFov, dEl: -halfVFov }, // bottom-right
        { dAz: -halfHFov, dEl: -halfVFov }  // bottom-left
    ];

    const scene = viewer.scene;
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

        const forwardWorld = rotateVectorByQuaternion(forwardLocal, platformOrientation);
        Cesium.Cartesian3.normalize(forwardWorld, forwardWorld);

        const ray = new Cesium.Ray(sensorPos, forwardWorld);
        const intersection = scene.globe.pick(ray, scene);

        if (intersection) {
            cornerIntersections.push(intersection);

            // optional: draw ray
            viewer.entities.add({
                name: `Sensor Ray ${i}`,
                polyline: {
                    positions: [sensorPos, intersection],
                    width: 2,
                    material: Cesium.Color.YELLOW
                }
            });
        }
    }

















    // -------------------------------
    // Create textured polygon (stretched image)
    // -------------------------------
    if (cornerIntersections.length === 4) {
        // const texCoords = [
        //     new Cesium.Cartesian2(0, 1), // top-left
        //     new Cesium.Cartesian2(1, 1), // top-right
        //     new Cesium.Cartesian2(1, 0), // bottom-right
        //     new Cesium.Cartesian2(0, 0)  // bottom-left
        // ];

        const geometry = new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(cornerIntersections),
            perPositionHeight: true
        });

        const geometryInstance = new Cesium.GeometryInstance({
            geometry: geometry,
        });

        const primitive = new Cesium.Primitive({
            geometryInstances: geometryInstance,
            appearance: new Cesium.MaterialAppearance({
                material: Cesium.Material.fromType('Image', {
                    image: './file_first.jpg',
                    transparent: true,
                    imageRotation: Math.PI/2,
                }),
                faceForward: true,
                closed: true
            }),
            asynchronous: false
        });

        viewer.scene.primitives.add(primitive);
    }















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
    viewer.entities.add({
        name: "Offset Polygon",
        polygon: {
            hierarchy: offsetCorners,
            // perPositionHeight: true,
            material: Cesium.Color.YELLOW.withAlpha(0.5),
            outline: true,
            outlineColor: Cesium.Color.YELLOW
        }
    });
}















}
