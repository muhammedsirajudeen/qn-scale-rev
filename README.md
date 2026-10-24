# QN-Scale Reader

A standalone Node.js application that communicates directly with Healthify / QN-Scale smart weighing scales over Bluetooth Low Energy (BLE), without requiring the Healthify mobile application, subscription, or cloud API.

## Supported Devices

Scales built on the **Qingniu (QN) / Yolanda** hardware module, commonly sold under brands including:
- **Healthify**
- **Libra** (CS20C1)
- **FitIndex** (ES-26M)
- **Renpho**
- **Kamtron**

These devices typically advertise as `QN-Scale` over BLE.

## Protocol Documentation

The protocol implementation is based on:
1. **[paveldemyanov/qn-scale](https://github.com/paveldemyanov/qn-scale)** — Reverse-engineered protocol documentation (`PROTOCOL.md`), verified against live Libra CS20C1 hardware.
2. **[openScale QNHandler.kt](https://github.com/oliexdev/openScale/blob/master/android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/QNHandler.kt)** — Android implementation supporting QN-family scales.
3. **[BHSPitMonkey/qn_scale_ble](https://github.com/BHSPitMonkey/qn_scale_ble)** — Python BLE library for QN-Scale variants.

Every protocol constant in this codebase cites its source in code comments.

## Requirements

- **Node.js** 18 or later (tested on 22.x)
- **Linux** with BlueZ Bluetooth stack
- **D-Bus permissions** for BLE access (see setup below)
- **BLE-capable Bluetooth adapter**

## Installation

```bash
# Clone or copy the project
cd qn-scale-reader

# Install dependencies
npm install

# Set up D-Bus permissions for BLE access (required once)
echo '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="'$(id -un)'">
    <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>' | sudo tee /etc/dbus-1/system.d/node-ble.conf > /dev/null

# Restart D-Bus (or reboot)
sudo systemctl restart dbus
```

## Usage

### Scan for nearby QN-Scale devices

```bash
node qn-scale.js scan
```

### Inspect GATT services and characteristics

```bash
node qn-scale.js inspect --address FB:01:00:18:50:08
```

### Capture raw BLE notifications

```bash
node qn-scale.js capture --address FB:01:00:18:50:08
```

### Take a live measurement

```bash
node qn-scale.js measure --address FB:01:00:18:50:08
```

Step on the scale after running this command. The application will:
1. Connect to the scale
2. Complete the QN handshake (unit config + time sync)
3. Wait for the scale to report a stable weight
4. Save the measurement to the local database
5. Display the result

### Retrieve stored measurements

```bash
node qn-scale.js history --address FB:01:00:18:50:08
```

### Export stored readings to CSV

```bash
node qn-scale.js export --format csv --output ./data/export.csv
```

### Configuration

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `--address`, `-a` | `QN_SCALE_ADDRESS` | `FB:01:00:18:50:08` | Bluetooth MAC address |
| `--timeout`, `-t` | — | `60` | Operation timeout (seconds) |
| `--unit`, `-u` | — | `kg` | Weight unit: `kg` or `lb` |
| `--db` | — | `./data/measurements.db` | SQLite database path |
| `--output`, `-o` | — | `./data/export.csv` | Export output file |
| `--format`, `-f` | — | `csv` | Export format |

## Protocol Overview

### BLE Service Layout (Type 2 — used by Healthify / CS20C1)

| UUID | Role | Properties |
|------|------|-----------|
| `0xFFF0` | Data service | — |
| `0xFFF1` | Measurements → client | Notify |
| `0xFFF2` | Commands → scale | Write (with response only!) |
| `0x180F` / `0x2A19` | Battery level | Read |

> **⚠️ Important**: The scale advertises service `0xFFE0`, but actual data communication uses `0xFFF0`. Writes to `0xFFF2` must use `writeWithResponse`; write-without-response is silently ignored.

### Handshake Sequence

```
Scale → Client   0x12  Greeting (MAC, protocol version)
Client → Scale   0x13  Unit configuration (kg/lb)
Client → Scale   0x02  Current time (no checksum)
Scale → Client   0x14  Settings acknowledged
Client → Scale   0x20  Time synchronization
Scale → Client   0x21  Service frame (ignorable)
Scale → Client   0x10  Measurement stream (~2x/second)
```

Without the time commands (`0x02` and `0x20`), the measurement stream **does not start**.

### Measurement Packet (`0x10`)

```
10 0b 15 1f ae 01 02 15 01 e4 00 fa
         └─┬──┘ │  └──┬──┘ └──┬──┘  └ checksum
      weight BE  stab  imp1    imp2
   0x1FAE = 8110 → 81.10 kg
```

- Bytes 3–4: Weight (big-endian, hundredths of kg)
- Byte 5: `0x01` = weight locked/stable, `0x00` = still changing
- Bytes 6–7: Impedance channel 1 (big-endian, ohms)
- Bytes 8–9: Impedance channel 2 (big-endian, ohms)

### What This Application Does NOT Calculate

The scale transmits **weight** and **raw impedance** values. Body composition metrics (body fat %, muscle mass, water %, bone mass, visceral fat) require:
1. User parameters (height, age, sex)
2. A body composition model (e.g., Trisa/Lu et al.)

This application stores raw impedance values for external computation but does **not fabricate** body composition metrics.

## Data Storage

Measurements are stored in a local SQLite database (`./data/measurements.db`) with:
- Unique record ID
- ISO 8601 timestamp with timezone
- Device address
- Weight in kilograms
- Raw impedance values
- Original raw packet (hex)
- Protocol version
- Decode status

Duplicate detection prevents the same measurement from being saved twice.

## Running Tests

```bash
npm test
```

Tests use documented packet captures and synthetic fixtures (clearly labeled) to verify:
- Frame encoding/decoding
- Checksum calculation
- Weight decoding
- Impedance decoding
- Malformed packet handling
- SQLite persistence
- CSV export

## Project Structure

```
qn-scale-reader/
├── package.json
├── README.md
├── qn-scale.js          # Entry point
├── qnscale/
│   ├── ble.js           # BLE communication (node-ble)
│   ├── protocol.js      # QN protocol encoding/decoding
│   ├── decoder.js        # Measurement interpretation
│   ├── storage.js        # SQLite persistence
│   └── cli.js            # Command-line interface
├── tests/
│   ├── test_protocol.js  # Protocol encoding/decoding tests
│   ├── test_decoder.js   # Measurement decoder tests
│   └── test_storage.js   # Storage and export tests
└── data/                  # Database and exports
```

## Verified Live Hardware Evidence

Communication was experimentally validated against the user's live physical scale (`FB:01:00:18:50:08`):

| Property | Observed Live Value |
|---|---|
| **BLE Name** | `QN-Scale` |
| **Manufacturer** | `Qing Niu Technology` (via GATT char `0x2A29`) |
| **Firmware Revision** | `V25.1` (via GATT char `0x2A26`) |
| **Battery Level** | `100%` (via GATT char `0x2A19` / Service `0x180F`) |
| **GATT Service Layout** | Type 2 (`FFF0` data service, `FFF1` notify, `FFF2` write) |
| **Greeting Packet** | `12 11 ff 08 50 18 00 01 fb 0a 03 19 00 06 05 07 c6` |
| **Protocol Type** | `0xFF` (Universal / Fit Plus family) |
| **Settings Ack** | `14 0b ff 00 00 01 00 00 00 00 1f` |
| **Service Frame** | `21 04 ff 01 25` |
| **Live Measurement** | `10 0b ff 02 53 01 00 00 00 00 70` (5.95 kg, Stable, Checksum valid) |

### ✅ Verified Functionality
- BLE discovery & GATT inspection (discovers `FB:01:00:18:50:08` and parses services/characteristics)
- Complete handshake flow (0x12 → 0x13 config → 0x02 clock → 0x14 ack → 0x20 sync → 0x21 service → two 0xA0 responses)
- Serialized GATT writes preventing D-Bus in-progress collisions
- Live measurement streaming (0x10 frames decoded at ~2Hz)
- Weight decoding (bytes 3–4, Big-Endian, hundredths of kg)
- Stability flag (byte 5: 0x01 = stable, 0x00 = unstable)
- Checksum validation (byte sum modulo 256)
- SQLite datastore (`./data/measurements.db`) with duplicate prevention
- CSV export (`node qn-scale.js export`)

### ⚠️ Remaining Limitations & Assumptions
- **Historical Measurements (0x22/0x23)**: Query frame 0x22 is implemented according to protocol documentation. Stored flash readings will be received if the scale has offline records saved in memory.
- **Body Composition Calculations**: Raw impedance (ohms) is extracted and persisted. Body fat %, muscle mass, and visceral fat are intentionally NOT fabricated on the device, as they require proprietary non-linear formulas (e.g. Trisa library) and user parameters.

## Troubleshooting

### "Permission denied" or D-Bus errors
Ensure the D-Bus policy file is installed (see Installation) and restart D-Bus.

### Scale not found during scan
- The scale only advertises when active (someone steps on it)
- Step on the scale, then immediately run the scan
- Check that your Bluetooth adapter is powered on: `bluetoothctl show`

### Handshake stalls / no measurements
- Ensure writes use `withResponse` (handled by the application)
- Step on the scale after the connection is established
- The scale may need a fresh power-on (step off and back on)

### "No adapter found"
- Check Bluetooth adapter: `hciconfig`
- Ensure BlueZ is running: `systemctl status bluetooth`

## Supplying Raw BLE Captures

If further protocol analysis is needed, you can capture raw BLE traffic:

```bash
# Option 1: Use the capture command
node qn-scale.js capture --address FB:01:00:18:50:08 2>&1 | tee capture.log

# Option 2: Use btmon for low-level capture
sudo btmon -w capture.btsnoop &
# Then run the measure command
node qn-scale.js measure --address FB:01:00:18:50:08
sudo kill %1
```

Share the `capture.log` or `capture.btsnoop` file for analysis.

## License

MIT

## Acknowledgments

- [paveldemyanov/qn-scale](https://github.com/paveldemyanov/qn-scale) — Protocol reverse engineering and documentation
- [oliexdev/openScale](https://github.com/oliexdev/openScale) — QNHandler.kt reference implementation
- [BHSPitMonkey/qn_scale_ble](https://github.com/BHSPitMonkey/qn_scale_ble) — Python QN-Scale BLE library
- [node-ble](https://github.com/chrvadala/node-ble) — Pure Node.js BLE library
