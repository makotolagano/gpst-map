// NMEA parser for the GPST RX BLE output.
//
// For each received LoRa packet, the RX sends three sentences (see
// firmware/lib/nmea_out/nmea_out.c and docs/firmware/ble-module.md):
//   $GPRMC,,A,4548.90000,N,01558.91400,E,,,,,,A*71
//   $GPGGA,,4548.90000,N,01558.91400,E,1,08,1.2,123.0,M,,M,,*56
//   $PGPST,<id hex>,<seq>,<batt mV>,<rssi>,<snr>,<flags hex>,<lost>*CS
// The time and date fields are empty. The page uses the receive time.

/** Flag bits of the $PGPST sentence (firmware/include/gpst/proto.h). */
export const FLAGS = [
  { bit: 0, name: 'moving' },
  { bit: 1, name: 'charging' },
  { bit: 2, name: 'low battery' },
  { bit: 3, name: 'live' },
  { bit: 4, name: 'MIC' },
];

/** XOR of all characters of the body (the text between '$' and '*'). */
export function checksum(body) {
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
  return cs;
}

/** Add '$', the checksum and "\r\n" to a sentence body. */
export function makeSentence(body) {
  return `$${body}*${checksum(body).toString(16).toUpperCase().padStart(2, '0')}\r\n`;
}

/** "4548.90000", "N" -> 45.815. Returns null for an empty field. */
export function parseCoord(value, hemi) {
  if (!value) return null;
  const dot = value.indexOf('.');
  const degLen = (dot < 0 ? value.length : dot) - 2;
  if (degLen < 1) return null;
  const deg = Number(value.slice(0, degLen));
  const min = Number(value.slice(degLen));
  if (!Number.isFinite(deg) || !Number.isFinite(min) || min >= 60) return null;
  const v = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') return -v;
  if (hemi === 'N' || hemi === 'E') return v;
  return null;
}

/** 45.815 -> "4548.90000" (lat, 2 degree digits) or "01558.91400" (lon, 3 digits). */
export function formatCoord(value, degDigits) {
  const a = Math.abs(value);
  const deg = Math.floor(a);
  const min = (a - deg) * 60;
  return String(deg).padStart(degDigits, '0') + min.toFixed(5).padStart(8, '0');
}

function num(s) {
  if (s === undefined || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse one NMEA line (with or without "\r\n").
 * Returns an object with a "type" field: 'RMC', 'GGA', 'PGPST', 'other' or 'error'.
 */
export function parseLine(line) {
  const text = line.trim();
  if (!text.startsWith('$')) return { type: 'error', reason: 'no $', line: text };
  const star = text.lastIndexOf('*');
  if (star < 0 || star + 3 !== text.length) return { type: 'error', reason: 'no checksum', line: text };
  const body = text.slice(1, star);
  const want = parseInt(text.slice(star + 1), 16);
  if (Number.isNaN(want) || checksum(body) !== want) {
    return { type: 'error', reason: 'bad checksum', line: text };
  }
  const f = body.split(',');
  switch (f[0]) {
    case 'GPRMC':
    case 'GNRMC': {
      const lat = parseCoord(f[3], f[4]);
      const lon = parseCoord(f[5], f[6]);
      const valid = f[2] === 'A' && lat !== null && lon !== null;
      return {
        type: 'RMC', valid, lat: valid ? lat : null, lon: valid ? lon : null,
        speedKn: num(f[7]), courseDeg: num(f[8]),
      };
    }
    case 'GPGGA':
    case 'GNGGA': {
      const quality = num(f[6]) ?? 0;
      return {
        type: 'GGA', quality,
        lat: parseCoord(f[2], f[3]), lon: parseCoord(f[4], f[5]),
        sats: num(f[7]), hdop: num(f[8]), altM: num(f[9]),
      };
    }
    case 'PGPST': {
      if (f.length < 8) return { type: 'error', reason: 'short PGPST', line: text };
      const flags = parseInt(f[6], 16);
      return {
        type: 'PGPST',
        id: f[1].toUpperCase(),
        seq: num(f[2]), battMv: num(f[3]), rssi: num(f[4]), snr: num(f[5]),
        flags: Number.isNaN(flags) ? 0 : flags, lost: num(f[7]),
      };
    }
    default:
      return { type: 'other', talker: f[0] };
  }
}

/** Collect BLE notification text and return complete lines. */
export class LineSplitter {
  constructor(maxLen = 200) {
    this.buf = '';
    this.maxLen = maxLen;
  }

  push(text) {
    this.buf += text;
    const out = [];
    let i;
    while ((i = this.buf.search(/[\r\n]/)) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length > 0) out.push(line);
    }
    // A line without an end can be noise. Do not let the buffer grow.
    if (this.buf.length > this.maxLen) this.buf = '';
    return out;
  }
}

/**
 * Combine RMC + GGA + PGPST of one packet into one report.
 * onReport(report) receives:
 *   { id, valid, lat, lon, altM, sats, hdop, seq, battMv, rssi, snr, flags, lost, t }
 * id is null if the PGPST sentence did not arrive.
 */
export class ReportBuilder {
  constructor(onReport, now = () => Date.now()) {
    this.onReport = onReport;
    this.now = now;
    this.pending = null;
  }

  add(msg) {
    if (msg.type === 'RMC') {
      this.flush();
      this.pending = {
        id: null, valid: msg.valid, lat: msg.lat, lon: msg.lon,
        altM: null, sats: null, hdop: null,
        seq: null, battMv: null, rssi: null, snr: null, flags: 0, lost: null,
        t: this.now(),
      };
    } else if (msg.type === 'GGA') {
      if (!this.pending) {
        this.pending = {
          id: null, valid: msg.quality > 0 && msg.lat !== null && msg.lon !== null,
          lat: msg.lat, lon: msg.lon, seq: null, battMv: null, rssi: null, snr: null,
          flags: 0, lost: null, t: this.now(),
        };
      }
      Object.assign(this.pending, { altM: msg.altM, sats: msg.sats, hdop: msg.hdop });
    } else if (msg.type === 'PGPST') {
      const r = this.pending ?? {
        valid: false, lat: null, lon: null, altM: null, sats: null, hdop: null, t: this.now(),
      };
      Object.assign(r, {
        id: msg.id, seq: msg.seq, battMv: msg.battMv, rssi: msg.rssi, snr: msg.snr,
        flags: msg.flags, lost: msg.lost,
      });
      this.pending = null;
      this.onReport(r);
    }
  }

  /** Send a report that has no PGPST sentence (call after a time-out). */
  flush() {
    if (this.pending) {
      const r = this.pending;
      this.pending = null;
      this.onReport(r);
    }
  }
}

const R_EARTH = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, in degrees (0 = north, clockwise). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2))
    - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 0..360 degrees -> "N", "NE", ... */
