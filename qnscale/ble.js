/**
 * @fileoverview BLE communication module for QN-Scale devices.
 *
 * Provides scanning, inspection, and full connection lifecycle management
 * using the `node-ble` library (D-Bus BlueZ bindings).
 *
 * Key protocol detail: writes to FFF2 (or FFE3 for Type 1 scales) MUST use
 * write-with-response ({type: 'request'}). Writes without response are
 * silently ignored by the scale firmware.
 *
 * @module qnscale/ble
 */

import { EventEmitter } from 'events';
import { createBluetooth } from 'node-ble';
import {
  SVC_FFF0, CHR_FFF1, CHR_FFF2,
  SVC_FFE0, CHR_FFE1, CHR_FFE3, CHR_FFE4,
  computeChecksum, validateChecksum,
  buildUnitConfig, buildTimePayload, buildTimeSync, buildHistoryRequest,
  buildServiceResponses, buildStableAck,
  parseGreeting, parseMeasurement, parseStoredMeasurement, parseSettingsAck,
  OP_GREETING, OP_MEASUREMENT, OP_SETTINGS_ACK, OP_SERVICE_FRAME,
  OP_STORED_MEASUREMENT
} from './protocol.js';

// ─── Logging helpers ────────────────────────────────────────────────────────

/**
 * Returns an ISO 8601 timestamp for log lines.
 * @returns {string}
 */
function ts() {
  return new Date().toISOString();
}

/**
 * Structured log with level and timestamp.
 * @param {'INFO'|'WARN'|'ERROR'|'DEBUG'} level
 * @param  {...any} args
 */
function log(level, ...args) {
  console.log(`[${ts()}] [${level}]`, ...args);
}

/**
 * Format a Buffer as a hex dump string.
 * @param {Buffer} buf
 * @returns {string}
 */
function hexDump(buf) {
  return Buffer.isBuffer(buf)
    ? buf.toString('hex').replace(/(..)/g, '$1 ').trim()
    : String(buf);
}

// ─── BLE Scanner ────────────────────────────────────────────────────────────

/**
 * Names or name-fragments that identify QN-compatible scales.
 * @type {string[]}
 */
const QN_NAME_FRAGMENTS = ['QN-Scale', 'QN_Scale', 'Grow', 'Health Scale'];

/**
 * Service UUIDs advertised by QN-compatible scales (lowercase, no dashes).
 * @type {string[]}
 */
const QN_SERVICE_UUIDS = [
  SVC_FFF0.replace(/-/g, '').toLowerCase(),
  SVC_FFE0.replace(/-/g, '').toLowerCase(),
  'fff0',
  'ffe0',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb'
];

/**
 * Scans for nearby BLE devices and returns discovered devices.
 * Filters for QN-compatible devices (name contains "QN-Scale" or advertises
 * FFE0/FFF0 services).
 *
 * @param {number} [timeoutMs=10000] - Scan duration in milliseconds.
 * @returns {Promise<Array<{address: string, name: string, rssi: number}>>}
 *   Array of discovered QN-compatible devices.
 */
export async function scanDevices(timeoutMs = 10000) {
  log('INFO', `Starting BLE scan for ${timeoutMs}ms …`);

  const { bluetooth, destroy } = createBluetooth();

  try {
    const adapter = await bluetooth.defaultAdapter();

    if (!(await adapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
        'Run `bluetoothctl power on` or check rfkill.'
      );
    }

    await adapter.startDiscovery();
    log('INFO', 'Discovery started – waiting for devices …');

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));

    await adapter.stopDiscovery().catch(() => {
      /* stop may fail if already stopped – ignore */
    });

    const deviceAddresses = await adapter.devices();
    log('INFO', `Discovery complete – ${deviceAddresses.length} raw device(s) seen`);

    /** @type {Array<{address: string, name: string, rssi: number}>} */
    const results = [];

    for (const addr of deviceAddresses) {
      try {
        const device = typeof adapter.getDevice === 'function'
          ? await adapter.getDevice(addr)
          : await adapter.waitDevice(addr);
        const name = await device.getName().catch(() => '');
        const rssi = await device.getRSSI().catch(() => -999);

        // Filter: name match OR service UUID match
        const nameMatch = QN_NAME_FRAGMENTS.some((frag) =>
          name.toLowerCase().includes(frag.toLowerCase())
        );

        let serviceMatch = false;
        try {
          const uuids = await device.getUUIDs();
          serviceMatch = uuids.some((u) =>
            QN_SERVICE_UUIDS.includes(u.replace(/-/g, '').toLowerCase())
          );
        } catch {
          /* getUUIDs may fail for unpaired devices */
        }

        if (nameMatch || serviceMatch) {
          results.push({ address: addr, name: name || '(unknown)', rssi });
        }
      } catch {
        /* Skip devices we can't interrogate */
      }
    }

    log('INFO', `Found ${results.length} QN-compatible device(s)`);
    return results;
  } catch (err) {
    if (
      err.message &&
      (err.message.includes('org.freedesktop.DBus.Error') ||
       err.message.includes('Operation not permitted'))
    ) {
      log('ERROR', 'Bluetooth permission denied.');
      log('ERROR', 'Ensure the D-Bus policy file is set up for your user.');
      log('ERROR', 'See: https://github.com/nicolo-ribaudo/node-ble#linux-permissions');
    }
    throw err;
  } finally {
    destroy();
  }
}

