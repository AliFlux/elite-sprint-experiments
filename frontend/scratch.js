


async function createFootprintFromMISB(metadata, viewer, convention, opts = {}) {
    const ellipsoid = Cesium.Ellipsoid.WGS84;

    // --- Extract metadata ---
    const sensorLat   = Number(metadata["Sensor Latitude"]);
    const sensorLon   = Number(metadata["Sensor Longitude"]);
    const sensorAlt   = Number(metadata["Sensor True Altitude"] ?? 0);

    const platformHeadingDeg = Number(metadata["Platform Heading Angle"] ?? 0);
    const platformPitchDeg   = Number(metadata["Platform Pitch Angle"] ?? 0);
    const platformRollDeg    = Number(metadata["Platform Roll Angle"] ?? 0);

    const sensorAzDegRaw     = Number(metadata["Sensor Relative Azimuth Angle"] ?? 0);
    const sensorElDegRaw     = Number(metadata["Sensor Relative Elevation Angle"] ?? 0);
    const sensorRollDeg      = Number(metadata["Sensor Relative Roll Angle"] ?? 0);

    const frameCenterLat = Number(metadata["Frame Center Latitude"]);
    const frameCenterLon = Number(metadata["Frame Center Longitude"]);
    const frameCenterAlt = Number(metadata["Frame Center Elevation"] ?? 0);

    // --- Cartesian positions ---
    const sensorCarto = Cesium.Cartographic.fromDegrees(sensorLon, sensorLat, sensorAlt);
    const sensorPosition = Cesium.Ellipsoid.WGS84.cartographicToCartesian(sensorCarto);

    const frameCarto = Cesium.Cartographic.fromDegrees(frameCenterLon, frameCenterLat, frameCenterAlt);
    const frameCenterCartesian = Cesium.Ellipsoid.WGS84.cartographicToCartesian(frameCarto);

    // --- Entities: Frame Center + Sensor ---
    viewer.entities.add({
        name: "Frame Center",
        position: frameCenterCartesian,
        point: { pixelSize: 10, color: Cesium.Color.RED, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
        label: { text: "Frame Center", font: "14px sans-serif", style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -15) }
    });

    viewer.entities.add({
        name: "Sensor",
        position: sensorPosition,
        point: { pixelSize: 12, color: Cesium.Color.BLUE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
        label: { text: "Sensor", font: "14px sans-serif", style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -15) }
    });

    // --- Apply convention ---
    const conv = convention;
    const headingDeg = conv.headingAdd90 ? -(platformHeadingDeg - 90) : (conv.headingNegate ? -platformHeadingDeg : platformHeadingDeg);
    const pitchDeg   = conv.platformPitchNeg ? -platformPitchDeg : platformPitchDeg;
    const rollDeg    = conv.platformRollNeg ? -platformRollDeg : platformRollDeg;

    const platformHPR = new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(headingDeg),
        Cesium.Math.toRadians(-pitchDeg), // keep same flip as before
        Cesium.Math.toRadians(rollDeg)
    );
    const platformQuat = Cesium.Transforms.headingPitchRollQuaternion(sensorPosition, platformHPR);

    const azDeg  = conv.azNeg ? -sensorAzDegRaw : sensorAzDegRaw;
    const elDeg  = conv.elNeg ? -sensorElDegRaw : sensorElDegRaw;
    const sRoll  = conv.sensorRollNeg ? -sensorRollDeg : sensorRollDeg;

    const sensorHPR = new Cesium.HeadingPitchRoll(
        -Cesium.Math.toRadians(azDeg),     // same flip as before
        Cesium.Math.toRadians(elDeg),
        Cesium.Math.toRadians(sRoll)
    );
    const sensorQuatRel = Cesium.Quaternion.fromHeadingPitchRoll(sensorHPR);

    // --- Combine platform + sensor ---
    const sensorQuat = Cesium.Quaternion.multiply(platformQuat, sensorQuatRel, new Cesium.Quaternion());

    // --- Forward/look vector ---
    const sensorMatrix = Cesium.Matrix3.fromQuaternion(sensorQuat);
    const forward = Cesium.Matrix3.multiplyByVector(sensorMatrix, conv.forwardAxisVec, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(forward, forward);

    console.log("Final forward vector using convention:", forward);

    // --- Geometric ray (sensor -> frame center) ---
    const framePos = Cesium.Ellipsoid.WGS84.cartographicToCartesian(frameCarto);
    const geoRay = Cesium.Cartesian3.subtract(framePos, sensorPosition, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(geoRay, geoRay);

    // --- Visualize rays ---
    const range = 20000.0;
    const attEnd = Cesium.Cartesian3.add(sensorPosition, Cesium.Cartesian3.multiplyByScalar(forward, range, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    viewer.entities.add({ name: "Attitude Ray", polyline: { positions: [sensorPosition, attEnd], width: 3, material: Cesium.Color.YELLOW } });

    const geoEnd = Cesium.Cartesian3.add(sensorPosition, Cesium.Cartesian3.multiplyByScalar(geoRay, range, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    viewer.entities.add({ name: "Geometric Ray", polyline: { positions: [sensorPosition, geoEnd], width: 3, material: Cesium.Color.LIME } });
}


function vectorToHeadingPitch(vec, position) {
    // ENU frame at sensor position
    const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    const inv = Cesium.Matrix4.inverseTransformation(enuTransform, new Cesium.Matrix4());
    const localVec = Cesium.Matrix4.multiplyByPointAsVector(inv, vec, new Cesium.Cartesian3());

    Cesium.Cartesian3.normalize(localVec, localVec);

    // Heading: atan2(East, North)
    const heading = Math.atan2(localVec.x, localVec.y); 

    // Pitch: atan2(Up, horizontal norm)
    const horizNorm = Math.sqrt(localVec.x * localVec.x + localVec.y * localVec.y);
    const pitch = Math.atan2(localVec.z, horizNorm);

    return {
        headingDeg: Cesium.Math.toDegrees(heading),
        pitchDeg: Cesium.Math.toDegrees(pitch)
    };
}

function findBestConventionWithRollVariations(metadata) {
    const ellipsoid = Cesium.Ellipsoid.WGS84;

    const sensorLat = Number(metadata["Sensor Latitude"]);
    const sensorLon = Number(metadata["Sensor Longitude"]);
    const sensorAlt = Number(metadata["Sensor True Altitude"] ?? 0);
    const frameCenterLat = Number(metadata["Frame Center Latitude"]);
    const frameCenterLon = Number(metadata["Frame Center Longitude"]);
    const frameCenterAlt = Number(metadata["Frame Center Elevation"] ?? 0);

    const platformHeadingDeg = Number(metadata["Platform Heading Angle"] ?? 0);
    const platformPitchDeg = Number(metadata["Platform Pitch Angle"] ?? 0);
    const platformRollDeg = Number(metadata["Platform Roll Angle"] ?? 0);

    const sensorAzDegRaw = Number(metadata["Sensor Relative Azimuth Angle"] ?? 0);
    const sensorElDegRaw = Number(metadata["Sensor Relative Elevation Angle"] ?? 0);
    const sensorRollDeg = Number(metadata["Sensor Relative Roll Angle"] ?? 0);

    const sensorCarto = Cesium.Cartographic.fromDegrees(sensorLon, sensorLat, sensorAlt);
    const sensorPos = Cesium.Ellipsoid.WGS84.cartographicToCartesian(sensorCarto);

    const frameCarto = Cesium.Cartographic.fromDegrees(frameCenterLon, frameCenterLat, frameCenterAlt);
    const framePos = Cesium.Ellipsoid.WGS84.cartographicToCartesian(frameCarto);

    const geoRay = Cesium.Cartesian3.subtract(framePos, sensorPos, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(geoRay, geoRay);

    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    const forwardAxes = [
        { name: 'UNIT_X', vec: Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X) },
        { name: 'UNIT_Y', vec: Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Y) },
        { name: '-UNIT_X', vec: Cesium.Cartesian3.negate(Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X), new Cesium.Cartesian3()) },
        { name: '-UNIT_Y', vec: Cesium.Cartesian3.negate(Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Y), new Cesium.Cartesian3()) }
    ];

    const bools = [false, true];
    const combos = [];

    for (const headingNegate of bools) {
        for (const headingAdd90 of bools) {
            for (const platformPitchNeg of bools) {
                for (const platformRollNeg of bools) {       // new
                    for (const azNeg of bools) {
                        for (const elNeg of bools) {
                            for (const sensorRollNeg of bools) { // new
                                for (const forwardAxis of forwardAxes) {
                                    combos.push({
                                        headingNegate,
                                        headingAdd90,
                                        platformPitchNeg,
                                        platformRollNeg,
                                        azNeg,
                                        elNeg,
                                        sensorRollNeg,
                                        forwardAxisName: forwardAxis.name,
                                        forwardAxisVec: forwardAxis.vec
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    const results = [];

    for (const c of combos) {
        let headingDeg = platformHeadingDeg;
        if (c.headingAdd90) headingDeg -= 90;
        if (c.headingNegate) headingDeg = -headingDeg;

        const pitchDeg = c.platformPitchNeg ? -platformPitchDeg : platformPitchDeg;
        const rollDeg = c.platformRollNeg ? -platformRollDeg : platformRollDeg; // apply variation

        const platformHPR = new Cesium.HeadingPitchRoll(toRad(headingDeg), toRad(pitchDeg), toRad(rollDeg));
        const platformQuat = Cesium.Transforms.headingPitchRollQuaternion(sensorPos, platformHPR);

        const azDeg = c.azNeg ? -sensorAzDegRaw : sensorAzDegRaw;
        const elDeg = c.elNeg ? -sensorElDegRaw : sensorElDegRaw;
        const sRollDeg = c.sensorRollNeg ? -sensorRollDeg : sensorRollDeg; // apply variation

        const sensorHPR = new Cesium.HeadingPitchRoll(toRad(azDeg), toRad(elDeg), toRad(sRollDeg));
        const sensorQuatRel = Cesium.Quaternion.fromHeadingPitchRoll(sensorHPR);

        const sensorQuat = Cesium.Quaternion.multiply(platformQuat, sensorQuatRel, new Cesium.Quaternion());

        const sensorMatrix = Cesium.Matrix3.fromQuaternion(sensorQuat);
        const forwardVec = Cesium.Matrix3.multiplyByVector(sensorMatrix, c.forwardAxisVec, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(forwardVec, forwardVec);

        const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(sensorPos);
        const invEnu = Cesium.Matrix4.inverseTransformation(enuTransform, new Cesium.Matrix4());

        const geoLocal = Cesium.Matrix4.multiplyByPointAsVector(invEnu, geoRay, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(geoLocal, geoLocal);
        const attLocal = Cesium.Matrix4.multiplyByPointAsVector(invEnu, forwardVec, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(attLocal, attLocal);

        const geoHPR = vectorToHeadingPitch(geoLocal, sensorPos);
        const attHPR = vectorToHeadingPitch(attLocal, sensorPos);

        const geoRight = Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, geoLocal, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(geoRight, geoRight);
        const attRight = Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, attLocal, new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(attRight, attRight);
        const rollDot = Cesium.Cartesian3.dot(geoRight, attRight);
        const rollDiff = Math.acos(Cesium.Math.clamp(rollDot, -1.0, 1.0));

        const totalError = Math.abs(attHPR.headingDeg - geoHPR.headingDeg)
                         + Math.abs(attHPR.pitchDeg - geoHPR.pitchDeg)
                         + toDeg(rollDiff);

        results.push({
            combo: c,
            headingDiff: attHPR.headingDeg - geoHPR.headingDeg,
            pitchDiff: attHPR.pitchDeg - geoHPR.pitchDeg,
            rollDiff: toDeg(rollDiff),
            totalError
        });
    }

    results.sort((a,b) => a.totalError - b.totalError);

    console.log("Top 8 best-fit conventions (with roll variations):");
    for (let i=0; i<Math.min(8, results.length); i++) {
        const r = results[i];
        console.log(`#${i+1}: heading=${r.headingDiff.toFixed(2)}°, pitch=${r.pitchDiff.toFixed(2)}°, roll=${r.rollDiff.toFixed(2)}°`, r.combo);
    }

    return results;
}






