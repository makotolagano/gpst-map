# RX map (Web Bluetooth page)

This page shows the TX position on a map. It connects to the RX through Bluetooth LE
(Nordic UART Service of the E104-BT5010A) and reads the NMEA lines that the RX sends.
You do not install an app. The page runs in Chrome.

Data flow: TX → (LoRa) → RX → (BLE, Nordic UART Service) → Chrome → map.

## 1. What the page shows

- The TX position and its track on an OpenStreetMap map.
- Your phone position, the distance to the TX and the direction to the TX.
  If the phone has a compass, the arrow turns with the phone.
  If not, the arrow points relative to north.
- The age of the last position. It shows in red after 3 minutes.
- The TX battery voltage (and an estimate in %), RSSI, SNR, satellites, HDOP and altitude.
- The packet number, the number of lost packets and the TX flags (moving, charging, low battery, live, MIC).
- A log of the received lines. Lines with a bad checksum show in red.
- "Save GPX" saves the track as a GPX file.

If the RX receives more than one TX, the page shows one tab for each TX ID.
The page keeps the last position of each TX in the browser. After a reload, the last position shows again.

## 2. Browser and phone

| Host | Works | Note |
|---|---|---|
| Android, Chrome | Yes | Use this. |
| Windows, macOS, Linux, ChromeOS: Chrome or Edge | Yes | The computer must have Bluetooth LE. |
| iPhone, iPad (all browsers) | No | iOS has no Web Bluetooth. Use nRF Toolbox (see docs/firmware/ble-module.md). |
| Firefox, Safari | No | No Web Bluetooth. |

Web Bluetooth operates only on `https://` pages or on `http://localhost`.

## 3. Start the page

### 3.1 On a computer

1. Start the local web server from the repository root:

   ```bash
   make rx-map
   ```

2. Open `http://localhost:8000` in Chrome or Edge.

### 3.2 On an Android phone (USB cable, no internet server)

1. On the phone, enable "Developer options" and "USB debugging". Connect the phone to the computer.
2. Start the web server on the computer: `make rx-map`.
3. In a second terminal, connect the phone port 8000 to the computer port 8000:

   ```bash
   adb reverse tcp:8000 tcp:8000
   ```

4. On the phone, open `http://localhost:8000` in Chrome.

After the page opens, it keeps its data when you disconnect the USB cable.
A reload needs the cable and the server again.
The map tiles come from the internet, so the phone must have a data connection.

> **Note:** You can also put the four files of this directory on an HTTPS server
> (for example GitHub Pages). Then the phone needs no cable.

## 4. Connect to the RX

1. Make sure that Bluetooth and location are on, on the phone.
2. Push **Connect**. Select **GPST-RX** in the list.
3. Allow "Nearby devices" and "Location" if Chrome asks.
4. Wait for the next LoRa packet. The TX position then shows on the map.

If the connection stops, the page tries again (1 s, 2 s, 4 s ... up to 15 s).
While the page is connected, it keeps the screen on.

> **CAUTION:** Close nRF Toolbox and Serial Bluetooth Terminal before you push Connect.
> The E104 accepts only one connection.

## 5. Demo mode

Open `http://localhost:8000/?demo=1`. The page then shows a simulated TX that moves in a circle.
It needs no RX and no Bluetooth. Use it to examine the page.

## 6. Tests

Open `http://localhost:8000/test.html`. The page runs the parser tests.
The tests use the expected sentences of `firmware/tests/nmea_out` and show "All tests passed".

## 7. Data format

For each LoRa packet, the RX sends three lines (see `firmware/lib/nmea_out/nmea_out.c`):

```text
$GPRMC,,A,4548.90000,N,01558.91400,E,,,,,,A*71
$GPGGA,,4548.90000,N,01558.91400,E,1,08,1.2,123.0,M,,M,,*56
$PGPST,0A1B2C3D,42,3700,-97,7,01,3*4C
```

`$PGPST` fields: TX ID (hex), packet number, battery (mV), RSSI (dBm), SNR (dB), flags (hex), lost packets.
The time fields are empty, so the page uses the receive time.

If you change the format in the firmware, change `nmea.js` and `test.html` at the same time.

## 8. Files

| File | Content |
|---|---|
| `index.html` | Page layout and style |
| `app.js` | Bluetooth, map, phone position, compass, panel |
| `nmea.js` | NMEA parser, distance and bearing, GPX output. No browser functions, so you can test it alone. |
| `test.html` | Parser tests |

The page loads Leaflet 1.9.4 from cdnjs.cloudflare.com and the map tiles from tile.openstreetmap.org.

## 9. Prototype (LoRa-E5 mini kit)

The connections of the E104 test board to the kit are in
`firmware/apps/rx/boards/lora_e5_mini.overlay`. Build the RX firmware for the kit with `make devkit`.
