// ====== WGS-84 helpers ======
const a = 6378137.0;
const f = 1/298.257223563;
const e2 = f * (2 - f);
const b = a * (1 - f);

const deg2rad = d => d * Math.PI/180;
const rad2deg = r => r * 180/Math.PI;

function geodeticToECEF(lat, lon, h){
  const φ = deg2rad(lat), λ = deg2rad(lon);
  const N = a / Math.sqrt(1 - e2 * Math.sin(φ)**2);
  return [
    (N + h) * Math.cos(φ) * Math.cos(λ),
    (N + h) * Math.cos(φ) * Math.sin(λ),
    (N * (1 - e2) + h) * Math.sin(φ)
  ];
}

function ecefToGeodetic(x,y,z){
  const λ = Math.atan2(y,x);
  const p = Math.hypot(x,y);
  let φ = Math.atan2(z, p * (1 - e2));
  let N,h;
  for(let i=0;i<10;i++){
    N = a / Math.sqrt(1 - e2 * Math.sin(φ)**2);
    h = p / Math.cos(φ) - N;
    φ = Math.atan2(z, p * (1 - e2 * N / (N + h)));
  }
  return [rad2deg(φ), rad2deg(λ), h];
}

// rotations and linear algebra (3x3)
function rotX(t){ const c=Math.cos(t), s=Math.sin(t); return [[1,0,0],[0,c,-s],[0,s,c]]; }
function rotY(t){ const c=Math.cos(t), s=Math.sin(t); return [[c,0,s],[0,1,0],[-s,0,c]]; }
function rotZ(t){ const c=Math.cos(t), s=Math.sin(t); return [[c,-s,0],[s,c,0],[0,0,1]]; }

function matmul(A,B){
  const R = [[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<3;i++) for(let j=0;j<3;j++) for(let k=0;k<3;k++) R[i][j]+=A[i][k]*B[k][j];
  return R;
}
function matvec(M,v){
  return [
    M[0][0]*v[0]+M[0][1]*v[1]+M[0][2]*v[2],
    M[1][0]*v[0]+M[1][1]*v[1]+M[1][2]*v[2],
    M[2][0]*v[0]+M[2][1]*v[1]+M[2][2]*v[2]
  ];
}
function transpose(M){ return M[0].map((_,i)=>M.map(row=>row[i])); }
function norm(v){ return Math.hypot(v[0],v[1],v[2]); }

// ENU->ECEF matrix
function enuToEcefMatrix(latDeg, lonDeg){
  const lat = deg2rad(latDeg), lon = deg2rad(lonDeg);
  return [
    [-Math.sin(lon), Math.cos(lon), 0],
    [-Math.sin(lat)*Math.cos(lon), -Math.sin(lat)*Math.sin(lon), Math.cos(lat)],
    [ Math.cos(lat)*Math.cos(lon),  Math.cos(lat)*Math.sin(lon), Math.sin(lat)]
  ];
}

// ray <-> ellipsoid intersection
function intersectEllipsoid(sensorECEF, dirECEF){
  const [x0,y0,z0] = sensorECEF;
  const [dx,dy,dz] = dirECEF;
  const A = (dx*dx + dy*dy)/(a*a) + (dz*dz)/(b*b);
  const B = 2*((x0*dx + y0*dy)/(a*a) + (z0*dz)/(b*b));
  const C = (x0*x0 + y0*y0)/(a*a) + (z0*z0)/(b*b) - 1;
  const disc = B*B - 4*A*C;
  if (disc < 0) return null;
  const t = (-B - Math.sqrt(disc)) / (2*A);
  const px = x0 + t*dx, py = y0 + t*dy, pz = z0 + t*dz;
  return ecefToGeodetic(px,py,pz);
}

// LOS builder from sensor az/el using same convention as used above
function losFromSensorAzEl(azDeg, elDeg, metadata){
  const az = deg2rad(azDeg), el = deg2rad(elDeg);
  // sensor frame: x forward, y right, z up
  let los = [Math.cos(el)*Math.cos(az), Math.cos(el)*Math.sin(az), Math.sin(el)];
  // apply sensor relative roll (we assume roll about x)
  const R_s = rotX(deg2rad(metadata["Sensor Relative Roll Angle"]));
  los = matvec(R_s, los);
  // apply platform attitude: heading(Z) * pitch(Y) * roll(X)
  const Rplat = matmul(rotZ(deg2rad(metadata["Platform Heading Angle"])),
                       matmul(rotY(deg2rad(metadata["Platform Pitch Angle"])),
                              rotX(deg2rad(metadata["Platform Roll Angle"]))));
  los = matvec(Rplat, los); // this is in ENU coordinates
  const enu2ecef = enuToEcefMatrix(metadata["Sensor Latitude"], metadata["Sensor Longitude"]);
  let dirECEF = matvec(enu2ecef, los);
  const n = norm(dirECEF);
  return dirECEF.map(x => x / n);
}

// quick ECEF distance
function ecefDistance(a,b){
  return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
}

// ====== Metadata (your KLV) ======
const metadata = {
  "Platform Heading Angle": 86.10666056305791,
  "Platform Pitch Angle": 3.359477523117775,
  "Platform Roll Angle": 0.5157628101443521,
  "Sensor Latitude": 54.68132328460055,
  "Sensor Longitude": -110.1685597701783,
  "Sensor True Altitude": 1532.272831311513,
  "Sensor Relative Azimuth Angle": 46.10314941175821,
  "Sensor Relative Elevation Angle": -4.41094972398642,
  "Sensor Relative Roll Angle": 358.2026063087868,
  "Slant Range": 10928.624544974562,
  "Frame Center Latitude": 54.74912345164881,
  "Frame Center Longitude": -110.0466381153309,
  "Frame Center Elevation": -4.52277409018086
};

// ====== Mapping discovered ======
const az_offset = 214.2665588159882;
const el_offset = 28.482788467356773;

const rawAz = metadata["Sensor Relative Azimuth Angle"];
const rawEl = metadata["Sensor Relative Elevation Angle"];
const azUsed = (rawAz + az_offset) % 360;
const elUsed = rawEl + el_offset;

console.log("raw Az/El:", rawAz, rawEl);
console.log("mapped Az/El:", azUsed, elUsed);

// compute frame center by ellipsoid intersection
const sensorECEF = geodeticToECEF(metadata["Sensor Latitude"], metadata["Sensor Longitude"], metadata["Sensor True Altitude"]);
const dir = losFromSensorAzEl(azUsed, elUsed, metadata);
const computedGeod = intersectEllipsoid(sensorECEF, dir);

console.log("Computed Frame Center (geod):", computedGeod);
console.log("Metadata Frame Center (geod):", [metadata["Frame Center Latitude"], metadata["Frame Center Longitude"], metadata["Frame Center Elevation"]]);

const fcECEF = geodeticToECEF(metadata["Frame Center Latitude"], metadata["Frame Center Longitude"], metadata["Frame Center Elevation"]);
const compECEF = geodeticToECEF(computedGeod[0], computedGeod[1], computedGeod[2]);
console.log("Residual (meters):", ecefDistance(fcECEF, compECEF).toFixed(3));
