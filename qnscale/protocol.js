/**
 * QN-Scale BLE Protocol Implementation
 *
 * Implements the binary protocol used by Healthify / QN-Scale weighing scales
 * over Bluetooth Low Energy. Covers frame building, parsing, and validation.
 *
 * References:
 *   - paveldemyanov/qn-scale PROTOCOL.md
 *   - oliexdev/openScale QNHandler.kt
 *
 * @module qnscale/protocol
 */

// ─── BLE Service & Characteristic UUIDs ──────────────────────────────────────

/**
 * Advertised BLE service UUID (used for scanning/filtering).
 * The scale advertises FFE0 but the actual data exchange happens on FFF0.
 * @source PROTOCOL.md line 12
 */
export const UUID_ADVERTISED_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';

/**
 * Primary data service UUID where measurement exchange occurs.
 * @source PROTOCOL.md line 14
 */
export const UUID_DATA_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';

/**
 * Notification characteristic UUID (scale → client).
 * Subscribe to this to receive measurement frames.
 * @source PROTOCOL.md line 15
 */
export const UUID_NOTIFY_CHAR = '0000fff1-0000-1000-8000-00805f9b34fb';

/**
 * Write characteristic UUID (client → scale).
 * All commands MUST use writeWithResponse (write-with-response / GATT Write Request).
 * @source PROTOCOL.md line 16
 */
export const UUID_WRITE_CHAR = '0000fff2-0000-1000-8000-00805f9b34fb';

/**
 * Standard BLE Battery Service UUID.
 * @source PROTOCOL.md line 18
 */
export const UUID_BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';

/**
 * Standard BLE Battery Level characteristic UUID.
 * @source PROTOCOL.md line 18
 */
export const UUID_BATTERY_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// ─── Type 1 (alternate) layout UUIDs ─────────────────────────────────────────

/**
 * Type 1 data service UUID.
 * Some older scale models use FFE0 as the data service instead of FFF0.
 * @source QNHandler.kt line 45
 */
export const UUID_TYPE1_DATA_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';

/**
 * Type 1 notify characteristic (scale → client).
 * @source QNHandler.kt line 46
 */
export const UUID_TYPE1_NOTIFY_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';

/**
 * Type 1 additional notify characteristic.
 * @source QNHandler.kt line 47
 */
export const UUID_TYPE1_NOTIFY_CHAR2 = '0000ffe3-0000-1000-8000-00805f9b34fb';

/**
 * Type 1 write characteristic (client → scale).
 * @source QNHandler.kt line 48
 */
export const UUID_TYPE1_WRITE_CHAR = '0000ffe4-0000-1000-8000-00805f9b34fb';

// ─── Backward compatibility aliases ──────────────────────────────────────────
export const SVC_FFF0 = UUID_DATA_SERVICE;
export const CHR_FFF1 = UUID_NOTIFY_CHAR;
export const CHR_FFF2 = UUID_WRITE_CHAR;
export const SVC_FFE0 = UUID_ADVERTISED_SERVICE;
export const CHR_FFE1 = UUID_TYPE1_NOTIFY_CHAR;
export const CHR_FFE3 = UUID_TYPE1_NOTIFY_CHAR2;
export const CHR_FFE4 = UUID_TYPE1_WRITE_CHAR;

// ─── Protocol Opcodes ────────────────────────────────────────────────────────

/**
 * Opcode: Scale greeting (scale → client).
 * Contains MAC address, protocol version, and weight-scale-factor hint.
 * @source PROTOCOL.md line 25
 */
export const OP_GREETING = 0x12;

/**
 * Opcode: Live measurement (scale → client).
 * Streamed ~2× per second after handshake completes.
 * @source PROTOCOL.md line 30
 */
export const OP_MEASUREMENT = 0x10;

/**
 * Opcode: Settings acknowledged (scale → client).
 * Sent after the scale accepts the unit configuration.
 * @source PROTOCOL.md line 35
 */
export const OP_SETTINGS_ACK = 0x14;

/**
 * Opcode: Service frame (scale → client).
 * Can be safely ignored for basic operation.
 * @source PROTOCOL.md line 36
 */
export const OP_SERVICE = 0x21;
export const OP_SERVICE_FRAME = OP_SERVICE;