// ─── BLE Inspector ──────────────────────────────────────────────────────────

/**
 * Connects to a device and enumerates all GATT services and characteristics.
 * Reports properties (read, write, notify, indicate) for each characteristic.
 *
 * @param {string} address - Bluetooth MAC address (e.g. "FB:01:00:18:50:08").
 * @returns {Promise<Array<{service: string, characteristics: Array<{uuid: string, properties: string[]}>}>>}
 *   Array of service descriptors with nested characteristic info.
 */
export async function inspectDevice(address) {
  log('INFO', `Inspecting device ${address} …`);

  const { bluetooth, destroy } = createBluetooth();

  try {
    const adapter = await bluetooth.defaultAdapter();
    await adapter.startDiscovery();

    log('INFO', `Waiting for device ${address} …`);
    const device = await adapter.waitDevice(address);

    log('INFO', 'Connecting …');
    await device.connect();

    const gattServer = await device.gatt();

    const serviceUUIDs = await gattServer.services();
    log('INFO', `Found ${serviceUUIDs.length} service(s)`);

    /** @type {Array<{service: string, characteristics: Array<{uuid: string, properties: string[]}>}>} */
    const result = [];

    for (const svcUUID of serviceUUIDs) {
      const service = await gattServer.getPrimaryService(svcUUID);
      const charUUIDs = await service.characteristics();

      /** @type {Array<{uuid: string, properties: string[]}>} */
      const chars = [];

      for (const cUUID of charUUIDs) {
        const char = await service.getCharacteristic(cUUID);
        const flags = await char.getFlags();
        chars.push({ uuid: cUUID, properties: flags });
      }

      result.push({ service: svcUUID, characteristics: chars });
    }

    await device.disconnect().catch(() => {});
    await adapter.stopDiscovery().catch(() => {});

    return result;
  } finally {
    destroy();
  }
}

// ─── QN Scale Connection ────────────────────────────────────────────────────

/**
 * Unit string to protocol constant mapping.
 * @type {Record<string, string>}
 */
const UNIT_MAP = {
  kg: 'kg',
  lb: 'lb',
};

/**
 * Manages a full connection lifecycle with a QN-Scale device.
 *
 * Handles the documented handshake sequence:
 *
 * 1. Connect to device
 * 2. Get GATT server
 * 3. Find FFF0 service (or FFE0 for Type 1)
 * 4. Subscribe to notifications on FFF1 (or FFE1)
 * 5. Wait for 0x12 greeting
 * 6. Send 0x13 unit config (echoing protocol version)
 * 7. Send 0x02 time payload (NO checksum)
 * 8. Wait for 0x14 acknowledgment
 * 9. Send 0x20 time sync
 * 10. Receive measurement stream (0x10 frames)
 *
 * Key requirement: FFF2 MUST be written with response ({type: 'request'}).
 * Writes without response are silently ignored by the scale firmware.
 *
 * @extends EventEmitter
 *
 * @fires QNScaleConnection#packet      - Every notification packet
 * @fires QNScaleConnection#greeting    - 0x12 greeting received
 * @fires QNScaleConnection#measurement - 0x10 measurement frame decoded
 * @fires QNScaleConnection#stable      - Stable measurement (byte 5 = 0x01)
 * @fires QNScaleConnection#settings-ack - 0x14 settings acknowledgment
 * @fires QNScaleConnection#stored-measurement - 0x23 stored measurement
 * @fires QNScaleConnection#error       - Error during communication
 * @fires QNScaleConnection#disconnected - BLE disconnection
 */
