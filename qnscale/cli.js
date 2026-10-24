/**
 * QN-Scale Command Line Interface
 *
 * Provides CLI commands for:
 * - scan: Scan for nearby QN-Scale devices
 * - inspect: Enumerate GATT services & characteristics
 * - capture: Connect, record notifications, and save raw packets
 * - measure: Complete handshake and capture a live measurement
 * - history: Request and save historical readings
 * - export: Export database records to CSV
 *
 * @module qnscale/cli
 */

import { scanDevices, inspectDevice, QNScaleConnection } from './ble.js';
import { MeasurementStore, DEFAULT_DB_PATH } from './storage.js';
import { decodeMeasurement, MeasurementStatus } from './decoder.js';
import {
  UUID_DATA_SERVICE,
  UUID_NOTIFY_CHAR,
  UUID_WRITE_CHAR,
  UUID_ADVERTISED_SERVICE,
  computeChecksum,
  validateChecksum
} from './protocol.js';

// Default configuration
const DEFAULT_ADDRESS = process.env.QN_SCALE_ADDRESS || 'FB:01:00:18:50:08';
const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_UNIT = 'kg';
const DEFAULT_EXPORT_PATH = './data/export.csv';

/**
 * Format timestamped log line
 * @param {'INFO'|'WARN'|'ERROR'|'DEBUG'} level
 * @param {...any} args
 */
function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

/**
 * Format bytes as hex string with spaces
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
function hexDump(buf) {
  if (!buf) return '';
  return Buffer.from(buf).toString('hex').replace(/(..)/g, '$1 ').trim();
}

/**
 * Simple CLI argument parser
 * @param {string[]} args
 * @returns {{command: string, options: Record<string, string|boolean>}}
 */
function parseArgs(args) {
  const options = {
    address: DEFAULT_ADDRESS,
    timeout: DEFAULT_TIMEOUT_SEC,
    unit: DEFAULT_UNIT,
    db: DEFAULT_DB_PATH,
    output: DEFAULT_EXPORT_PATH,
    format: 'csv'
  };

  let command = 'help';
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--address' || arg === '-a') {
      options.address = args[++i];
    } else if (arg === '--timeout' || arg === '-t') {
      options.timeout = parseInt(args[++i], 10) || DEFAULT_TIMEOUT_SEC;
    } else if (arg === '--unit' || arg === '-u') {
      options.unit = args[++i];
    } else if (arg === '--db') {
      options.db = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i];
    } else if (arg === '--format' || arg === '-f') {
      options.format = args[++i];
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    command = positional[0].toLowerCase();
  }

  return { command, options };
}

/**
 * Print CLI help text
 */
function printHelp() {
  console.log(`
QN-Scale BLE Reader
===================
Standalone Node.js client for Healthify / QN-Scale Bluetooth Low Energy weighing scales.

Usage:
  node qn-scale.js <command> [options]

Commands:
  scan                    Scan for nearby QN-compatible BLE scales
  inspect                 Connect and report GATT services & characteristics
  capture                 Connect and log every notification packet for analysis
  measure                 Perform handshake and retrieve a live stable measurement
  history                 Request stored/historical measurements from scale memory
  export                  Export stored readings to CSV file

Options:
  -a, --address <MAC>     Bluetooth MAC address (default: FB:01:00:18:50:08)
                          Can also be set via QN_SCALE_ADDRESS environment variable
  -t, --timeout <sec>     Operation timeout in seconds (default: 60)
  -u, --unit <kg|lb>      Scale unit configuration (default: kg)
      --db <path>         Path to SQLite database (default: ./data/measurements.db)
  -o, --output <path>     Output file path for export (default: ./data/export.csv)
  -f, --format <format>   Export format (default: csv)
  -h, --help              Show this help message

Examples:
  node qn-scale.js scan
  node qn-scale.js inspect --address FB:01:00:18:50:08
  node qn-scale.js measure --address FB:01:00:18:50:08
  node qn-scale.js export --output ./my_readings.csv
`);
}