/**
 * Opcode: Stored measurement (scale → client).
 * Contains a previously recorded measurement with timestamp.
 * @source PROTOCOL.md line 37
 */
export const OP_STORED_MEASUREMENT = 0x23;

/**
 * Opcode: Unit configuration (client → scale).
 * Sends display unit preference to the scale.
 * @source PROTOCOL.md line 42
 */
export const OP_UNIT_CONFIG = 0x13;

/**
 * Opcode: Current time (client → scale).
 * Sets the scale's internal clock. This frame has NO checksum.
 * @source PROTOCOL.md line 45
 */
export const OP_TIME = 0x02;

/**
 * Opcode: Time sync (client → scale).
 * Synchronises the scale's clock with a checksummed frame.
 * @source PROTOCOL.md line 48
 */
export const OP_TIME_SYNC = 0x20;

/**
 * Opcode: History request (client → scale).
 * Requests stored measurements from the scale's memory.
 * @source PROTOCOL.md line 51
 */
export const OP_HISTORY_REQUEST = 0x22;

// ─── Unit Codes ──────────────────────────────────────────────────────────────

/**
 * Unit byte value for kilograms.
 * @source PROTOCOL.md line 43
 */
export const UNIT_KG = 0x01;

/**
 * Unit byte value for pounds.
 * @source PROTOCOL.md line 43
 */
export const UNIT_LB = 0x02;

// ─── Epoch Offset ────────────────────────────────────────────────────────────

/**
 * QN epoch offset: seconds between Unix epoch (1970-01-01T00:00:00Z) and
 * QN epoch (2000-01-01T00:00:00 local).
 *
 * The scale stores timestamps as seconds since 2000-01-01.
 * To convert: qnTimestamp = Math.floor(Date.now() / 1000) - QN_EPOCH_OFFSET
 *
 * @source PROTOCOL.md line 46
 */
export const QN_EPOCH_OFFSET = 946702800;

// ─── Checksum ────────────────────────────────────────────────────────────────

/**
 * Compute the QN protocol checksum for a frame.
 * The checksum is the sum of all bytes modulo 256.
 *
 * @param {Buffer} buffer - All frame bytes *preceding* the checksum position
 * @returns {number} Checksum value (0–255)
 * @source PROTOCOL.md line 22
 */
export function computeChecksum(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i];
  }
  return sum & 0xff;
}

/**
 * Validate the checksum of a complete frame.
 * The last byte of the buffer must equal the sum of all preceding bytes mod 256.
 *
 * Note: Time frame (opcode 0x02) has NO checksum — do not validate those.
 *
 * @param {Buffer} buffer - Complete frame including trailing checksum byte
 * @returns {boolean} True if the checksum is valid
 * @source PROTOCOL.md line 22
 */
export function validateChecksum(buffer) {
  if (buffer.length < 2) {
    return false;
  }
  const payload = buffer.subarray(0, buffer.length - 1);
  const expected = buffer[buffer.length - 1];
  return computeChecksum(payload) === expected;
}

// ─── Command Builders (Client → Scale) ──────────────────────────────────────

/**
 * Build the unit configuration command (opcode 0x13).
 *
 * Frame layout:
 *   [0x13, 0x09, protocolVersion, unitByte, 0x10, 0x00, 0x00, 0x00, checksum]
 *
 * @param {number} protocolVersion - Protocol version from the scale's greeting
 * @param {number} [unit=UNIT_KG] - Display unit: UNIT_KG (0x01) or UNIT_LB (0x02)
 * @returns {Buffer} 9-byte command buffer ready to write
 * @source PROTOCOL.md line 42
 */
