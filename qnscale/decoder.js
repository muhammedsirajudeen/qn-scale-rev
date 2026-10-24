/**
 * QN-Scale Measurement Decoder
 *
 * Interprets parsed protocol frames into structured, human-readable
 * measurement objects. Handles timestamp conversion between the QN epoch
 * (2000-01-01) and standard JavaScript Dates.
 *
 * NOTE: Body composition metrics (fat%, muscle%, water%) are NOT calculated.
 * The scale provides raw impedance readings from two electrode pairs, but
 * computing body composition requires user parameters (age, height, gender)
 * and the proprietary Trisa/Yolanda algorithm library, which is not available.
 * We record impedance values so they can be processed externally if desired.
 *
 * @module qnscale/decoder
 */

import { QN_EPOCH_OFFSET } from './protocol.js';

// ─── Measurement Status ──────────────────────────────────────────────────────

/**
 * Measurement status enum.
 * - `unstable`: Weight is still fluctuating (scale display blinking)
 * - `stable`:   Weight has settled; this is the final live reading
 * - `stored`:   A previously recorded measurement retrieved from scale memory
 *
 * @readonly
 * @enum {string}
 */
export const MeasurementStatus = Object.freeze({
  UNSTABLE: 'unstable',
  STABLE:   'stable',
  STORED:   'stored',
});

// ─── Timestamp Helpers ───────────────────────────────────────────────────────

/**
 * Convert a QN epoch timestamp to a JavaScript Date.
 *
 * The QN epoch starts at 2000-01-01T00:00:00 local time.
 * Internally the scale stores seconds since that epoch.
 *
 * @param {number} qnEpochSeconds - Seconds since 2000-01-01 (QN epoch)
 * @returns {Date} Equivalent JavaScript Date
 * @source PROTOCOL.md line 46
 */
export function decodeTimestamp(qnEpochSeconds) {
  const unixSeconds = qnEpochSeconds + QN_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}

/**
 * Convert a JavaScript Date to QN epoch seconds.
 *
 * @param {Date} [date=new Date()] - Date to convert (defaults to now)
 * @returns {number} Seconds since 2000-01-01 (QN epoch)
 * @source PROTOCOL.md line 46
 */
export function encodeTimestamp(date = new Date()) {
  const unixSeconds = Math.floor(date.getTime() / 1000);
  return unixSeconds - QN_EPOCH_OFFSET;
}

// ─── Measurement Decoder ─────────────────────────────────────────────────────

/**
 * @typedef {Object} DecodedMeasurement
 * @property {number}  weightKg      - Weight in kilograms
 * @property {number}  weightRaw     - Raw weight value from the protocol frame
 * @property {string}  status        - One of MeasurementStatus values
 * @property {number}  impedance1    - Impedance reading from electrode pair 1 (ohms)
 * @property {number}  impedance2    - Impedance reading from electrode pair 2 (ohms)
 * @property {boolean} hasImpedance  - True if impedance values are non-zero
 * @property {Date}    timestamp     - When the measurement was taken
 * @property {boolean} checksumValid - Whether the source frame's checksum was valid
 */

/**
 * Decode a parsed protocol frame into a structured measurement object.
 *
 * Accepts the result of either `parseMeasurement()` (live) or
 * `parseStoredMeasurement()` (stored from history).
 *
 * Weight division:
 *   - The raw weight value is always in hundredths of kg (divide by 100).
 *   - Some scales report a weightScaleHint of 1 → /100, else → /10.
 *     However, CS20C1 reports 0x05 yet still uses /100, so the default
 *     behaviour is always /100. Pass `scaleDivisor` to override.
 *
 * @param {Object} parsedFrame - Output from parseMeasurement or parseStoredMeasurement
 * @param {number} parsedFrame.weightRaw - Raw weight value
 * @param {number} parsedFrame.weightKg  - Pre-computed weight in kg
 * @param {boolean} [parsedFrame.stable] - Stability flag (live measurements only)
 * @param {number} parsedFrame.impedance1 - First impedance reading (ohms)
 * @param {number} parsedFrame.impedance2 - Second impedance reading (ohms)
 * @param {number} [parsedFrame.timestampQn] - QN epoch timestamp (stored measurements only)
 * @param {boolean} parsedFrame.checksumValid - Frame checksum validity
 * @param {Object} [options] - Decoding options
 * @param {number} [options.scaleDivisor=100] - Divisor for raw weight (100 or 10)
 * @param {boolean} [options.isStored=false] - True if this is a stored measurement
 * @returns {DecodedMeasurement} Fully decoded measurement
 */
export function decodeMeasurement(parsedFrame, options = {}) {
  const {
    scaleDivisor = 100,
    isStored = false,
  } = options;

  // Determine status
  let status;
  if (isStored) {
    status = MeasurementStatus.STORED;
  } else {
    status = parsedFrame.stable ? MeasurementStatus.STABLE : MeasurementStatus.UNSTABLE;
  }

  // Compute weight using the specified divisor
  const weightKg = parsedFrame.weightRaw / scaleDivisor;

  // Determine timestamp
  let timestamp;
  if (parsedFrame.timestampQn !== undefined && parsedFrame.timestampQn > 0) {
    timestamp = decodeTimestamp(parsedFrame.timestampQn);
  } else {
    timestamp = new Date();
  }

  // Check for impedance presence (zero means no contact / no reading)
  const hasImpedance = parsedFrame.impedance1 > 0 || parsedFrame.impedance2 > 0;

  return {
    weightKg,
    weightRaw: parsedFrame.weightRaw,
    status,
    impedance1: parsedFrame.impedance1,
    impedance2: parsedFrame.impedance2,
    hasImpedance,
    timestamp,
    checksumValid: parsedFrame.checksumValid,
  };
}
