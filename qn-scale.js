#!/usr/bin/env node
// QN-Scale Reader - Entry point
// Communicates with Healthify QN-Scale weighing scales over BLE
import { main } from './qnscale/cli.js';
main(process.argv.slice(2));
