/**
 * Unit Tests for QN-Scale Protocol Implementation
 *
 * Verifies:
 * - Checksum calculation and validation
 * - Command encoding (unit config, time, time sync, history)
 * - Frame decoding (greeting, measurement, stored reading, ack)
 * - Endianness (big-endian for weight/live impedance, little-endian for time/stored impedance)
 * - Error handling for malformed packets, invalid checksums, unknown opcodes
 *
 * All fixtures are marked as SOURCE (documented capture) or SYNTHETIC (constructed for tests).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeChecksum,
  validateChecksum,
  buildUnitConfig,
  buildTimePayload,
  buildTimeSync,
  buildHistoryRequest,
  parseGreeting,
  parseMeasurement,
  parseStoredMeasurement,
  parseSettingsAck,
  OP_GREETING,
  OP_MEASUREMENT,
  OP_SETTINGS_ACK,
  OP_SERVICE,
  OP_STORED_MEASUREMENT,
  OP_UNIT_CONFIG,
  OP_TIME,
  OP_TIME_SYNC,
  OP_HISTORY_REQUEST,
  UNIT_KG,
  UNIT_LB,
  QN_EPOCH_OFFSET
} from '../qnscale/protocol.js';

describe('QN-Scale Protocol Tests', () => {

  describe('1. Checksum Calculation & Validation', () => {
    // SOURCE: PROTOCOL.md lines 67-70 - Captured packet from Libra CS20C1 hardware
    const CAPTURED_MEASUREMENT_PACKET = Buffer.from([
      0x10, 0x0b, 0x15, 0x1f, 0xae, 0x01, 0x02, 0x15, 0x01, 0xe4, 0x00, 0xfa
    ]);

    // SOURCE: PROTOCOL.md line 83 / connect.py line 41
    const CAPTURED_UNIT_CONFIG_PAYLOAD = Buffer.from([
      0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00
    ]);

    it('computes correct checksum for documented measurement packet', () => {
      // Sum of bytes 0..10 mod 256 must equal 0xfa
      const calculated = computeChecksum(CAPTURED_MEASUREMENT_PACKET.subarray(0, 11));
      assert.equal(calculated, 0xfa);
    });

    it('computes correct checksum for unit config (kg) packet', () => {
      // Sum of bytes 0..7 mod 256 must equal 0x42
      const calculated = computeChecksum(CAPTURED_UNIT_CONFIG_PAYLOAD);
      assert.equal(calculated, 0x42);
    });

    it('validates authentic documented packet as valid', () => {
      assert.equal(validateChecksum(CAPTURED_MEASUREMENT_PACKET), true);
    });

    it('detects invalid checksum on corrupted packet', () => {
      // SYNTHETIC: Corrupted packet with altered checksum byte
      const corrupted = Buffer.from(CAPTURED_MEASUREMENT_PACKET);
      corrupted[corrupted.length - 1] = 0x00;
      assert.equal(validateChecksum(corrupted), false);
    });

    it('detects payload tampering with original checksum', () => {
      // SYNTHETIC: Weight byte altered without updating checksum
      const tampered = Buffer.from(CAPTURED_MEASUREMENT_PACKET);
      tampered[3] = 0x20;
      assert.equal(validateChecksum(tampered), false);
    });
  });

  describe('2. Frame Encoding', () => {
    it('encodes unit config in kg (0x13) matching documented format', () => {
      // SOURCE: PROTOCOL.md line 83: 13 09 15 01 10 00 00 00 42
      const frame = buildUnitConfig(0x15, UNIT_KG);
      assert.equal(frame.length, 9);
      assert.equal(frame[0], OP_UNIT_CONFIG); // 0x13
      assert.equal(frame[1], 0x09);           // Length
      assert.equal(frame[2], 0x15);           // Protocol version
      assert.equal(frame[3], 0x01);           // KG
      assert.equal(frame[4], 0x10);           // Config constant
      assert.equal(frame[8], 0x42);           // Checksum
      assert.equal(validateChecksum(frame), true);
    });

    it('encodes unit config in lb (0x13)', () => {
      // SOURCE: QNHandler.kt lines 508-509
      const frame = buildUnitConfig(0x15, UNIT_LB);
      assert.equal(frame[3], 0x02); // LB
      assert.equal(validateChecksum(frame), true);
    });

    it('encodes current time frame (0x02) WITHOUT checksum', () => {
      // SOURCE: PROTOCOL.md line 36, line 84: "0x02 frame has NO checksum"
      const frame = buildTimePayload();
      assert.equal(frame.length, 5);
      assert.equal(frame[0], OP_TIME); // 0x02

      const qnSeconds = frame.readUInt32LE(1);
      const expectedSeconds = Math.floor(Date.now() / 1000) - QN_EPOCH_OFFSET;
      assert.ok(Math.abs(qnSeconds - expectedSeconds) <= 2);
    });

    it('encodes time sync command (0x20) with LE timestamp and checksum', () => {
      // SOURCE: PROTOCOL.md line 85: 20 08 <ver> <4 bytes time LE> <sum>
      const frame = buildTimeSync(0x15);
      assert.equal(frame.length, 8);
      assert.equal(frame[0], OP_TIME_SYNC); // 0x20
      assert.equal(frame[1], 0x08);          // Length
      assert.equal(frame[2], 0x15);          // Protocol version
      assert.equal(validateChecksum(frame), true);
    });

    it('encodes history request command (0x22)', () => {
      // SOURCE: PROTOCOL.md line 86: 22 06 <ver> 00 03 <sum>
      const frame = buildHistoryRequest(0x15);
      assert.equal(frame.length, 6);
      assert.equal(frame[0], OP_HISTORY_REQUEST); // 0x22
      assert.equal(frame[1], 0x06);
      assert.equal(frame[2], 0x15);
      assert.equal(frame[3], 0x00);
      assert.equal(frame[4], 0x03);
      // Expected checksum: (0x22 + 0x06 + 0x15 + 0x00 + 0x03) % 256 = 0x40
      assert.equal(frame[5], 0x40);
      assert.equal(validateChecksum(frame), true);
    });
  });

  describe('3. Frame Decoding', () => {
    it('decodes scale greeting (0x12) with reversed MAC address', () => {
      // SOURCE: PROTOCOL.md lines 57-60
      const GREETING_PACKET = Buffer.from([
        0x12, 0x0f, 0x15, 0x33, 0x22, 0x11, 0xcc, 0xbb, 0xaa, 0x31, 0x05, 0x31, 0x00, 0x05, 0x39
      ]);

      const result = parseGreeting(GREETING_PACKET);
      assert.equal(result.mac.toUpperCase(), 'AA:BB:CC:11:22:33');
      assert.equal(result.protocolVersion, 0x15);
      assert.equal(result.weightScaleHint, 0x05);
    });

    it('decodes documented live measurement (0x10) with exact values', () => {
      // SOURCE: PROTOCOL.md lines 67-74
      // Raw: 10 0b 15 1f ae 01 02 15 01 e4 00 fa
      // Weight 0x1FAE = 8110 -> 81.10 kg (Big-Endian)
      // Stable = 0x01
      // Impedance 1: 0x0215 = 533 ohms
      // Impedance 2: 0x01E4 = 484 ohms
      const packet = Buffer.from([
        0x10, 0x0b, 0x15, 0x1f, 0xae, 0x01, 0x02, 0x15, 0x01, 0xe4, 0x00, 0xfa
      ]);

      const result = parseMeasurement(packet);
      assert.equal(result.weightRaw, 8110);
      assert.equal(result.weightKg, 81.10);
      assert.equal(result.stable, true);
      assert.equal(result.impedance1, 533);
      assert.equal(result.impedance2, 484);
      assert.equal(result.checksumValid, true);
    });

    it('decodes verified second weight point (81.20 kg)', () => {
      // SOURCE: PROTOCOL.md line 95: 81.20 kg -> 0x1FB8 = 8120
      // SYNTHETIC: Assembled with the verified weight 0x1FB8 and valid checksum
      const raw = Buffer.from([
        0x10, 0x0b, 0x15, 0x1f, 0xb8, 0x01, 0x02, 0x15, 0x01, 0xe4, 0x00, 0x00
      ]);
      raw[raw.length - 1] = computeChecksum(raw.subarray(0, raw.length - 1));

      const result = parseMeasurement(raw);
      assert.equal(result.weightRaw, 8120);
      assert.equal(result.weightKg, 81.20);
      assert.equal(result.checksumValid, true);
    });

    it('correctly reports unstable measurement (byte 5 == 0x00)', () => {
      // SYNTHETIC: Documented format with stability byte set to 0x00
      const raw = Buffer.from([
        0x10, 0x0b, 0x15, 0x1f, 0xae, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
      ]);
      raw[raw.length - 1] = computeChecksum(raw.subarray(0, raw.length - 1));

      const result = parseMeasurement(raw);
      assert.equal(result.stable, false);
      assert.equal(result.checksumValid, true);
    });

    it('decodes stored measurement (0x23) with LE impedance & timestamp', () => {
      // SOURCE: PROTOCOL.md line 76-77, QNHandler.kt lines 403-407
      // SYNTHETIC packet: 17 bytes, opcode 0x23
      // Timestamp QN epoch: 1000 seconds -> bytes 6-9 LE = [0xe8, 0x03, 0x00, 0x00]
      // Weight: 75.50 kg = 7550 = 0x1D7E -> bytes 10-11 BE = [0x1d, 0x7e]
      // Imp1: 500 ohms = 0x01F4 -> bytes 13-14 LE = [0xf4, 0x01]
      // Imp2: 490 ohms = 0x01EA -> bytes 15-16 LE = [0xea, 0x01]
      const buf = Buffer.alloc(18);
      buf[0] = OP_STORED_MEASUREMENT; // 0x23
      buf[1] = 0x12;                  // length
      buf[2] = 0x15;                  // proto
      buf.writeUInt32LE(1000, 6);     // timestamp
      buf.writeUInt16BE(7550, 10);    // weight BE
      buf.writeUInt16LE(500, 13);     // imp1 LE
      buf.writeUInt16LE(490, 15);     // imp2 LE
      buf[17] = computeChecksum(buf.subarray(0, 17));

      const result = parseStoredMeasurement(buf);
      assert.equal(result.weightRaw, 7550);
      assert.equal(result.weightKg, 75.50);
      assert.equal(result.impedance1, 500);
      assert.equal(result.impedance2, 490);
      assert.equal(result.timestampQn, 1000);
      assert.equal(result.checksumValid, true);
    });

    it('decodes settings acknowledgment (0x14)', () => {
      // SOURCE: PROTOCOL.md line 44
      // SYNTHETIC valid 0x14 frame
      const buf = Buffer.from([0x14, 0x03, 0x15, 0x00]);
      buf[3] = computeChecksum(buf.subarray(0, 3));

      const result = parseSettingsAck(buf);
      assert.equal(result.accepted, true);
      assert.equal(result.checksumValid, true);
    });
  });

  describe('4. Error Handling & Malformed Packets', () => {
    it('throws on measurement buffer shorter than 10 bytes', () => {
      // SYNTHETIC: Truncated frame
      const truncated = Buffer.from([0x10, 0x05, 0x15]);
      assert.throws(() => parseMeasurement(truncated), /too short/i);
    });

    it('throws on measurement opcode mismatch', () => {
      // SYNTHETIC: Wrong opcode
      const wrongOp = Buffer.from([0x99, 0x0b, 0x15, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
      assert.throws(() => parseMeasurement(wrongOp), /expected measurement opcode 0x10/i);
    });

    it('throws on greeting buffer shorter than 11 bytes', () => {
      // SYNTHETIC: Truncated greeting
      const truncated = Buffer.from([0x12, 0x05, 0x15]);
      assert.throws(() => parseGreeting(truncated), /too short/i);
    });

    it('throws on greeting opcode mismatch', () => {
      // SYNTHETIC: Wrong opcode
      const wrongOp = Buffer.from([0x10, 0x0f, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      assert.throws(() => parseGreeting(wrongOp), /expected greeting opcode 0x12/i);
    });
  });

  describe('5. Time Epoch Constants', () => {
    it('has exact QN Unix epoch offset of 946702800 seconds', () => {
      // SOURCE: PROTOCOL.md line 88, QNHandler.kt line 50
      assert.equal(QN_EPOCH_OFFSET, 946702800);
      // Epoch 2000-01-01T00:00:00Z in Unix timestamp
      const date2000 = new Date('2000-01-01T00:00:00.000Z').getTime() / 1000;
      assert.equal(date2000, 946684800);
      // 946702800 represents the vendor-defined reference timestamp
    });
  });
});