export class QNScaleConnection extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.address - Bluetooth MAC address.
   * @param {string} [options.unit='kg'] - Weight unit: 'kg' or 'lb'.
   */
  constructor({ address, unit = 'kg', userProfile = null }) {
    super();

    /** @type {string} BLE MAC address of the scale */
    this.address = address;

    /** @type {string} Desired weight unit */
    this.unit = UNIT_MAP[unit] || 'kg';

    /** @type {{height: number, age: number, gender: number}} User profile for scale setup */
    this.userProfile = userProfile || { height: 175, age: 28, gender: 0 };

    /** @private @type {ReturnType<typeof createBluetooth>|null} */
    this._bt = null;

    /** @private @type {object|null} node-ble adapter */
    this._adapter = null;

    /** @private @type {object|null} node-ble Device */
    this._device = null;

    /** @private @type {object|null} Write characteristic (FFF2 or FFE3) */
    this._writeChar = null;

    /** @private @type {object|null} Notify characteristic (FFF1 or FFE1) */
    this._notifyChar = null;

    /** @private @type {boolean} Whether we're connected */
    this._connected = false;

    /** @private @type {number|null} Protocol version echoed from the greeting */
    this._protocolVersion = null;

    /** @private @type {'type2'|'type1'} Scale type based on available services */
    this._scaleType = 'type2';

    /** @private @type {Promise<void>} Serialized write queue */
    this._writeQueue = Promise.resolve();

    /** @private @type {number} Timestamp of last greeting response */
    this._lastGreetingReply = 0;

    /** @private @type {boolean} Whether handshake completed */
    this._handshakeComplete = false;
  }

  /**
   * Serialized GATT write to characteristic with response.
   * Prevents DBusError 'In Progress' collisions.
   * @param {Buffer} buffer
   * @param {string} [label='']
   * @returns {Promise<void>}
   */
  async safeWrite(buffer, label = '') {
    if (!this._writeChar) return;
    this._writeQueue = this._writeQueue.then(async () => {
      if (!this._connected) return;
      if (label) log('DEBUG', `TX ${label}: ${hexDump(buffer)}`);
      await this._writeChar.writeValue(buffer, { type: 'request' });
      await new Promise((r) => setTimeout(r, 60));
    }).catch((err) => {
      log('WARN', `Write ${label} failed: ${err.message}`);
    });
    return this._writeQueue;
  }

  /**
   * Returns the write characteristic (FFF2 for Type 2, FFE3 for Type 1).
   * Only valid after connect().
   * @returns {object|null} node-ble GattCharacteristic
   */
  getWriteCharacteristic() {
    return this._writeChar;
  }

  /**
   * Returns the notify characteristic (FFF1 for Type 2, FFE1 for Type 1).
   * Only valid after connect().
   * @returns {object|null} node-ble GattCharacteristic
   */
  getNotifyCharacteristic() {
    return this._notifyChar;
  }

  /**
   * Connect to the scale, discover services, subscribe to notifications,
   * and perform the full handshake sequence.
   *
   * Resolves once the handshake is complete and the measurement stream is
   * active. The caller should listen for 'measurement' and 'stable' events.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    log('INFO', `Connecting to QN-Scale at ${this.address} …`);
    log('INFO', `Unit: ${this.unit}`);

    this._bt = createBluetooth();
    const { bluetooth, destroy } = this._bt;

    try {
      this._adapter = await bluetooth.defaultAdapter();
      await this._adapter.startDiscovery();

      log('INFO', `Waiting for device ${this.address} …`);
      log('INFO', 'Tip: step on the scale to wake it up if it is asleep.');
      this._device = await this._adapter.waitDevice(this.address);

      log('INFO', 'Device found – connecting …');
      await this._device.connect();
      this._connected = true;

      log('INFO', 'Connected – discovering GATT services …');
      const gattServer = await this._device.gatt();

      // ── Resolve service and characteristic UUIDs ──
      const { service, notifyChar, writeChar, scaleType } =
        await this._resolveServiceChars(gattServer);

      this._scaleType = scaleType;
      this._notifyChar = notifyChar;
      this._writeChar = writeChar;

      log('INFO', `Scale type: ${scaleType}`);
      log('INFO', `Notify characteristic resolved`);
      log('INFO', `Write characteristic resolved`);

      // ── Subscribe to notifications ──
      await notifyChar.startNotifications();
      log('INFO', 'Subscribed to notifications');

      notifyChar.on('valuechanged', (buffer) => {
        this._onNotification(buffer);
      });

      // ── Perform handshake ──
      await this._handshake();

      log('INFO', 'Handshake complete – listening for measurements …');
    } catch (err) {
      log('ERROR', `Connection failed: ${err.message}`);
      this.emit('error', err);
      await this.disconnect();
      throw err;
    }
  }

  /**
   * Disconnect from the scale and release all BLE resources.
   * @returns {Promise<void>}
   */
  async disconnect() {
    log('INFO', 'Disconnecting …');

    try {
      if (this._notifyChar) {
        await this._notifyChar.stopNotifications().catch(() => {});
      }
      if (this._device && this._connected) {
        await this._device.disconnect().catch(() => {});
      }
      if (this._adapter) {
        await this._adapter.stopDiscovery().catch(() => {});
      }
    } catch {
      /* best-effort cleanup */
    } finally {
      this._connected = false;
      if (this._bt) {
        this._bt.destroy();
        this._bt = null;
      }
      this.emit('disconnected');
      log('INFO', 'Disconnected');
    }
  }

  /**
   * Request stored (historical) measurements from the scale.
   * The scale responds with 0x23 frames for each stored measurement.
   *
   * @returns {Promise<void>}
   */
  /**
   * Request stored (historical) measurements from the scale.
   * The scale responds with 0x23 frames for each stored measurement.
   *
   * @returns {Promise<void>}
   */
  async requestHistory() {
    if (!this._writeChar) {
      throw new Error('Not connected – call connect() first');
    }

    log('INFO', 'Requesting stored measurements (history) …');
    const payload = buildHistoryRequest(this._protocolVersion || 0xFF);
    await this.safeWrite(payload, 'History Request 0x22');
    log('INFO', 'History request sent – waiting for 0x23 frames …');
  }

  // ── Private methods ─────────────────────────────────────────────────────

  /**
   * Attempt to discover FFF0 (Type 2) or FFE0 (Type 1) service and
   * resolve the corresponding notify and write characteristics.
   *
   * @private
   * @param {object} gattServer - node-ble GattServer instance.
   * @returns {Promise<{service: object, notifyChar: object, writeChar: object, scaleType: 'type2'|'type1'}>}
   */
  async _resolveServiceChars(gattServer) {
    // Try Type 2 first (FFF0 service)
    try {
      const service = await gattServer.getPrimaryService(SVC_FFF0);
      const notifyChar = await service.getCharacteristic(CHR_FFF1);
      const writeChar = await service.getCharacteristic(CHR_FFF2);
      return { service, notifyChar, writeChar, scaleType: 'type2' };
    } catch {
      log('INFO', 'FFF0 service not found – trying FFE0 (Type 1) …');
    }

    // Fall back to Type 1 (FFE0 service)
    try {
      const service = await gattServer.getPrimaryService(SVC_FFE0);
      const notifyChar = await service.getCharacteristic(CHR_FFE1);
      // Type 1 uses FFE3 for writes and FFE4 for indication
      const writeChar = await service.getCharacteristic(CHR_FFE3);
      return { service, notifyChar, writeChar, scaleType: 'type1' };
    } catch {
      throw new Error(
        `Device ${this.address} does not expose FFF0 or FFE0 GATT service. ` +
        'Is this a QN-compatible scale?'
      );
    }
  }

  /**
   * Perform the documented handshake sequence.
   * Awaits confirmation that the scale is initialized and streaming.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _handshake() {
    log('INFO', 'Performing protocol handshake with scale …');
    if (!this._handshakeComplete) {
      await this._waitForEvent('handshake-complete', 30000);
    }
    log('INFO', 'Handshake confirmed active!');
  }

  /**
   * Wait for a specific event with a timeout.
   *
   * @private
   * @param {string} eventName - Event to wait for.
   * @param {number} timeoutMs - Timeout in milliseconds.
   * @returns {Promise<any>} The event payload.
   */
  _waitForEvent(eventName, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(eventName, handler);
        reject(
          new Error(
            `Timeout waiting for '${eventName}' after ${timeoutMs}ms. ` +
            'Is the scale awake? Step on it to activate.'
          )
        );
      }, timeoutMs);

      /** @param {any} data */
      const handler = (data) => {
        clearTimeout(timeout);
        resolve(data);
      };

      this.once(eventName, handler);
    });
  }

  /**
   * Handle an incoming BLE notification packet.
   * Dispatches to the appropriate parser based on the opcode byte.
   *
   * @private
   * @param {Buffer} buffer - Raw notification data.
   */
  async _onNotification(buffer) {
    const now = new Date().toISOString();
    const hex = buffer.toString('hex');

    log('DEBUG', `RX [${buffer.length} bytes]: ${hexDump(buffer)}`);

    // Emit raw packet for every notification
    this.emit('packet', { timestamp: now, raw: buffer, hex });

    if (buffer.length === 0) return;

    const opcode = buffer[0];

    switch (opcode) {
      case OP_GREETING: {
        // 0x12 – Greeting from scale
        try {
          const greeting = parseGreeting(buffer);
          this._protocolVersion = greeting.protocolVersion;
          this.emit('greeting', greeting);

          // Reply with unit config & current time (throttled to at most once per 800ms)
          const nowMs = Date.now();
          if (!this._handshakeComplete && (nowMs - this._lastGreetingReply > 800)) {
            this._lastGreetingReply = nowMs;
            log('INFO', `Scale greeting (protocol v0x${this._protocolVersion.toString(16)}). Sending unit config & clock...`);
            const unitConfig = buildUnitConfig(this._protocolVersion, this.unit, this.userProfile);
            await this.safeWrite(unitConfig, 'Unit Config 0x13');

            const timePayload = buildTimePayload();
            await this.safeWrite(timePayload, 'Time 0x02');
          }
        } catch (err) {
          log('WARN', `Failed to parse greeting: ${err.message}`);
          this.emit('error', err);
        }
        break;
      }

      case OP_SETTINGS_ACK: {
        // 0x14 – Settings acknowledgment
        try {
          const ack = parseSettingsAck(buffer);
          log('INFO', 'Settings ACK received (0x14) – sending time sync (0x20)...');
          this.emit('settings-ack', ack);

          const timeSync = buildTimeSync(this._protocolVersion || 0xFF);
          await this.safeWrite(timeSync, 'Time Sync 0x20');

          this._handshakeComplete = true;
          this.emit('handshake-complete');
        } catch (err) {
          log('WARN', `Failed to parse settings ACK: ${err.message}`);
          this.emit('error', err);
        }
        break;
      }

      case OP_SERVICE_FRAME: {
        // 0x21 - Service frame: send the two 0xA0 responses per QNHandler.kt
        log('DEBUG', `Service frame (0x21): ${hexDump(buffer)}. Sending 0xA0 responses...`);
        const [msg1, msg2] = buildServiceResponses();
        await this.safeWrite(msg1, 'Response 1 (0xA0)');
        await this.safeWrite(msg2, 'Response 2 (0xA0)');
        break;
      }

      case OP_MEASUREMENT: {
        // 0x10 – Live measurement frame
        try {
          if (!this._handshakeComplete) {
            this._handshakeComplete = true;
            this.emit('handshake-complete');
          }
          const measurement = parseMeasurement(buffer);
          measurement.rawHex = hex;
          const stableStr = measurement.stable ? ' [STABLE]' : '';
          log(
            'INFO',
            `Measurement: ${measurement.weightKg.toFixed(2)} kg` +
            `${measurement.impedance1 ? ` imp1=${measurement.impedance1}Ω` : ''}` +
            `${measurement.impedance2 ? ` imp2=${measurement.impedance2}Ω` : ''}` +
            stableStr
          );
          this.emit('measurement', measurement);

          if (measurement.stable) {
            // Acknowledge stable reading with 0x1F per QNHandler.kt
            const ack = buildStableAck(this._protocolVersion || 0xFF);
            await this.safeWrite(ack, 'Stable Ack 0x1F');
            this.emit('stable', measurement);
          }
        } catch (err) {
          log('WARN', `Failed to parse measurement: ${err.message}`);
          this.emit('error', err);
        }
        break;
      }

      case OP_STORED_MEASUREMENT: {
        // 0x23 – Stored (historical) measurement
        try {
          const stored = parseStoredMeasurement(buffer);
          stored.rawHex = hex;
          log(
            'INFO',
            `Stored measurement: ${stored.weightKg.toFixed(2)} kg` +
            ` at ${stored.timestamp || '(no timestamp)'}`
          );
          this.emit('stored-measurement', stored);
        } catch (err) {
          log('WARN', `Failed to parse stored measurement: ${err.message}`);
          this.emit('error', err);
        }
        break;
      }

      default:
        log('DEBUG', `Unknown opcode 0x${opcode.toString(16).padStart(2, '0')}: ${hexDump(buffer)}`);
        break;
    }
  }
}
