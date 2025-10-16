async function waitForTerrain() {

    await viewer.terrainProvider.readyPromise;

    // Function to check when all terrain tiles are loaded
    await new Promise((resolve) => {
        const handler = (remaining) => {
            if (remaining === 0) {
                viewer.scene.globe.tileLoadProgressEvent.removeEventListener(handler);
                resolve();
            }
        };
        viewer.scene.globe.tileLoadProgressEvent.addEventListener(handler);
    });
}

async function loadVideo(uri) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.src = uri;
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.controls = true;
        // video.playsInline = true;
        // video.crossOrigin = "anonymous";
        video.style.display = "none";
        video.style.display = "block";
        video.style.position = "absolute";
        video.style.top = "0px";
        video.style.right = "0px";
        video.style.width = "300px";
        video.style.height = "200px";
        document.body.appendChild(video);

        // Start playing immediately when metadata is ready
        video.addEventListener("loadedmetadata", () => {
            resolve(video)
        });

        video.addEventListener("error", (e) => {
            reject(e);
        });
    });
}

// Ensure Decimal.js is available
// const Decimal = require('decimal.js');

// Helper: safely convert to Decimal
function toDecimal(value) {
    return Decimal.isDecimal(value) ? value : new Decimal(value.toString() ?? '0');
}

// ---------------------------
// HeadingPitchRoll
// ---------------------------
function HeadingPitchRoll(heading, pitch, roll) {
    this.heading = toDecimal(heading);
    this.pitch = toDecimal(pitch);
    this.roll = toDecimal(roll);
}

// ---------------------------
// Matrix3
// ---------------------------
function Matrix3(
    column0Row0,
    column1Row0,
    column2Row0,
    column0Row1,
    column1Row1,
    column2Row1,
    column0Row2,
    column1Row2,
    column2Row2,
) {
    this[0] = toDecimal(column0Row0);
    this[1] = toDecimal(column0Row1);
    this[2] = toDecimal(column0Row2);
    this[3] = toDecimal(column1Row0);
    this[4] = toDecimal(column1Row1);
    this[5] = toDecimal(column1Row2);
    this[6] = toDecimal(column2Row0);
    this[7] = toDecimal(column2Row1);
    this[8] = toDecimal(column2Row2);
}

// ---------------------------
// Quaternion → Matrix3
// ---------------------------
function matrix3FromQuaternion(quaternion, result) {
    const x = toDecimal(quaternion.x);
    const y = toDecimal(quaternion.y);
    const z = toDecimal(quaternion.z);
    const w = toDecimal(quaternion.w);

    const x2 = x.mul(x);
    const y2 = y.mul(y);
    const z2 = z.mul(z);
    const xy = x.mul(y);
    const xz = x.mul(z);
    const yz = y.mul(z);
    const xw = x.mul(w);
    const yw = y.mul(w);
    const zw = z.mul(w);
    const w2 = w.mul(w);

    const two = new Decimal(2);

    const m00 = x2.sub(y2).sub(z2).add(w2);
    const m01 = two.mul(xy.sub(zw));
    const m02 = two.mul(xz.add(yw));

    const m10 = two.mul(xy.add(zw));
    const m11 = y2.sub(x2).sub(z2).add(w2);
    const m12 = two.mul(yz.sub(xw));

    const m20 = two.mul(xz.sub(yw));
    const m21 = two.mul(yz.add(xw));
    const m22 = w2.sub(x2).sub(y2).add(z2);

    if (!result) {
        return new Matrix3(m00, m01, m02, m10, m11, m12, m20, m21, m22);
    }

    result[0] = m00; result[1] = m10; result[2] = m20;
    result[3] = m01; result[4] = m11; result[5] = m21;
    result[6] = m02; result[7] = m12; result[8] = m22;

    return result;
}

// ---------------------------
// HeadingPitchRoll → Matrix3
// ---------------------------

// Radians per degree as Decimal
const RADIANS_PER_DEGREE = new Decimal(Math.PI).div(180);