export function compassPoint(deg) {
  const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return pts[Math.round(deg / 45) % 8];
}

/**
 * Rough state of charge of a 1S LiPo from the voltage (no load).
 * This is an estimate only.
 */
export function lipoPercent(mv) {
  if (mv === null || mv === undefined) return null;
  const table = [
    [3000, 0], [3300, 3], [3500, 8], [3600, 15], [3700, 35],
    [3750, 50], [3800, 60], [3900, 75], [4000, 85], [4100, 94], [4200, 100],
  ];
  if (mv <= table[0][0]) return 0;
  for (let i = 1; i < table.length; i++) {
    const [v1, p1] = table[i];
    const [v0, p0] = table[i - 1];
    if (mv <= v1) return Math.round(p0 + ((mv - v0) * (p1 - p0)) / (v1 - v0));
  }
  return 100;
}

/** Names of the set flag bits. */
export function flagNames(flags) {
  return FLAGS.filter((f) => flags & (1 << f.bit)).map((f) => f.name);
}

/** Make the three sentences that the RX sends for one packet (for demo mode and tests). */
export function makePacket({ lat, lon, altM = 0, sats = 8, hdop = 1.2, id = 0x0a1b2c3d,
  seq = 0, battMv = 3900, rssi = -90, snr = 8, flags = 0, lost = 0, valid = true }) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const la = formatCoord(lat, 2);
  const lo = formatCoord(lon, 3);
  const rmc = valid
    ? makeSentence(`GPRMC,,A,${la},${ns},${lo},${ew},,,,,,A`)
    : makeSentence('GPRMC,,V,,,,,,,,,,N');
  const gga = valid
    ? makeSentence(`GPGGA,,${la},${ns},${lo},${ew},1,${String(sats).padStart(2, '0')},${hdop.toFixed(1)},${altM.toFixed(1)},M,,M,,`)
    : makeSentence('GPGGA,,,,,,0,00,,,M,,M,,');
  const st = makeSentence(
    `PGPST,${(id >>> 0).toString(16).toUpperCase().padStart(8, '0')},${seq},${battMv},${rssi},${snr},`
    + `${flags.toString(16).toUpperCase().padStart(2, '0')},${lost}`,
  );
  return rmc + gga + st;
}

/** GPX 1.1 text for the tracks: { id: [{lat, lon, altM, t}] }. */
export function toGpx(tracks) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="GPST RX map" xmlns="http://www.topografix.com/GPX/1/1">\n';
  for (const [id, pts] of Object.entries(tracks)) {
    out += `  <trk><name>GPST ${esc(id)}</name><trkseg>\n`;
    for (const p of pts) {
      out += `    <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`;
      if (p.altM !== null && p.altM !== undefined) out += `<ele>${p.altM}</ele>`;
      out += `<time>${new Date(p.t).toISOString()}</time></trkpt>\n`;
    }
    out += '  </trkseg></trk>\n';
  }
  return `${out}</gpx>\n`;
}
