

    // --- Sensor Ray (platform HPR + sensor-relative angles) ---
    const platformHPR = new Cesium.HeadingPitchRoll(
        deg2rad(platformHeadingDeg - 90),
        deg2rad(platformPitchDeg),
        deg2rad(platformRollDeg)
    );
    const sensorHPR = new Cesium.HeadingPitchRoll(0, 0, 0);


    // Convert both to quaternions
    const qParent = Cesium.Quaternion.fromHeadingPitchRoll(platformHPR);
    const qChild = Cesium.Quaternion.fromHeadingPitchRoll(sensorHPR);

    // Multiply to combine (parent * child)
    const qFinal = new Cesium.Quaternion();
    Cesium.Quaternion.multiply(qParent, qChild, qFinal);

    // 2. Build a rotation matrix from the quaternion
    const rotMat = Cesium.Matrix3.fromQuaternion(qFinal);

    // 3. Define a local forward vector (X axis for Cesium's HPR)
    const forward = Cesium.Cartesian3.UNIT_X;

    // 4. Rotate forward into world space
    const dir = Cesium.Matrix3.multiplyByVector(rotMat, forward, new Cesium.Cartesian3());

    // 5. Create a Ray from the sensor position
    const ray = new Cesium.Ray(sensorPosition, dir);

    // (Optional) compute a point along the ray, e.g. 1000m out
    const endPoint = Cesium.Ray.getPoint(ray, 5000.0);

    // 6. Draw a polyline to visualize the ray
    viewer.entities.add({
        polyline: {
            positions: [sensorPosition, endPoint],
            width: 2,
            material: Cesium.Color.RED
        }
    });


    // viewer.entities.add({
    //     name: "Sensor Ray",
    //     polyline: { positions: [sensorPosition, sensorEnd], width: 3, material: Cesium.Color.YELLOW }
    // });

    // console.log("Sensor Ray (ECEF):", sensorDir);