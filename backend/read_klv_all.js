const fs = require('fs')
const { klv, st0601 } = require('@vidterra/misb.js')

const file = fs.readFileSync('../frontend/flight.mpg') // read the whole MPEG-TS file
const result = klv.decode(file, [st0601])   // decode all ST0601 packets

// Filter only EON packets
const eonPackets = (result[st0601.name] || []).map(packet =>
  packet.reduce((acc, item) => {
    acc[item.name] = item.value
    return acc
  }, {})
).filter(p => p['Image Source Sensor'] === 'EON')

// Save as JSON
fs.writeFileSync('flight_eon.json', JSON.stringify(eonPackets, null, 2))
console.log(`Saved ${eonPackets.length} EON packets to flight_eon.json`)


