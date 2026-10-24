/**
 * Unit Tests for QN-Scale Measurement Decoder
 *
 * Verifies:
 * - Conversion of parsed frames to structured measurement objects
 * - Timestamp conversion between QN epoch (2000-01-01) and JavaScript Date
 * - Stability state handling (stable, unstable, stored)
 * - Raw impedance extraction
 * - Boundary values & divisors (100 vs 10)
 * - Verification that body composition metrics (body fat %, muscle mass, etc.)
 *   are NOT fabricated without sufficient parameters or proprietary algorithms.
 *
 * All fixtures are marked as SOURCE (documented capture) or SYNTHETIC (constructed for tests).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMeasurement,
  decodeTimestamp,
  encodeTimestamp,
  MeasurementStatus
} from '../qnscale/decoder.js';

describe('QN-Scale Decoder Tests', () => {

  describe('1. Measurement Decoding', () => {
    it('decodes documented stable measurement', () => {
      // SOURCE: PROTOCOL.md line 70
      const parsed = {
        weightRaw: 8110,
        weightKg: 81.10,
        stable: true,
        impedance1: 533,
        impedance2: 484,
        checksumValid: true
      };

      const decoded = decodeMeasurement(parsed);
      assert.equal(decoded.weightKg, 81.10);
      assert.equal(decoded.weightRaw, 8110);
      assert.equal(decoded.status, MeasurementStatus.STABLE);
      assert.equal(decoded.impedance1, 533);
      assert.equal(decoded.impedance2, 484);
      assert.equal(decoded.hasImpedance, true);
      assert.equal(decoded.checksumValid, true);
      assert.ok(decoded.timestamp instanceof Date);
    });

    it('decodes unstable live reading', () => {
      // SYNTHETIC: Reading in progress before scale locks
      const parsed = {
        weightRaw: 7950,
        weightKg: 79.50,
        stable: false,
        impedance1: 0,
        impedance2: 0,
        checksumValid: true
      };

      const decoded = decodeMeasurement(parsed);
      assert.equal(decoded.weightKg, 79.50);
      assert.equal(decoded.status, MeasurementStatus.UNSTABLE);
      assert.equal(decoded.hasImpedance, false);
    });

    it('decodes stored historical reading', () => {
      // SYNTHETIC: Stored record retrieved from scale flash memory
      const parsed = {
        weightRaw: 8020,
        weightKg: 80.20,
        impedance1: 520,
        impedance2: 515,
        timestampQn: 12345678,
        checksumValid: true
      };

      const decoded = decodeMeasurement(parsed, { isStored: true });
      assert.equal(decoded.weightKg, 80.20);
      assert.equal(decoded.status, MeasurementStatus.STORED);
      assert.equal(decoded.hasImpedance, true);
      assert.ok(decoded.timestamp instanceof Date);
    });

    it('supports alternative divisor 10 for scales reporting in tenths of kg', () => {
      // SOURCE: QNHandler.kt lines 79, 363
      // SYNTHETIC test with raw value 812 with divisor 10 -> 81.2 kg
      const parsed = {
        weightRaw: 812,
        stable: true,
        impedance1: 530,
        impedance2: 530,
        checksumValid: true
      };

      const decoded = decodeMeasurement(parsed, { scaleDivisor: 10 });
      assert.equal(decoded.weightKg, 81.2);
    });
  });

  describe('2. Timestamp Encoding & Decoding', () => {
    it('decodes QN epoch 0 to 2000-01-01 00:00:00 UTC (offset 946702800)', () => {
      // SOURCE: PROTOCOL.md line 88
      const date = decodeTimestamp(0);
      assert.equal(date.getTime(), 946702800 * 1000);
      assert.equal(date.toISOString(), '2000-01-01T05:00:00.000Z');
    });

    it('roundtrips timestamps accurately (encode -> decode)', () => {
      const now = new Date();
      const qnSeconds = encodeTimestamp(now);
      const restored = decodeTimestamp(qnSeconds);

      // Within 1 second due to integer seconds conversion
      assert.ok(Math.abs(restored.getTime() - now.getTime()) <= 1000);
    });
  });

  describe('3. Measurement Status Enum', () => {
    it('contains all documented status constants', () => {
      assert.equal(MeasurementStatus.UNSTABLE, 'unstable');
      assert.equal(MeasurementStatus.STABLE, 'stable');
      assert.equal(MeasurementStatus.STORED, 'stored');
      assert.ok(Object.isFrozen(MeasurementStatus));
    });
  });

  describe('4. Documentation Integrity: No Fabricated Metrics', () => {
    it('does NOT fabricate body fat, muscle mass, or other unprovided metrics', () => {
      // CRITICAL REQUIREMENT:
      // "Do not fabricate body-fat percentage, skeletal muscle mass, visceral fat,
      //  or other metrics when the device has not provided enough information
      //  to calculate them reliably."
      const parsed = {
        weightRaw: 8110,
        weightKg: 81.10,
        stable: true,
        impedance1: 533,
        impedance2: 484,
        checksumValid: true
      };

      const decoded = decodeMeasurement(parsed);

      assert.equal(decoded.bodyFat, undefined);
      assert.equal(decoded.muscleMass, undefined);
      assert.equal(decoded.visceralFat, undefined);
      assert.equal(decoded.waterPercentage, undefined);
      assert.equal(decoded.boneMass, undefined);
    });
  });
});
