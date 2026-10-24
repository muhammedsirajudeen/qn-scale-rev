/**
 * QN-Scale Local Persistence Module
 *
 * Saves measurements to SQLite as the primary datastore and provides CSV export.
 *
 * Requirements (Phase 4):
 * - Primary datastore: SQLite
 * - Each record contains:
 *   - Unique record identifier
 *   - Local timestamp with timezone (ISO 8601)
 *   - Device address
 *   - Measurement type ('live' or 'stored')
 *   - Weight in kilograms
 *   - Raw impedance values (impedance1_ohm, impedance2_ohm)
 *   - Original raw packet in hexadecimal
 *   - Protocol version
 *   - Parsed fields in JSON
 *   - Data-quality or decoding status
 * - Avoid duplicate records when the same historical measurement is received more than once
 * - Preserve original raw packet even when decoding fails
 * - CSV export functionality
 *
 * @module qnscale/storage
 */

import sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Default database path
 */
export const DEFAULT_DB_PATH = './data/measurements.db';

/**
 * SQLite Measurement Store
 */
export class MeasurementStore {
  /**
   * @param {string} [dbPath=DEFAULT_DB_PATH] - Path to SQLite database file
   */
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    /** @type {sqlite3.Database|null} */
    this.db = null;
    this.isOpen = false;
  }

  /**
   * Open the database and initialize tables if they don't exist.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.isOpen) return;

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    await new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.isOpen = true;
    await this._createTables();
  }

  /**
   * Internal helper to run a SQL statement with promise.
   * @private
   * @param {string} sql
   * @param {Array<any>} [params=[]]
   * @returns {Promise<{lastID: number, changes: number}>}
   */
  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  /**
   * Internal helper to fetch all rows.
   * @private
   * @param {string} sql
   * @param {Array<any>} [params=[]]
   * @returns {Promise<Array<any>>}
   */
  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Internal helper to fetch a single row.
   * @private
   * @param {string} sql
   * @param {Array<any>} [params=[]]
   * @returns {Promise<any|undefined>}
   */
  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  /**
   * Create schema and indexes.
   * @private
   * @returns {Promise<void>}
   */
  async _createTables() {
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS measurements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        device_address TEXT NOT NULL,
        measurement_type TEXT NOT NULL,
        weight_kg REAL,
        impedance1_ohm REAL,
        impedance2_ohm REAL,
        raw_packet_hex TEXT NOT NULL,
        protocol_version INTEGER,
        parsed_fields TEXT,
        decode_status TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(device_address, raw_packet_hex, timestamp)
      );
    `;
    await this._run(createTableSql);

    await this._run(`
      CREATE INDEX IF NOT EXISTS idx_measurements_device_time 
      ON measurements (device_address, timestamp);
    `);
  }

  /**
   * Close the database connection.
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.isOpen || !this.db) return;

    await new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.isOpen = false;
    this.db = null;
  }

  /**
   * Save a measurement record.
   * Handles duplicate prevention via INSERT OR IGNORE.
   *
   * @param {object} record
   * @param {string} [record.timestamp] - ISO 8601 timestamp string
   * @param {string} record.deviceAddress - Bluetooth MAC address
   * @param {'live'|'stored'} [record.measurementType='live']
   * @param {number|null} [record.weightKg=null]
   * @param {number|null} [record.impedance1=null]
   * @param {number|null} [record.impedance2=null]
   * @param {string} record.rawPacketHex - Raw hex string of the original packet
   * @param {number|null} [record.protocolVersion=null]
   * @param {object|string|null} [record.parsedFields=null]
   * @param {string} [record.decodeStatus='ok']
   * @returns {Promise<{inserted: boolean, id: number|null}>}
   */
  async saveMeasurement({
    timestamp = new Date().toISOString(),
    deviceAddress,
    measurementType = 'live',
    weightKg = null,
    impedance1 = null,
    impedance2 = null,
    rawPacketHex,
    protocolVersion = null,
    parsedFields = null,
    decodeStatus = 'ok'
  }) {
    if (!this.isOpen) {
      await this.open();
    }

    const parsedJson =
      typeof parsedFields === 'object' && parsedFields !== null
        ? JSON.stringify(parsedFields)
        : typeof parsedFields === 'string'
        ? parsedFields
        : null;

    const sql = `
      INSERT OR IGNORE INTO measurements (
        timestamp,
        device_address,
        measurement_type,
        weight_kg,
        impedance1_ohm,
        impedance2_ohm,
        raw_packet_hex,
        protocol_version,
        parsed_fields,
        decode_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;

    const result = await this._run(sql, [
      timestamp,
      deviceAddress,
      measurementType,
      weightKg,
      impedance1,
      impedance2,
      rawPacketHex,
      protocolVersion,
      parsedJson,
      decodeStatus
    ]);

    if (result.changes > 0) {
      return { inserted: true, id: result.lastID };
    }
    return { inserted: false, id: null };
  }

  /**
   * Retrieve measurements with filtering and pagination.
   *
   * @param {object} [options={}]
   * @param {number} [options.limit=100]
   * @param {number} [options.offset=0]
   * @param {string} [options.deviceAddress]
   * @param {string} [options.measurementType]
   * @param {string} [options.since] - ISO 8601 start timestamp
   * @param {string} [options.until] - ISO 8601 end timestamp
   * @returns {Promise<Array<object>>}
   */
  async getMeasurements({
    limit = 100,
    offset = 0,
    deviceAddress,
    measurementType,
    since,
    until
  } = {}) {
    if (!this.isOpen) {
      await this.open();
    }

    const conditions = [];
    const params = [];

    if (deviceAddress) {
      conditions.push('device_address = ?');
      params.push(deviceAddress);
    }
    if (measurementType) {
      conditions.push('measurement_type = ?');
      params.push(measurementType);
    }
    if (since) {
      conditions.push('timestamp >= ?');
      params.push(since);
    }
    if (until) {
      conditions.push('timestamp <= ?');
      params.push(until);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT * FROM measurements
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?;
    `;
    params.push(limit, offset);

    return this._all(sql, params);
  }

  /**
   * Get store summary statistics.
   * @returns {Promise<{total: number, latest: string|null, earliest: string|null}>}
   */
  async getStats() {
    if (!this.isOpen) {
      await this.open();
    }

    const row = await this._get(`
      SELECT 
        COUNT(*) as total,
        MAX(timestamp) as latest,
        MIN(timestamp) as earliest
      FROM measurements;
    `);

    return {
      total: row ? row.total : 0,
      latest: row ? row.latest : null,
      earliest: row ? row.earliest : null
    };
  }

  /**
   * Export all measurements to a CSV file.
   *
   * @param {string} outputPath - File path for CSV export
   * @returns {Promise<number>} Number of records exported
   */
  async exportCSV(outputPath) {
    if (!this.isOpen) {
      await this.open();
    }

    const rows = await this._all(`
      SELECT 
        id,
        timestamp,
        device_address,
        measurement_type,
        weight_kg,
        impedance1_ohm,
        impedance2_ohm,
        raw_packet_hex,
        protocol_version,
        decode_status,
        parsed_fields
      FROM measurements
      ORDER BY timestamp ASC;
    `);

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const headers = [
      'id',
      'timestamp',
      'device_address',
      'measurement_type',
      'weight_kg',
      'impedance1_ohm',
      'impedance2_ohm',
      'raw_packet_hex',
      'protocol_version',
      'decode_status',
      'parsed_fields'
    ];

    const escapeCsvField = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [headers.join(',')];
    for (const r of rows) {
      const line = [
        r.id,
        escapeCsvField(r.timestamp),
        escapeCsvField(r.device_address),
        escapeCsvField(r.measurement_type),
        r.weight_kg !== null ? r.weight_kg : '',
        r.impedance1_ohm !== null ? r.impedance1_ohm : '',
        r.impedance2_ohm !== null ? r.impedance2_ohm : '',
        escapeCsvField(r.raw_packet_hex),
        r.protocol_version !== null ? r.protocol_version : '',
        escapeCsvField(r.decode_status),
        escapeCsvField(r.parsed_fields)
      ].join(',');
      lines.push(line);
    }

    fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf-8');
    return rows.length;
  }
}
