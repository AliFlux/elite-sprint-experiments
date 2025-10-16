async function createFootprintFromMISB(metadata, viewer, opts = {}) {
    const deg2rad = Cesium.Math.toRadians;
    const range = opts.range || 20000.0;

    // --- Extract metadata (MISB names) ---
    const sensorLat   = Number(metadata["Sensor Latitude"]);
    const sensorLon   = Number(metadata["Sensor Longitude"]);
    const sensorAlt   = Number(metadata["Sensor True Altitude"] ?? 0);

    const platformHeadingDeg = Number(metadata["Platform Heading Angle"] ?? 0); // yaw
    const platformPitchDeg   = Number(metadata["Platform Pitch Angle"] ?? 0);
    const platformRollDeg    = Number(metadata["Platform Roll Angle"] ?? 0);

    const sensorAzDeg   = Number(metadata["Sensor Relative Azimuth Angle"] ?? 0);   // yaw
    const sensorElDeg   = Number(metadata["Sensor Relative Elevation Angle"] ?? 0); // pitch
    const sensorRollDeg = Number(metadata["Sensor Relative Roll Angle"] ?? 0);

    const frameCenterLat = Number(metadata["Frame Center Latitude"]);
    const frameCenterLon = Number(metadata["Frame Center Longitude"]);
    const frameCenterAlt = Number(metadata["Frame Center Elevation"] ?? 0);

    // --- Cartesian positions (ECEF) ---
    const sensorCarto = Cesium.Cartographic.fromDegrees(sensorLon, sensorLat, sensorAlt);
    const sensorPosition = Cesium.Ellipsoid.WGS84.cartographicToCartesian(sensorCarto);

    const frameCarto = Cesium.Cartographic.fromDegrees(frameCenterLon, frameCenterLat, frameCenterAlt);
    const frameCenterCartesian = Cesium.Ellipsoid.WGS84.cartographicToCartesian(frameCarto);

    // --- Display sensor and frame center ---
    viewer.entities.add({
        name: "Frame Center",
        position: frameCenterCartesian,
        point: { pixelSize: 10, color: Cesium.Color.RED, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 }
    });
    viewer.entities.add({
        name: "Sensor",
        position: sensorPosition,
        point: { pixelSize: 12, color: Cesium.Color.BLUE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 }
    });

    // --- Geometric Ray (sensor → frame center) for reference ---
    {
        const geoRay = Cesium.Cartesian3.subtract(frameCenterCartesian, sensorPosition, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(geoRay, geoRay);
        const geoEnd = Cesium.Cartesian3.add(
            sensorPosition,
            Cesium.Cartesian3.multiplyByScalar(geoRay, range, new Cesium.Cartesian3()),
            new Cesium.Cartesian3()
        );
        viewer.entities.add({
            name: "Geometric Ray",
            polyline: { positions: [sensorPosition, geoEnd], width: 3, material: Cesium.Color.LIME }
        });

        console.log("Geo Ray (ECEF):", geoRay);
    }

    // --- Sensor Ray using Platform + Sensor Angles ---
    {
        // Platform orientation in ENU (East-North-Up) local frame
        const platformHeading = deg2rad(-platformHeadingDeg);
        const platformPitch   = deg2rad(-platformPitchDeg);
        const platformRoll    = deg2rad(platformRollDeg);

        const hprPlatform = new Cesium.HeadingPitchRoll(platformHeading, platformPitch, platformRoll);

        // Local ENU frame at sensor position
        const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(sensorPosition);
        const platformMatrix = Cesium.Matrix3.fromHeadingPitchRoll(hprPlatform);

        // Sensor orientation relative to platform
        const sensorAz   = deg2rad(-sensorAzDeg);
        const sensorEl   = deg2rad(-sensorElDeg);
        const sensorRoll = deg2rad(sensorRollDeg);
        const hprSensor = new Cesium.HeadingPitchRoll(sensorAz, sensorEl, sensorRoll);
        const sensorMatrix = Cesium.Matrix3.fromHeadingPitchRoll(hprSensor);

        // Combine platform + sensor orientation
        const totalMatrix = Cesium.Matrix3.multiply(platformMatrix, sensorMatrix, new Cesium.Matrix3());

        // Forward direction in local ENU is along X-axis
        const localForward = new Cesium.Cartesian3(1, 0, 0);

        // Rotate into ENU
        const enuDir = Cesium.Matrix3.multiplyByVector(totalMatrix, localForward, new Cesium.Cartesian3());

        // Convert ENU → ECEF
        const enuRotation = Cesium.Matrix4.getRotation(enuTransform, new Cesium.Matrix3());
        const ecefDir = Cesium.Matrix3.multiplyByVector(enuRotation, enuDir, new Cesium.Cartesian3());

        Cesium.Cartesian3.normalize(ecefDir, ecefDir);

        const sensorEnd = Cesium.Cartesian3.add(
            sensorPosition,
            Cesium.Cartesian3.multiplyByScalar(ecefDir, range, new Cesium.Cartesian3()),
            new Cesium.Cartesian3()
        );

        viewer.entities.add({
            name: "Sensor Ray",
            polyline: { positions: [sensorPosition, sensorEnd], width: 3, material: Cesium.Color.YELLOW }
        });

        console.log("Sensor Ray (ECEF):", ecefDir);
    }
}