export function buildUnitConfig(protocolVersion = 0x15, unit = UNIT_KG, userProfile = {}) {
  // Support flexible argument passing: (version, unit) or (unit, version)
  if (typeof protocolVersion === 'string') {
    const tmp = protocolVersion;
    protocolVersion = typeof unit === 'number' ? unit : 0x15;
    unit = tmp === 'lb' ? UNIT_LB : UNIT_KG;
  } else if (typeof unit === 'string') {
    unit = unit === 'lb' ? UNIT_LB : UNIT_KG;
  }
  if (typeof protocolVersion !== 'number') {
    protocolVersion = 0x15;
  }

  // Height (cm, clamped 60..220), age (years, clamped 6..80), gender (0=male, 1=female)
  // For protocolVersion === 0xFF (Healthify / Fit Plus family), the scale requires valid non-zero
  // profile bytes (height, age) to accept the unit config.
  // @source QNHandler.kt lines 520-530
  const is0xFF = protocolVersion === 0xFF;
  const height = userProfile.height != null ? Math.min(220, Math.max(60, userProfile.height)) : (is0xFF ? 175 : 0x00);
  const age = userProfile.age != null ? Math.min(80, Math.max(6, userProfile.age)) : (is0xFF ? 28 : 0x00);
  const gender = userProfile.gender != null ? (userProfile.gender === 'female' || userProfile.gender === 1 ? 0x01 : 0x00) : 0x00;

  const buf = Buffer.alloc(9);
  buf[0] = OP_UNIT_CONFIG; // 0x13
  buf[1] = 0x09;           // length
  buf[2] = protocolVersion;
  buf[3] = unit;
  buf[4] = 0x10;
  buf[5] = height;
  buf[6] = age;
  buf[7] = gender;
  buf[8] = computeChecksum(buf.subarray(0, 8));
  return buf;
}

/**
 * Build the current-time payload (opcode 0x02).
 *
 * Frame layout:
 *   [0x02, t0, t1, t2, t3]
 *
 * This frame has NO checksum — it is the only exception to the standard
 * frame format.
 *
 * The timestamp is seconds since 2000-01-01 (QN epoch), encoded as
 * 4 bytes little-endian.
 *
 * @returns {Buffer} 5-byte command buffer ready to write (no checksum)
 * @source PROTOCOL.md line 45
 */
export function buildTimePayload() {
  const nowSec = Math.floor(Date.now() / 1000);
  const qnTime = nowSec - QN_EPOCH_OFFSET;

  const buf = Buffer.alloc(5);
  buf[0] = OP_TIME; // 0x02
  buf.writeUInt32LE(qnTime, 1);
  return buf;
}

/**
 * Build the time-sync command (opcode 0x20).
 *
 * Frame layout:
 *   [0x20, 0x08, protocolVersion, t0, t1, t2, t3, checksum]
 *
 * The timestamp is seconds since 2000-01-01 (QN epoch), encoded as
 * 4 bytes little-endian.
 *
 * @param {number} protocolVersion - Protocol version from the scale's greeting
 * @returns {Buffer} 8-byte command buffer ready to write
 * @source PROTOCOL.md line 48
 */
export function buildTimeSync(protocolVersion = 0x15) {
  const nowSec = Math.floor(Date.now() / 1000);
  const qnTime = nowSec - QN_EPOCH_OFFSET;

  const buf = Buffer.alloc(8);
  buf[0] = OP_TIME_SYNC; // 0x20
  buf[1] = 0x08;
  buf[2] = protocolVersion;
  buf.writeUInt32LE(qnTime, 3);
  buf[7] = computeChecksum(buf.subarray(0, 7));
  return buf;
}

/**
 * Build the history request command (opcode 0x22).
 *
 * Frame layout:
 *   [0x22, 0x06, protocolVersion, 0x00, 0x03, checksum]
 *
 * @param {number} protocolVersion - Protocol version from the scale's greeting
 * @returns {Buffer} 6-byte command buffer ready to write
 * @source PROTOCOL.md line 51
 */
export function buildHistoryRequest(protocolVersion = 0x15) {
  const buf = Buffer.alloc(6);
  buf[0] = OP_HISTORY_REQUEST; // 0x22
  buf[1] = 0x06;
  buf[2] = protocolVersion;
  buf[3] = 0x00;
  buf[4] = 0x03;
  buf[5] = computeChecksum(buf.subarray(0, 5));
  return buf;
}

/**
 * Build the two 0xA0 response frames required after receiving the 0x21 service frame.
 * @source QNHandler.kt lines 252-273
 * @returns {[Buffer, Buffer]} Array of two 13-byte response buffers
 */
