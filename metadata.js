const pairings = {
  "1": "Date",
  "2": "Date",
  "3": "Mission ID",
  "4": "Mission Tail Number",
  "5": "Platform Heading Angle",
  "6": "Platform Pitch Angle",
  "7": "Platform Roll Angle",
  "8": "Platform True Airspeed",
  "9": "Platform Indicated Airspeed",
  "10": "Platform Designation",
  "11": "Image Source Sensor",
  "12": "Image Coordinate System",
  "13": "Sensor Latitude",
  "14": "Sensor Longitude",
  "15": "Sensor True Altitude",
  "16": "Sensor Horizontal FOV",
  "17": "Sensor Vertical FOV",
  "18": "Sensor Relative Azimuth Angle",
  "19": "Sensor Relative Elevation Angle",
  "20": "Sensor Relative Roll Angle",
  "21": "Slant Range",
  "22": "Target Width",
  "23": "Frame Center Latitude",
  "24": "Frame Center Longitude",
  "25": "Frame Center Elevation",
  "26": "Offset Corner Latitude Point 1",
  "27": "Offset Corner Longitude Point 1",
  "28": "Offset Corner Latitude Point 2",
  "29": "Offset Corner Longitude Point 2",
  "30": "Offset Corner Latitude Point 3",
  "31": "Offset Corner Longitude Point 3",
  "32": "Offset Corner Latitude Point 4",
  "33": "Offset Corner Longitude Point 4",
  "34": "Icing Detected",
  "35": "Wind Direction",
  "36": "Wind Speed",
  "37": "Static Pressure",
  "38": "Density Altitude",
  "39": "Outside Air Temperature",
  "40": "Target Location Latitude",
  "41": "Target Location Longitude",
  "42": "Target Location Elevation",
  "43": "Target Track Gate Width",
  "44": "Target Track Gate Height",
  "45": "Target Error Estimate - CE90",
  "46": "Target Error Estimate - LE90",
  "47": "Generic Flag Data 01",
  "48": "Security Local Metadata Set",
  "49": "Differential Pressure",
  "50": "Platform Angle Of Attack",
  "51": "Platform Vertical Speed",
  "52": "Platform Sideslip Angle",
  "53": "Airfield Barometric Pressure",
  "54": "Airfield Elevation",
  "55": "Relative Humidity",
  "56": "Platform Ground Speed",
  "57": "Platform Fuel Remaining",
  "58": "Platform Fuel Remaining",
  "59": "Platform Call Sign",
  "60": "Weapon Load",
  "61": "Weapon Fired",
  "62": "Laser PRF Code",
  "63": "Sensor FOV name",
  "64": "Platform Magnetic Heading",
  "65": "UAS LDS Version number",
  "66": "Target Location Covariance Matrix",
  "67": "Alternate Platform Latitude",
  "68": "Alternate Platform Longitude",
  "69": "Alternate Platform Altitude",
  "70": "Alternate Platform Name",
  "71": "Alternate Platform Heading",
  "72": "Event Start Time UTC",
  "73": "RVT Local Data Set",
  "74": "VMTI Local Data Set",
  "75": "Sensor Ellipsoid Height",
  "76": "Alternate Platform Ellipsoid Height",
  "77": "Operational Mode",
  "78": "Frame Center Height Above Ellipsoid",
  "79": "Sensor North Velocity",
  "80": "Sensor East Velocity",
  "81": "Image Horizon Pixel Pack",
  "82": "Corner Latitude Point 1 Full",
  "83": "Corner Longitude Point 1 Full",
  "84": "Corner Latitude Point 2 Full",
  "85": "Corner Longitude Point 2 Full",
  "86": "Corner Latitude Point 3 Full",
  "87": "Corner Longitude Point 3 Full",
  "88": "Corner Latitude Point 4 Full",
  "89": "Corner Longitude Point 4 Full",
  "90": "Platform Pitch Angle Full",
  "91": "Platform Pitch Roll Full",
  "92": "Platform Angle Of Attack Full",
  "93": "Platform Sideslip Angle Full",
  "94": "MIIS Core Identifier",
  "95": "SAR Motion Imagery Local Set",
  "96": "Target Width Extended",
  "97": "Range Image Local Set",
  "98": "Geo-Registration Local Set",
  "99": "Composite Imaging Local Set",
  "100": "Segment Local Set",
  "101": "Amend Local Set",
  "102": "SDCC-FLP",
  "103": "Density Altidue Extended",
  "104": "Sensor Ellipsoid Height Extended",
  "105": "Alternate Platform Ellipsoid Height Extended",
  "106": "Stream Designator",
  "107": "Operational Base",
  "108": "Broadcast Source",
  "109": "Range To Recovery Location",
  "110": "Time Airborne",
  "111": "Propulsion Unit Speed",
  "112": "Platform Course Angle",
  "113": "Altitude AGL",
  "114": "Radar Altimeter",
  "115": "Control Command",
  "116": "Control Command Verification List",
  "117": "Sensor Azimuth Rate",
  "118": "Sensor Elevation Rate",
  "119": "Sensor Roll Rate",
  "120": "On-board MI Storage Percent Full",
  "121": "Active Wavelength List",
  "122": "Country Codes",
  "123": "Number of NAVSATs in View",
  "124": "Positioning Method Source",
  "125": "Platform Status",
  "126": "Sensor Control Mode",
  "127": "Sensor Frame Rate Pack",
  "128": "Wavelengths List",
  "129": "Target ID",
  "130": "Airbase Locations",
  "131": "Take-off Time",
  "132": "Transmission Frequency",
  "133": "On-board MI Storage Capacity",
  "134": "Zoom Percentage",
  "135": "Communications Method",
  "136": "Leap Seconds",
  "137": "Correction Offset",
  "138": "Payload List",
  "139": "Active Payloads",
  "140": "Weapons Stores",
  "141": "Waypoint List",
  "142": "View Domain"
}

