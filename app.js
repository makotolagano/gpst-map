// GPST RX map: shows the TX positions that the RX sends over BLE (Nordic UART Service).
// See README.md in this directory.

import {
  parseLine, LineSplitter, ReportBuilder, makePacket, distanceM, bearingDeg, compassPoint,
  lipoPercent, flagNames, toGpx,
} from './nmea.js';

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // RX module -> phone (notify)
const STALE_S = 180;       // The age at which the position shows in red.
const MAX_TRACK = 5000;    // Points kept for each TX.
const MAX_LOG = 300;       // Lines kept in the log.
const COLORS = ['#dc2626', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2'];
const STORE_KEY = 'gpst-rx-map-v1';
const DEMO = new URLSearchParams(location.search).has('demo');

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state

const devices = new Map(); // id -> { id, color, last, track: [], marker, line }
let selectedId = null;
let me = null;             // { lat, lon, acc, t }
let heading = null;        // Phone compass heading in degrees, or null.
let lastBearing = null;    // Bearing from the phone to the selected TX, in degrees.
let follow = true;
let bleDevice = null;
let manualDisconnect = false;
let retryMs = 1000;
let wakeLock = null;

// ---------------------------------------------------------------- storage (convenience only)

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveStore() {
  try {
    const last = {};
    for (const d of devices.values()) if (d.last) last[d.id] = d.last;
    localStorage.setItem(STORE_KEY, JSON.stringify({ last, selectedId, view: [map.getCenter(), map.getZoom()] }));
  } catch {
    // Storage is not available (private window). The page works without it.
  }
}

// ---------------------------------------------------------------- map

const store = loadStore();
const map = L.map('map', { zoomControl: false, attributionControl: true });
if (store.view) map.setView(store.view[0], store.view[1]);
else map.setView([45.815, 15.982], 13);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const meMarker = L.marker([0, 0], {
  icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
  interactive: false,
});
const meAcc = L.circle([0, 0], { radius: 1, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false });
const meLine = L.polyline([], { color: '#2563eb', weight: 2, dashArray: '6 6', interactive: false });

// The panel height changes with its content. Leaflet must then measure the map again.
new ResizeObserver(() => {
  map.invalidateSize();
  if (follow) frame();
}).observe($('map'));

map.on('dragstart', () => setFollow(false));
map.on('moveend', saveStore);

function getDevice(id) {
  let d = devices.get(id);
  if (!d) {
    const color = COLORS[devices.size % COLORS.length];
    d = {
      id, color, last: null, track: [],
      line: L.polyline([], { color, weight: 3, opacity: 0.7 }).addTo(map),
      marker: L.circleMarker([0, 0], { radius: 9, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }),
    };
    d.marker.bindTooltip(id, { direction: 'top', offset: [0, -10] });
    d.marker.on('click', () => select(id));
    devices.set(id, d);
    if (!selectedId) selectedId = id;
  }
  return d;
}

// ---------------------------------------------------------------- reports

const splitter = new LineSplitter();
const builder = new ReportBuilder(onReport);
let flushTimer = null;

function onText(text) {
  for (const line of splitter.push(text)) {
    const msg = parseLine(line);
    log(line, msg.type === 'error' ? msg.reason : null);
    if (msg.type === 'error') continue;
    builder.add(msg);
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => builder.flush(), 1500);
}

function onReport(r) {
  const id = r.id ?? selectedId ?? 'unknown';
  const d = getDevice(id);
  const prev = d.last;
  // Keep the last valid position if this packet has no fix.
  d.last = {
    ...r,
    id,
    posLat: r.valid ? r.lat : prev?.posLat ?? null,
    posLon: r.valid ? r.lon : prev?.posLon ?? null,
    posT: r.valid ? r.t : prev?.posT ?? null,
  };
  if (r.valid) {
    d.track.push({ lat: r.lat, lon: r.lon, altM: r.altM, t: r.t });
    if (d.track.length > MAX_TRACK) d.track.shift();
    d.line.addLatLng([r.lat, r.lon]);
    d.marker.setLatLng([r.lat, r.lon]);
    if (!map.hasLayer(d.marker)) d.marker.addTo(map);
  }
  saveStore();
  render();
  if (follow && id === selectedId) frame();
}

function restore() {
  for (const [id, last] of Object.entries(store.last || {})) {
    const d = getDevice(id);
    d.last = last;
    if (last.posLat !== null && last.posLat !== undefined) {
      d.marker.setLatLng([last.posLat, last.posLon]).addTo(map);
    }
  }
  if (store.selectedId && devices.has(store.selectedId)) selectedId = store.selectedId;
}

// ---------------------------------------------------------------- view

function select(id) {
  selectedId = id;
  saveStore();
  render();
  if (follow) frame();
}

function setFollow(on) {
  follow = on;
  $('btnFollow').setAttribute('aria-pressed', String(on));
  if (on) frame();
}

/** Show the selected TX and the phone together. */
function frame() {
  const d = devices.get(selectedId);
  const pts = [];
  if (d?.last?.posLat != null) pts.push([d.last.posLat, d.last.posLon]);
  if (me) pts.push([me.lat, me.lon]);
  if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 16));
  else if (pts.length === 2) map.fitBounds(pts, { padding: [48, 48], maxZoom: 17 });
}