export function buildServiceResponses() {
  const msg1 = Buffer.from([0xa0, 0x0d, 0x04, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  msg1[12] = computeChecksum(msg1.subarray(0, 12));

  const msg2 = Buffer.from([0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x00]);
  msg2[12] = computeChecksum(msg2.subarray(0, 12));

  return [msg1, msg2];
}

/**
 * Build 0x1F stable measurement acknowledgement frame.
 * @source QNHandler.kt lines 352-353
 * @param {number} [protocolVersion=0xFF]
 * @returns {Buffer} 5-byte ack buffer
 */
export function buildStableAck(protocolVersion = 0xFF) {
  const ack = Buffer.from([0x1f, 0x05, protocolVersion, 0x10, 0x00]);
  ack[4] = computeChecksum(ack.subarray(0, 4));
  return ack;
}

// ─── Frame Parsers (Scale → Client) ─────────────────────────────────────────

/**
 * @typedef {Object} GreetingResult
 * @property {string} mac - MAC address in "XX:XX:XX:XX:XX:XX" format (bytes 3-8 reversed)
 * @property {number} protocolVersion - Protocol version byte (byte 2)
 * @property {number} weightScaleHint - Raw scale-factor hint byte (byte 10).
 *   Value 1 → divide weight raw value by 100; other values → divide by 10.
 *   Exception: CS20C1 reports 0x05 but still uses /100.
 */

/**
 * Parse a greeting frame (opcode 0x12).
 *
 * The greeting is the first frame the scale sends after BLE connection.
 * It contains the scale's MAC address (bytes 3–8, reversed byte order),
 * the protocol version (byte 2), and a weight-scale-factor hint (byte 10).
 *
 * @param {Buffer} buffer - Complete 0x12 frame including checksum
 * @returns {GreetingResult} Parsed greeting data
 * @throws {Error} If buffer is too short or opcode doesn't match
 * @source PROTOCOL.md line 25
 */
export function parseGreeting(buffer) {
  if (buffer.length < 11) {
    throw new Error(`Greeting frame too short: expected ≥11 bytes, got ${buffer.length}`);
  }
  if (buffer[0] !== OP_GREETING) {
    throw new Error(`Expected greeting opcode 0x12, got 0x${buffer[0].toString(16)}`);
  }

  const protocolVersion = buffer[2];

  // MAC address: bytes 3–8 in reversed order
  // @source PROTOCOL.md line 26
  const macBytes = [];
  for (let i = 8; i >= 3; i--) {
    macBytes.push(buffer[i].toString(16).padStart(2, '0').toUpperCase());
  }
  const mac = macBytes.join(':');

  // Weight scale factor hint: byte 10
  // 1 → /100, else → /10 (but CS20C1 reports 0x05 yet uses /100)
  // @source PROTOCOL.md line 28
  const weightScaleHint = buffer.length > 10 ? buffer[10] : 0;

  return { mac, protocolVersion, weightScaleHint };
}

/**
 * @typedef {Object} MeasurementResult
 * @property {number} weightRaw - Raw weight value from bytes 3-4 (big-endian)
 * @property {number} weightKg - Weight in kg (weightRaw / 100)
 * @property {boolean} stable - True if the measurement has stabilised (byte 5 === 0x01)
 * @property {number} impedance1 - First impedance reading in ohms (bytes 6-7, big-endian)
 * @property {number} impedance2 - Second impedance reading in ohms (bytes 8-9, big-endian)
 * @property {boolean} checksumValid - Whether the frame checksum verified correctly
 */

/**
 * Parse a live measurement frame (opcode 0x10).
 *
 * Frame layout:
 *   [0x10, length, protoVer, weightHi, weightLo, stability,
 *    imp1Hi, imp1Lo, imp2Hi, imp2Lo, ..., checksum]
 *
 * Weight is big-endian 16-bit in hundredths of kg.
 * Stability: 0x01 = stable, 0x00 = unstable.
 * Impedance values are big-endian 16-bit, direct ohm readings.
 *
 * @param {Buffer} buffer - Complete 0x10 frame including checksum
 * @returns {MeasurementResult} Parsed measurement data
 * @throws {Error} If buffer is too short or opcode doesn't match
 * @source PROTOCOL.md line 30
 */
export function parseMeasurement(buffer) {
  if (buffer.length < 10) {
    throw new Error(`Measurement frame too short: expected ≥10 bytes, got ${buffer.length}`);
  }
  if (buffer[0] !== OP_MEASUREMENT) {
    throw new Error(`Expected measurement opcode 0x10, got 0x${buffer[0].toString(16)}`);
  }

  // Weight: bytes 3-4, big-endian, value in hundredths of kg
  // @source PROTOCOL.md line 31
  const weightRaw = buffer.readUInt16BE(3);
  const weightKg = weightRaw / 100;

  // Stability: byte 5 — 0x01 = stable, 0x00 = unstable
  // @source PROTOCOL.md line 32
  const stable = buffer[5] === 0x01;

  // Impedance 1: bytes 6-7, big-endian, ohms
  // @source PROTOCOL.md line 33
  const impedance1 = buffer.readUInt16BE(6);

  // Impedance 2: bytes 8-9, big-endian, ohms
  // @source PROTOCOL.md line 33
  const impedance2 = buffer.readUInt16BE(8);

  const checksumValid = validateChecksum(buffer);

  return { weightRaw, weightKg, stable, impedance1, impedance2, checksumValid };
}

/**
 * @typedef {Object} StoredMeasurementResult
 * @property {number} weightRaw - Raw weight value (bytes 10-11, big-endian, /100)
 * @property {number} weightKg - Weight in kg (weightRaw / 100)
 * @property {number} impedance1 - First impedance reading (bytes 13-14, little-endian)
 * @property {number} impedance2 - Second impedance reading (bytes 15-16, little-endian)
 * @property {number} timestampQn - Timestamp in QN epoch seconds (bytes 6-9, little-endian)
 * @property {boolean} checksumValid - Whether the frame checksum verified correctly
 */

/**
 * Parse a stored measurement frame (opcode 0x23).
 *
 * Stored measurements use a different byte layout from live measurements:
 *   - Weight: bytes 10-11, big-endian, in hundredths of kg (/100)
 *   - Impedance: bytes 13-14 and 15-16, little-endian (unlike live which is BE)
 *   - Timestamp: bytes 6-9, little-endian, seconds since QN epoch (2000-01-01)
 *
 * @param {Buffer} buffer - Complete 0x23 frame including checksum
 * @returns {StoredMeasurementResult} Parsed stored measurement data
 * @throws {Error} If buffer is too short or opcode doesn't match
 * @source PROTOCOL.md line 37
 */
export function parseStoredMeasurement(buffer) {
  if (buffer.length < 17) {
    throw new Error(`Stored measurement frame too short: expected ≥17 bytes, got ${buffer.length}`);
  }
  if (buffer[0] !== OP_STORED_MEASUREMENT) {
    throw new Error(`Expected stored measurement opcode 0x23, got 0x${buffer[0].toString(16)}`);
  }

  // Timestamp: bytes 6-9, little-endian, QN epoch seconds
  // @source PROTOCOL.md line 39
  const timestampQn = buffer.readUInt32LE(6);

  // Weight: bytes 10-11, big-endian, hundredths of kg
  // @source PROTOCOL.md line 38
  const weightRaw = buffer.readUInt16BE(10);
  const weightKg = weightRaw / 100;

  // Impedance 1: bytes 13-14, little-endian
  // @source PROTOCOL.md line 40
  const impedance1 = buffer.readUInt16LE(13);

  // Impedance 2: bytes 15-16, little-endian
  // @source PROTOCOL.md line 40
  const impedance2 = buffer.readUInt16LE(15);

  const checksumValid = validateChecksum(buffer);

  return { weightRaw, weightKg, impedance1, impedance2, timestampQn, checksumValid };
}

/**
 * @typedef {Object} SettingsAckResult
 * @property {boolean} accepted - Always true when a valid 0x14 frame is received
 * @property {boolean} checksumValid - Whether the frame checksum verified correctly
 */

/**
 * Parse a settings-acknowledged frame (opcode 0x14).
 *
 * This is sent by the scale after it accepts a unit configuration command.
 * The frame confirms the scale is ready to proceed with the handshake.
 *
 * @param {Buffer} buffer - Complete 0x14 frame including checksum
 * @returns {SettingsAckResult} Parsed acknowledgement
 * @throws {Error} If opcode doesn't match
 * @source PROTOCOL.md line 35
 */
export function parseSettingsAck(buffer) {
  if (buffer.length < 1) {
    throw new Error('Settings ACK frame is empty');
  }
  if (buffer[0] !== OP_SETTINGS_ACK) {
    throw new Error(`Expected settings ACK opcode 0x14, got 0x${buffer[0].toString(16)}`);
  }

  const checksumValid = buffer.length >= 2 ? validateChecksum(buffer) : true;

  return { accepted: true, checksumValid };
}
