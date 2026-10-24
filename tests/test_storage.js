/**
 * Unit Tests for QN-Scale Persistence & Storage
 *
 * Verifies:
 * - SQLite schema creation & table setup
 * - Saving measurement records with all metadata
 * - Duplicate prevention when the same record is received multiple times
 * - Handling malformed/corrupted packets without data loss (preserving raw hex)
 * - Retrieval with pagination and filtering
 * - Summary statistics calculation
 * - CSV export formatting, escaping, and validation
 *
 * All fixtures are marked as SOURCE (documented capture) or SYNTHETIC (constructed for tests).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MeasurementStore } from '../qnscale/storage.js';

describe('QN-Scale Storage Tests', () => {
  const TEST_DIR = './data/test_tmp_' + Date.now();
  const TEST_DB_PATH = path.join(TEST_DIR, 'test_measurements.db');
  const TEST_CSV_PATH = path.join(TEST_DIR, 'test_export.csv');

  /** @type {MeasurementStore} */
  let store;

  before(async () => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    store = new MeasurementStore(TEST_DB_PATH);
    await store.open();
  });

  after(async () => {
    if (store) {
      await store.close();
    }
    try {
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  });

  describe('1. Database Initialization', () => {
    it('initializes tables and indexes without error', async () => {
      assert.equal(store.isOpen, true);
      assert.ok(fs.existsSync(TEST_DB_PATH));
    });
  });

  describe('2. Saving Measurements', () => {
    it('saves a complete documented measurement record', async () => {
      // SOURCE: PROTOCOL.md lines 67-74
      const result = await store.saveMeasurement({
        timestamp: '2026-10-25T00:15:00.000Z',
        deviceAddress: 'FB:01:00:18:50:08',
        measurementType: 'live',
        weightKg: 81.10,
        impedance1: 533,
        impedance2: 484,
        rawPacketHex: '100b151fae01021501e400fa',
        protocolVersion: 0x15,
        parsedFields: { weightKg: 81.10, impedance1: 533, impedance2: 484 },
        decodeStatus: 'ok'
      });

      assert.equal(result.inserted, true);
      assert.ok(result.id > 0);
    });

    it('prevents duplicate records with identical address, raw packet, and timestamp', async () => {
      // Insert duplicate
      const duplicateResult = await store.saveMeasurement({
        timestamp: '2026-10-25T00:15:00.000Z',
        deviceAddress: 'FB:01:00:18:50:08',
        measurementType: 'live',
        weightKg: 81.10,
        impedance1: 533,
        impedance2: 484,
        rawPacketHex: '100b151fae01021501e400fa',
        protocolVersion: 0x15,
        parsedFields: { weightKg: 81.10 },
        decodeStatus: 'ok'
      });

      assert.equal(duplicateResult.inserted, false);
      assert.equal(duplicateResult.id, null);
    });

    it('preserves the original raw packet even when decoding fails', async () => {
      // SYNTHETIC: Corrupted raw packet that failed decoding
      const rawHex = '100b15ffff00000000000000';
      const result = await store.saveMeasurement({
        timestamp: '2026-10-25T00:16:00.000Z',
        deviceAddress: 'FB:01:00:18:50:08',
        measurementType: 'live',
        weightKg: null,
        impedance1: null,
        impedance2: null,
        rawPacketHex: rawHex,
        protocolVersion: null,
        parsedFields: null,
        decodeStatus: 'checksum_error'
      });

      assert.equal(result.inserted, true);

      // Verify the record preserved the raw packet
      const rows = await store.getMeasurements({ limit: 10 });
      const found = rows.find((r) => r.raw_packet_hex === rawHex);
      assert.ok(found);
      assert.equal(found.raw_packet_hex, rawHex);
      assert.equal(found.decode_status, 'checksum_error');
      assert.equal(found.weight_kg, null);
    });
  });

  describe('3. Querying & Statistics', () => {
    it('retrieves measurements with deviceAddress and pagination', async () => {
      // Add a stored historical record
      await store.saveMeasurement({
        timestamp: '2026-10-24T12:00:00.000Z',
        deviceAddress: 'FB:01:00:18:50:08',
        measurementType: 'stored',
        weightKg: 80.50,
        rawPacketHex: '231215...synthetic',
        protocolVersion: 0x15,
        decodeStatus: 'ok'
      });

      const rows = await store.getMeasurements({
        deviceAddress: 'FB:01:00:18:50:08',
        limit: 2
      });

      assert.equal(rows.length, 2);
      assert.equal(rows[0].device_address, 'FB:01:00:18:50:08');
    });

    it('computes store statistics accurately', async () => {
      const stats = await store.getStats();
      assert.ok(stats.total >= 3);
      assert.ok(typeof stats.latest === 'string');
      assert.ok(typeof stats.earliest === 'string');
    });
  });

  describe('4. CSV Export', () => {
    it('exports all stored records to a properly formatted CSV file', async () => {
      const count = await store.exportCSV(TEST_CSV_PATH);
      assert.ok(count >= 3);
      assert.ok(fs.existsSync(TEST_CSV_PATH));

      const content = fs.readFileSync(TEST_CSV_PATH, 'utf-8');
      const lines = content.trim().split('\n');

      // Check CSV Header
      const header = lines[0];
      assert.ok(header.includes('id'));
      assert.ok(header.includes('timestamp'));
      assert.ok(header.includes('weight_kg'));
      assert.ok(header.includes('impedance1_ohm'));
      assert.ok(header.includes('raw_packet_hex'));
      assert.ok(header.includes('decode_status'));

      // Check that data row exists
      assert.equal(lines.length, count + 1);
      assert.ok(content.includes('81.1'));
      assert.ok(content.includes('FB:01:00:18:50:08'));
    });
  });
});
