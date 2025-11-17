function decodeMISBValue(tag, data) {
  const ranges = {
    2: null,                      // Timestamp (special handling)
    5: [0, 360],                  // PlatformHeadingAngle
    6: [-20, 20],                 // PlatformPitchAngle
    7: [-50, 50],                 // PlatformRollAngle
    13: [-90, 90],                // SensorLatitude
    14: [-180, 180],              // SensorLongitude
    15: [-900, 19000],            // SensorTrueAltitude
    16: [0, 180],                 // SensorHorizontalFieldOfView
    17: [0, 180],                 // SensorVerticalFieldOfView
    18: [0, 360],                 // SensorRelativeAzimuthAngle
    19: [-180, 180],              // SensorRelativeElevationAngle
    20: [0, 360],                 // SensorRelativeRollAngle,
  };

  const domains = {
    2: null,  // Timestamp
    5: [0, Math.pow(2, 16) - 1],           // 2 bytes unsigned
    6: [-Math.pow(2, 15), Math.pow(2, 15) - 1],  // 2 bytes signed
    7: [-Math.pow(2, 15), Math.pow(2, 15) - 1],  // 2 bytes signed
    13: [-Math.pow(2, 31), Math.pow(2, 31) - 1], // 4 bytes signed
    14: [-Math.pow(2, 31), Math.pow(2, 31) - 1], // 4 bytes signed
    15: [0, Math.pow(2, 16) - 1],          // 2 bytes unsigned
    16: [0, Math.pow(2, 16) - 1],          // 2 bytes unsigned
    17: [0, Math.pow(2, 16) - 1],          // 2 bytes unsigned
    18: [0, Math.pow(2, 32) - 1],          // 4 bytes unsigned
    19: [-Math.pow(2, 31), Math.pow(2, 31) - 1], // 4 bytes signed
    20: [0, Math.pow(2, 32) - 1],          // 4 bytes unsigned
  };

  // --- Timestamp (tag 2) ---
  if (tag === 2) {
    if (data.length !== 8) return null;
    let microseconds = 0;
    for (let i = 0; i < 8; i++) {
      microseconds = microseconds * 256 + data[i];
    }
    const date = new Date(microseconds / 1000);
    return date.toISOString();
  }

  const range = ranges[tag];
  const domain = domains[tag];
  if (!range || !domain) return null;

  const [domainMin, domainMax] = domain;
  const [rangeMin, rangeMax] = range;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // --- Decode integer value ---
  let encodedValue;
  if (domainMin < 0) {
    // Signed
    if (data.length === 2) encodedValue = view.getInt16(0);
    else if (data.length === 4) encodedValue = view.getInt32(0);
    else encodedValue = 0; // unsupported signed length
  } else {
    // Unsigned
    if (data.length === 1) encodedValue = view.getUint8(0);
    else if (data.length === 2) encodedValue = view.getUint16(0);
    else if (data.length === 4) encodedValue = view.getUint32(0);
    else encodedValue = 0; // unsupported unsigned length
  }

  // --- Normalize into the target range ---
  const normalized = (encodedValue - domainMin) / (domainMax - domainMin);
  const value = rangeMin + normalized * (rangeMax - rangeMin);

  return value;
}


function parseKLVPacket(packet) {
  const frame = {};

  if (!packet || !packet.key || !packet.value) {
    return frame;
  }

  // UAS Local Metadata Set universal key (16 bytes)
  const UAS_KEY = new Uint8Array([
    0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
    0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
  ]);

  // Helper: compare two Uint8Arrays for equality
  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Check if this is a UAS Local Set packet
  if (!arraysEqual(packet.key, UAS_KEY)) {
    console.warn('Not a UAS Local Set packet');
    return frame;
  }

  const valueBuffer = packet.value;
  let offset = 0;

  // Decode BER length
  function decodeBERLength(bytes, start) {
    let length = bytes[start];
    let bytesRead = 1;
    if (length > 127) {
      const lenBytes = length & 127;
      length = 0;
      for (let i = 0; i < lenBytes; i++) {
        length = (length << 8) + bytes[start + 1 + i];
      }
      bytesRead += lenBytes;
    }
    return { length, bytesRead };
  }

  // --- MISB ST 0601 Tag Mappings ---
  const tagMapping = {
    2: 'timestamp',           // PrecisionTimeStamp
    5: 'drone_yaw',           // PlatformHeadingAngle
    6: 'drone_pitch',         // PlatformPitchAngle
    7: 'drone_roll',          // PlatformRollAngle
    13: 'latitude',           // SensorLatitude
    14: 'longitude',          // SensorLongitude
    15: 'altitude',           // SensorTrueAltitude
    16: 'fov_horizontal',     // SensorHorizontalFieldOfView
    17: 'fov_vertical',       // SensorVerticalFieldOfView
    18: 'gimbal_yaw',         // SensorRelativeAzimuthAngle
    19: 'gimbal_pitch',       // SensorRelativeElevationAngle
    20: 'gimbal_roll',        // SensorRelativeRollAngle
  };

  // --- Decode each element ---
  while (offset < valueBuffer.length) {
    // Tag (1 byte)
    const tag = valueBuffer[offset++];
    if (offset >= valueBuffer.length) break;

    // Length (BER)
    const { length: elementLength, bytesRead } = decodeBERLength(valueBuffer, offset);
    offset += bytesRead;

    if (offset + elementLength > valueBuffer.length) break;

    // Value bytes
    const elementData = valueBuffer.slice(offset, offset + elementLength);
    offset += elementLength;

    // Decode the value if recognized
    // const fieldName = tagMapping[tag];
    // if (fieldName) {
      const value = decodeMISBValue(tag, elementData);
      if (value !== null && value !== undefined) {
        frame[tag] = value;
      }
    // }
  }

  return frame;
}


async function parseKLV(arrayBuffer) {
  const values = [];
  const view = new DataView(arrayBuffer);
  let offset = 0;

  // Decode Basic Encoding Rules (BER) length
  function decodeBER(view, start) {
    let length = view.getUint8(start);
    let bytesRead = 1;
    if (length > 127) {
      const lenBytes = length & 127;
      length = 0;
      for (let i = 0; i < lenBytes; i++) {
        length = (length << 8) + view.getUint8(start + 1 + i);
      }
      bytesRead += lenBytes;
    }
    return { value: length, bytesRead };
  }

  const keyLength = 16; // Default key length is 16 bytes
  while (offset < arrayBuffer.byteLength) {
    // Read key
    if (offset + keyLength > arrayBuffer.byteLength) break;
    const key = new Uint8Array(arrayBuffer, offset, keyLength);
    offset += keyLength;

    // Read length
    if (offset >= arrayBuffer.byteLength) break;
    const { value: valueLength, bytesRead } = decodeBER(view, offset);
    offset += bytesRead;

    // Read value
    if (offset + valueLength > arrayBuffer.byteLength) break;
    const value = new Uint8Array(arrayBuffer, offset, valueLength);
    offset += valueLength;

    // Push parsed KLV
    values.push({ key, length: valueLength, value });
  }

  return values;
}

