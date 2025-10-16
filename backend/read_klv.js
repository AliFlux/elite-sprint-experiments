const fs = require('fs')
const { st0601, st0903, st0104, st0806, klv } = require('@vidterra/misb.js')

if (process.argv.length < 3) {
  console.error(`Usage: node ${process.argv[1]} klv.bin`)
  process.exit(1)
}

const klvFile = process.argv[2]
const standards = [st0601, st0903, st0806, st0104]
const file = fs.readFileSync(klvFile)
const result = klv.decode(file, standards)

console.log(result)


// find the ST0601 packet with the lowest Precision Time Stamp
const packets = result[st0601.name] || []
if (packets.length === 0) {
  console.error('No ST0601 packets found')
  process.exit(1)
}

for(var packet of packets) {
  
  const obj = packet.reduce((acc, item) => {
    acc[item.name] = item.value
    return acc
  }, {})

console.log(obj)
}

// let firstPacket = null
// let minTs = Number.MAX_VALUE

// for (const packet of packets) {
//   const obj = packet.reduce((acc, item) => {
//     acc[item.name] = item.value
//     return acc
//   }, {})
//   const ts = obj['Precision Time Stamp']
//   if (typeof ts === 'number' && ts < minTs) {
//     minTs = ts
//     firstPacket = obj
//   }
// }

// if (firstPacket) {
//   console.log(`Earliest Precision Time Stamp: ${minTs}`)
//   console.log(JSON.stringify(firstPacket, null, 2))
// } else {
//   console.error('Could not find Precision Time Stamp in any packet')
// }