/**
 * Command: scan
 * Discovers nearby BLE devices and identifies QN scales.
 */
async function cmdScan(options) {
  log('INFO', 'Scanning for nearby Bluetooth devices...');
  log('INFO', `Timeout: ${options.timeout}s`);
  log('INFO', 'Tip: Step on your scale briefly to activate its BLE broadcast!');

  try {
    const devices = await scanDevices(options.timeout * 1000);
    console.log('\n--- Scan Results ---');
    if (devices.length === 0) {
      console.log('No QN-compatible devices discovered.');
      console.log('Troubleshooting tips:');
      console.log('  1. Step on the scale to wake it up (it sleeps after ~10s of inactivity).');
      console.log('  2. Ensure Bluetooth is enabled: `bluetoothctl power on`.');
      console.log('  3. Ensure BlueZ D-Bus permissions are configured.');
      return;
    }

    console.log(
      'MAC Address'.padEnd(20) +
      'Device Name'.padEnd(25) +
      'RSSI'.padEnd(10)
    );
    console.log('-'.repeat(55));
    for (const d of devices) {
      console.log(
        d.address.padEnd(20) +
        d.name.padEnd(25) +
        `${d.rssi} dBm`.padEnd(10)
      );
    }
    console.log(`\nFound ${devices.length} device(s).`);
  } catch (err) {
    log('ERROR', `Scan failed: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Command: inspect
 * Connects to device and enumerates GATT services and characteristics.
 */
async function cmdInspect(options) {
  log('INFO', `Connecting to ${options.address} to inspect GATT database...`);
  log('INFO', 'Tip: Step on the scale to wake it up before running this command.');

  try {
    const services = await inspectDevice(options.address);
    console.log('\n--- GATT Database for ' + options.address + ' ---');

    for (const s of services) {
      let roleHint = '';
      const sUuidLower = s.service.toLowerCase();
      if (sUuidLower.includes('fff0')) roleHint = ' [QN DATA SERVICE - PRIMARY]';
      else if (sUuidLower.includes('ffe0')) roleHint = ' [QN ADVERTISED / TYPE-1 SERVICE]';
      else if (sUuidLower.includes('180f')) roleHint = ' [BATTERY SERVICE]';
      else if (sUuidLower.includes('180a')) roleHint = ' [DEVICE INFO SERVICE]';

      console.log(`\nService: ${s.service}${roleHint}`);
      for (const c of s.characteristics) {
        let charHint = '';
        const cUuidLower = c.uuid.toLowerCase();
        if (cUuidLower.includes('fff1')) charHint = ' (Scale → Host Notify)';
        else if (cUuidLower.includes('fff2')) charHint = ' (Host → Scale Write, withResponse)';
        else if (cUuidLower.includes('ffe1')) charHint = ' (Type-1 Notify)';
        else if (cUuidLower.includes('ffe3')) charHint = ' (Type-1 Write)';
        else if (cUuidLower.includes('2a19')) charHint = ' (Battery Level)';

        console.log(`  Characteristic: ${c.uuid}${charHint}`);
        console.log(`    Properties:   ${c.properties.join(', ')}`);
      }
    }
    console.log('\nInspection complete.');
  } catch (err) {
    log('ERROR', `Inspect failed: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Command: capture
 * Connects, records notifications, and persists raw packets for reverse-engineering.
 */
async function cmdCapture(options) {
  log('INFO', `Connecting to ${options.address} in capture mode...`);
  log('INFO', 'All received notification packets will be logged and saved.');
  log('INFO', 'Press Ctrl+C to terminate capture.');

  const store = new MeasurementStore(options.db);
  await store.open();

  const conn = new QNScaleConnection({
    address: options.address,
    unit: options.unit
  });

  let packetCount = 0;

  conn.on('packet', async ({ timestamp, raw, hex }) => {
    packetCount++;
    const opcode = raw[0];
    const opcodeHex = `0x${opcode.toString(16).padStart(2, '0')}`;
    const chkValid = validateChecksum(raw);
    const chkStr = chkValid ? 'OK' : 'INVALID';

    console.log(`[#${packetCount}] ${timestamp} | Opcode: ${opcodeHex} | Len: ${raw.length} | Checksum: ${chkStr} | Hex: ${hex}`);

    // Persist raw packet to DB
    try {
      await store.saveMeasurement({
        timestamp,
        deviceAddress: options.address,
        measurementType: 'capture',
        rawPacketHex: hex,
        protocolVersion: raw.length > 2 ? raw[2] : null,
        decodeStatus: chkValid ? 'raw_capture' : 'checksum_error'
      });
    } catch (saveErr) {
      log('WARN', `Failed to save capture packet: ${saveErr.message}`);
    }
  });

  const cleanup = async () => {
    log('INFO', 'Stopping capture and disconnecting...');
    await conn.disconnect();
    await store.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await conn.connect();
    log('INFO', 'Scale connected. Listening for notification frames...');

    // Wait for timeout or interrupt
    await new Promise((resolve) => setTimeout(resolve, options.timeout * 1000));
    log('INFO', `Capture timeout reached (${options.timeout}s).`);
  } catch (err) {
    log('ERROR', `Capture error: ${err.message}`);
  } finally {
    await cleanup();
  }
}

/**
 * Command: measure
 * Performs documented QN handshake and captures a live stable measurement.
 */
async function cmdMeasure(options) {
  log('INFO', `Starting live measurement session with scale ${options.address}...`);
  log('INFO', `Unit preference: ${options.unit}`);
  log('INFO', 'Please step on the scale with bare feet and remain still until reading locks.');

  const store = new MeasurementStore(options.db);
  await store.open();

  const conn = new QNScaleConnection({
    address: options.address,
    unit: options.unit
  });

  let stableReceived = false;

  const cleanup = async () => {
    try {
      await conn.disconnect();
    } catch {}
    try {
      await store.close();
    } catch {}
  };

  process.on('SIGINT', async () => {
    log('INFO', 'Cancelled by user.');
    await cleanup();
    process.exit(0);
  });

  // Track live streaming measurements
  conn.on('measurement', (m) => {
    const statusLabel = m.stable ? 'STABLE' : 'weighing...';
    process.stdout.write(`\r  Live weight: ${m.weightKg.toFixed(2)} kg [${statusLabel}]    `);
  });

  // Handle stable reading
  conn.on('stable', async (m) => {
    stableReceived = true;
    console.log('\n');
    log('INFO', '*** STABLE READING LOCKED ***');

    const decoded = decodeMeasurement(m);

    // Save to database
    try {
      const res = await store.saveMeasurement({
        timestamp: decoded.timestamp.toISOString(),
        deviceAddress: options.address,
        measurementType: 'live',
        weightKg: decoded.weightKg,
        impedance1: decoded.impedance1,
        impedance2: decoded.impedance2,
        rawPacketHex: m.rawHex || (m.buffer ? m.buffer.toString('hex') : '100b...'),
        protocolVersion: conn._protocolVersion,
        parsedFields: decoded,
        decodeStatus: decoded.checksumValid ? 'ok' : 'checksum_error'
      });

      console.log('\n========================================');
      console.log('         MEASUREMENT RESULT             ');
      console.log('========================================');
      console.log(`  Weight:           ${decoded.weightKg.toFixed(2)} kg`);
      if (decoded.impedance1 || decoded.impedance2) {
        console.log(`  Impedance (Ch 1): ${decoded.impedance1} Ω`);
        console.log(`  Impedance (Ch 2): ${decoded.impedance2} Ω`);
      } else {
        console.log(`  Impedance:        Not available (step on bare-foot)`);
      }
      console.log(`  Stability:        Locked (${decoded.status})`);
      console.log(`  Checksum valid:   ${decoded.checksumValid}`);
      console.log(`  Saved to DB:      ${res.inserted ? 'Yes (ID: ' + res.id + ')' : 'Duplicate (skipped)'}`);
      console.log('========================================\n');
    } catch (saveErr) {
      log('ERROR', `Failed to save measurement: ${saveErr.message}`);
    }

    await cleanup();
    process.exit(0);
  });

  try {
    await conn.connect();

    // Timeout guard
    setTimeout(async () => {
      if (!stableReceived) {
        console.log('\n');
        log('WARN', `Measurement timeout reached (${options.timeout}s) without stable lock.`);
        await cleanup();
        process.exit(1);
      }
    }, options.timeout * 1000);
  } catch (err) {
    log('ERROR', `Measurement failed: ${err.message}`);
    await cleanup();
    process.exit(1);
  }
}

/**
 * Command: history
 * Requests stored historical measurements from scale memory.
 */
async function cmdHistory(options) {
  log('INFO', `Connecting to ${options.address} to query historical measurements...`);

  const store = new MeasurementStore(options.db);
  await store.open();

  const conn = new QNScaleConnection({
    address: options.address,
    unit: options.unit
  });

  let historyCount = 0;

  const cleanup = async () => {
    await conn.disconnect();
    await store.close();
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  conn.on('stored-measurement', async (stored) => {
    historyCount++;
    log('INFO', `Received historical reading #${historyCount}: ${stored.weightKg.toFixed(2)} kg at ${stored.timestamp || 'unknown'}`);

    try {
      await store.saveMeasurement({
        timestamp: stored.timestamp ? new Date(stored.timestamp).toISOString() : new Date().toISOString(),
        deviceAddress: options.address,
        measurementType: 'stored',
        weightKg: stored.weightKg,
        impedance1: stored.impedance1,
        impedance2: stored.impedance2,
        rawPacketHex: stored.rawHex || '',
        protocolVersion: conn._protocolVersion,
        parsedFields: stored,
        decodeStatus: 'ok'
      });
    } catch (e) {
      log('WARN', `Could not save history record: ${e.message}`);
    }
  });

  try {
    await conn.connect();
    await conn.requestHistory();

    log('INFO', 'Waiting for history responses (0x23)...');
    await new Promise((resolve) => setTimeout(resolve, 8000));

    console.log(`\nHistory query complete. Retrieved ${historyCount} historical record(s).`);
  } catch (err) {
    log('ERROR', `History retrieval failed: ${err.message}`);
  } finally {
    await cleanup();
  }
}

/**
 * Command: export
 * Exports measurements from SQLite to CSV.
 */
async function cmdExport(options) {
  log('INFO', `Exporting records from database: ${options.db}`);
  log('INFO', `Target file: ${options.output}`);

  const store = new MeasurementStore(options.db);
  try {
    await store.open();
    const count = await store.exportCSV(options.output);
    log('INFO', `Successfully exported ${count} measurement record(s) to ${options.output}`);
  } catch (err) {
    log('ERROR', `Export failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

/**
 * Main CLI entry point
 * @param {string[]} args
 */
export async function main(args) {
  const { command, options } = parseArgs(args);

  if (options.help || command === 'help') {
    printHelp();
    return;
  }

  switch (command) {
    case 'scan':
      await cmdScan(options);
      break;
    case 'inspect':
      await cmdInspect(options);
      break;
    case 'capture':
      await cmdCapture(options);
      break;
    case 'measure':
      await cmdMeasure(options);
      break;
    case 'history':
      await cmdHistory(options);
      break;
    case 'export':
      await cmdExport(options);
      break;
    default:
      console.error(`Unknown command: '${command}'`);
      printHelp();
      process.exitCode = 1;
      break;
  }
}