function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(2)} km`;
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s ago`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
}

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function cell(k, v) {
  return `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

function render() {
  // Tabs: only when more than one TX is known.
  const tabs = $('tabs');
  tabs.innerHTML = devices.size > 1
    ? [...devices.values()].map((d) => `<button class="tab" data-id="${esc(d.id)}" aria-pressed="${d.id === selectedId}">`
      + `<span class="sw" style="background:${d.color}"></span>${esc(d.id)}</button>`).join('')
    : '';
  tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => select(b.dataset.id)));

  const d = devices.get(selectedId);
  const el = $('details');
  if (!d?.last) {
    el.innerHTML = `<div class="empty"><b>No TX data yet.</b><br>
      Push <b>Connect</b> and select <b>GPST-RX</b>. The RX sends one update for each LoRa packet.</div>`;
    meLine.setLatLngs([]);
    return;
  }
  const r = d.last;
  const hasPos = r.posLat != null;
  let headline;
  if (hasPos && me) {
    const dist = distanceM(me.lat, me.lon, r.posLat, r.posLon);
    const brg = bearingDeg(me.lat, me.lon, r.posLat, r.posLon);
    lastBearing = brg;
    const rot = heading === null ? brg : brg - heading;
    headline = `
      <svg class="arrow" id="arrow" viewBox="0 0 56 56" style="transform:rotate(${rot}deg)" aria-hidden="true">
        <circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2"/>
        <path d="M28 6 L40 40 L28 33 L16 40 Z" fill="${d.color}"/>
      </svg>
      <div><div class="dist">${fmtDist(dist)}</div>
      <div class="sub">${compassPoint(brg)} ${Math.round(brg)}° ${heading === null ? '(arrow: north up)' : '(arrow: phone direction)'}</div></div>`;
    meLine.setLatLngs([[me.lat, me.lon], [r.posLat, r.posLon]]);
    if (!map.hasLayer(meLine)) meLine.addTo(map);
  } else {
    headline = `<div><div class="dist">${hasPos ? 'TX found' : 'No position'}</div>
      <div class="sub">${hasPos ? 'Your position is not known. Push “My position”.' : 'The TX has no GNSS fix yet.'}</div></div>`;
    meLine.setLatLngs([]);
  }
  const age = Date.now() - (r.posT ?? r.t);
  const stale = age > STALE_S * 1000;
  const pct = lipoPercent(r.battMv);
  const flags = flagNames(r.flags ?? 0);
  const chips = [
    !r.valid ? '<span class="chip warn">no GNSS fix in the last packet</span>' : '',
    ...flags.map((f) => `<span class="chip ${f === 'low battery' ? 'bad' : ''}">${esc(f)}</span>`),
  ].join('');

  el.innerHTML = `
    <div class="headline">${headline}</div>
    <div class="sub" style="margin-top:6px">TX ${esc(d.id)} · position
      <span class="age" id="age" data-stale="${stale}">${hasPos ? fmtAge(age) : '–'}</span>
      · packet <span id="pktAge">${fmtAge(Date.now() - r.t)}</span></div>
    <div class="grid">
      ${cell('Battery', r.battMv != null ? `${(r.battMv / 1000).toFixed(2)} V (about ${pct} %)` : '–')}
      ${cell('Signal', r.rssi != null ? `${r.rssi} dBm, SNR ${r.snr} dB` : '–')}
      ${cell('GNSS', r.sats != null ? `${r.sats} sats, HDOP ${r.hdop ?? '–'}` : '–')}
      ${cell('Altitude', r.altM != null ? `${Math.round(r.altM)} m` : '–')}
      ${cell('Packet', r.seq != null ? `#${r.seq}, ${r.lost ?? 0} lost` : '–')}
      ${cell('Position', hasPos ? `${r.posLat.toFixed(5)}, ${r.posLon.toFixed(5)}` : '–')}
      ${cell('Track', `${d.track.length} points`)}
      ${cell('Your accuracy', me ? `${Math.round(me.acc)} m` : '–')}
    </div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}`;
}

// The age text changes each second. Do not redraw the full panel for it.
setInterval(() => {
  const r = devices.get(selectedId)?.last;
  if (!r) return;
  const a = $('age');
  if (a && r.posLat != null) {
    const age = Date.now() - (r.posT ?? r.t);
    a.textContent = fmtAge(age);
    a.dataset.stale = String(age > STALE_S * 1000);
  }
  const p = $('pktAge');
  if (p) p.textContent = fmtAge(Date.now() - r.t);
}, 1000);

// ---------------------------------------------------------------- log and messages

function log(line, err) {
  const box = $('log');
  const div = document.createElement('div');
  div.textContent = `${new Date().toLocaleTimeString()}  ${line}${err ? `  (${err})` : ''}`;
  if (err) div.className = 'err';
  box.appendChild(div);
  while (box.childElementCount > MAX_LOG) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 6000);
}

function setConn(state, text) {
  $('conn').dataset.state = state;
  $('connText').textContent = text;
  const btn = $('btnConnect');
  const busy = state === 'connected' || state === 'connecting' || state === 'lost';
  btn.textContent = busy ? 'Disconnect' : 'Connect';
  btn.classList.toggle('primary', !busy);
}

// ---------------------------------------------------------------- Bluetooth

async function connect() {
  if (DEMO) return;
  if (!navigator.bluetooth) {
    toast('This browser has no Web Bluetooth. Use Chrome on Android, or Chrome or Edge on a computer.');
    return;
  }
  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'GPST' }, { services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(`Bluetooth: ${e.message}`);
    return; // The user closed the device list.
  }
  manualDisconnect = false;
  bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
  await openGatt();
}

async function openGatt() {
  setConn('connecting', `Connecting to ${bleDevice.name || 'RX'}…`);
  try {
    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    const ch = await service.getCharacteristic(NUS_TX_CHAR);
    const decoder = new TextDecoder();
    ch.addEventListener('characteristicvaluechanged', (e) => onText(decoder.decode(e.target.value, { stream: true })));
    await ch.startNotifications();
    retryMs = 1000;
    setConn('connected', `Connected: ${bleDevice.name || 'RX'}`);
    keepScreenOn();
  } catch (e) {
    if (manualDisconnect) return;
    toast(`Connection failed: ${e.message}`);
    scheduleRetry();
  }
}

function onDisconnected() {
  if (manualDisconnect) {
    setConn('idle', 'Not connected');
    return;
  }
  scheduleRetry();
}

function scheduleRetry() {
  setConn('lost', `Connection lost. New attempt in ${Math.round(retryMs / 1000)} s`);
  setTimeout(() => {
    if (!manualDisconnect && bleDevice && !bleDevice.gatt.connected) openGatt();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, 15000);
}

function disconnect() {
  manualDisconnect = true;
  if (bleDevice?.gatt.connected) bleDevice.gatt.disconnect();
  setConn('idle', 'Not connected');
  releaseScreen();
}

async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // Not permitted (for example, battery saver). The page works without it.
  }
}

function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && bleDevice?.gatt.connected) keepScreenOn();
});

// ---------------------------------------------------------------- phone position and compass

function startGeolocation() {
  if (DEMO) return;
  if (!navigator.geolocation) {
    toast('This browser cannot give your position.');
    return;
  }
  navigator.geolocation.watchPosition(
    (p) => setMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
    (e) => toast(`Your position: ${e.message}`),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
  );
}

function setMe(lat, lon, acc) {
  const first = !me;
  me = { lat, lon, acc, t: Date.now() };
  meMarker.setLatLng([lat, lon]);
  meAcc.setLatLng([lat, lon]).setRadius(acc);
  if (!map.hasLayer(meMarker)) { meMarker.addTo(map); meAcc.addTo(map); }
  render();
  if (first && follow) frame();
}

function onOrientation(e) {
  if (e.alpha === null) return;
  const screenAngle = screen.orientation?.angle ?? 0;
  const first = heading === null;
  heading = (360 - e.alpha + screenAngle) % 360;
  if (first) { render(); return; }
  // Turn only the arrow. A full redraw at the sensor rate is not necessary.
  const arrow = $('arrow');
  if (arrow && lastBearing !== null) arrow.style.transform = `rotate(${lastBearing - heading}deg)`;
}
if ('ondeviceorientationabsolute' in window) {
  window.addEventListener('deviceorientationabsolute', onOrientation);
}

// ---------------------------------------------------------------- buttons

$('btnConnect').addEventListener('click', () => {
  const state = $('conn').dataset.state;
  if (state === 'idle') connect();
  else disconnect();
});
$('btnFollow').addEventListener('click', () => setFollow(!follow));
$('btnMe').addEventListener('click', () => {
  if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 16));
  else startGeolocation();
});
$('btnLog').addEventListener('click', () => {
  const open = $('log').classList.toggle('open');
  $('btnLog').setAttribute('aria-pressed', String(open));
});
$('btnClear').addEventListener('click', () => {
  const d = devices.get(selectedId);
  if (!d) return;
  d.track = [];
  d.line.setLatLngs([]);
  render();
});
$('btnGpx').addEventListener('click', () => {
  const tracks = {};
  for (const d of devices.values()) if (d.track.length) tracks[d.id] = d.track;
  if (!Object.keys(tracks).length) { toast('No track points to save.'); return; }
  const blob = new Blob([toGpx(tracks)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gpst-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------------------------------------------------------------- demo mode

function startDemo() {
  $('demo').style.display = 'block';
  setConn('connected', 'Demo: GPST-RX');
  const c = { lat: 45.815, lon: 15.982 };
  setMe(c.lat - 0.004, c.lon - 0.006, 12);
  let seq = 0;
  const tick = () => {
    const a = seq / 12;
    const pkt = makePacket({
      lat: c.lat + 0.003 * Math.sin(a), lon: c.lon + 0.004 * Math.cos(a), altM: 120 + (seq % 5),
      sats: 9, hdop: 1.1, seq, battMv: 3950 - seq * 2, rssi: -88 - (seq % 7), snr: 9 - (seq % 4),
      flags: 0x09, lost: Math.floor(seq / 10), valid: seq % 15 !== 14,
    });
    // Send the text in BLE-size pieces, as the module does.
    for (let i = 0; i < pkt.length; i += 20) onText(pkt.slice(i, i + 20));
    seq++;
  };
  tick();
  setInterval(tick, 3000);
}

// ---------------------------------------------------------------- start

restore();
render();
if (DEMO) startDemo();
else startGeolocation();