class Metadata {
  constructor() {
    this.frames = [];   // Array of parsed metadata objects
    this.timestamps = []; // Array of numeric timestamps (#ts)
  }

  /**
   * Load the metadata file from a URL.
   * Each line should contain a JSON object with a "#ts" field (seconds).
   * @param {string} url
   * @returns {Promise<void>}
   */
  async load(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load metadata file: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();

    this.frames = [];
    this.timestamps = [];

    const lines = text.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (typeof obj["#ts"] === "number") {
          this.frames.push(obj);
          this.timestamps.push(obj["#ts"]);
        }
      } catch (e) {
        console.warn("Skipping invalid line:", line);
      }
    }

    // Ensure sorted order (just in case)
    const combined = this.timestamps.map((t, i) => [t, this.frames[i]]);
    combined.sort((a, b) => a[0] - b[0]);
    this.timestamps = combined.map(x => x[0]);
    this.frames = combined.map(x => x[1]);
  }

  /**
   * Push a new metadata object in realtime.
   * Assumes obj["#ts"] is strictly greater than the last timestamp.
   * O(1) append operation.
   * @param {object} obj
   */
  push(obj) {
    const ts = obj["#ts"];
    if (typeof ts !== "number") return; // ignore invalid data

    const len = this.timestamps.length;
    if (len > 0 && ts <= this.timestamps[len - 1]) {
      // throw new Error(`Timestamp ${ts} must be strictly increasing`);
      return;
    }

    this.timestamps.push(ts);
    this.frames.push(obj);
  }

  /**
   * Get the closest metadata object to a given timestamp.
   * Uses binary search for O(log n) performance.
   * @param {number} timestamp - Timestamp in seconds
   * @returns {object|null} Closest metadata frame
   */
  get(timestamp) {
    if (this.timestamps.length === 0) return null;

    let lo = 0;
    let hi = this.timestamps.length - 1;

    // Binary search
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.timestamps[mid];
      if (t === timestamp) {
        return this.frames[mid];
      } else if (t < timestamp) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Now hi < lo, so closest is between hi and lo
    const lowerIdx = Math.max(0, hi);
    const upperIdx = Math.min(this.timestamps.length - 1, lo);

    const lowerT = this.timestamps[lowerIdx];
    const upperT = this.timestamps[upperIdx];

    // Return the nearest one
    if (Math.abs(timestamp - lowerT) <= Math.abs(timestamp - upperT)) {
      return this.frames[lowerIdx];
    } else {
      return this.frames[upperIdx];
    }
  }

  getLDS(timestamp) {
    // const frame = this.get(timestamp);
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return null;

    const result = {};
    for (const key in frame) {
      if (pairings[key]) {
        result[pairings[key]] = frame[key];
      }
    }

    return result;
  }
}