function toRad(degrees) {
    return toDecimal(degrees).mul(RADIANS_PER_DEGREE);
}

function matrix3fromHeadingPitchRoll(headingPitchRoll, result) {
    const pitch = headingPitchRoll.pitch.neg();
    const heading = headingPitchRoll.heading.neg();
    const roll = headingPitchRoll.roll;

    const cosTheta = pitch.cos();
    const sinTheta = pitch.sin();
    const cosPsi = heading.cos();
    const sinPsi = heading.sin();
    const cosPhi = roll.cos();
    const sinPhi = roll.sin();

    const m00 = cosTheta.mul(cosPsi);
    const m01 = cosPhi.neg().mul(sinPsi).add(sinPhi.mul(sinTheta).mul(cosPsi));
    const m02 = sinPhi.mul(sinPsi).add(cosPhi.mul(sinTheta).mul(cosPsi));

    const m10 = cosTheta.mul(sinPsi);
    const m11 = cosPhi.mul(cosPsi).add(sinPhi.mul(sinTheta).mul(sinPsi));
    const m12 = sinPhi.neg().mul(cosPsi).add(cosPhi.mul(sinTheta).mul(sinPsi));

    const m20 = sinTheta.neg();
    const m21 = sinPhi.mul(cosTheta);
    const m22 = cosPhi.mul(cosTheta);

    if (!result) {
        return new Matrix3(m00, m01, m02, m10, m11, m12, m20, m21, m22);
    }

    result[0] = m00; result[1] = m10; result[2] = m20;
    result[3] = m01; result[4] = m11; result[5] = m21;
    result[6] = m02; result[7] = m12; result[8] = m22;
    return result;
}

// ---------------------------
// Matrix3 × Vector3
// ---------------------------
function multiplyMatrix3ByVector(matrix, cartesian, result) {
    const vX = toDecimal(cartesian.x);
    const vY = toDecimal(cartesian.y);
    const vZ = toDecimal(cartesian.z);

    const x = toDecimal(matrix[0]).mul(vX)
        .add(toDecimal(matrix[3]).mul(vY))
        .add(toDecimal(matrix[6]).mul(vZ));

    const y = toDecimal(matrix[1]).mul(vX)
        .add(toDecimal(matrix[4]).mul(vY))
        .add(toDecimal(matrix[7]).mul(vZ));

    const z = toDecimal(matrix[2]).mul(vX)
        .add(toDecimal(matrix[5]).mul(vY))
        .add(toDecimal(matrix[8]).mul(vZ));

    result.x = x;
    result.y = y;
    result.z = z;
    return result;
}

// function transformHeadingPitchRollQuaternion (
//   origin,
//   headingPitchRoll,
//   ellipsoid,
//   fixedFrameTransform,
//   result,
// ) {
//   const transform = Transforms.headingPitchRollToFixedFrame(
//     origin,
//     headingPitchRoll,
//     ellipsoid,
//     fixedFrameTransform,
//     scratchENUMatrix4,
//   );
//   const rotation = Matrix4.getMatrix3(transform, scratchHPRMatrix3);
//   return Quaternion.fromRotationMatrix(rotation, result);
// };

// function headingPitchRollToFixedFrame (
//   origin,
//   headingPitchRoll,
//   ellipsoid,
//   fixedFrameTransform,
//   result,
// ) {
//   fixedFrameTransform =
//     fixedFrameTransform ?? Transforms.eastNorthUpToFixedFrame;
//   const hprQuaternion = Quaternion.fromHeadingPitchRoll(
//     headingPitchRoll,
//     scratchHPRQuaternion,
//   );
//   const hprMatrix = Matrix4.fromTranslationQuaternionRotationScale(
//     Cartesian3.ZERO,
//     hprQuaternion,
//     scratchScale,
//     scratchHPRMatrix4,
//   );
//   result = fixedFrameTransform(origin, ellipsoid, result);
//   return Matrix4.multiply(result, hprMatrix, result);
// };
