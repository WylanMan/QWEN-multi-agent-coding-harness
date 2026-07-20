#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BUS_PATH = resolve(process.env.HARNESS_DIR || process.env.HOME + '/.pi/harness', 'bus/messages.jsonl');

const VALID_AGENTS = ['manager', 'architect', 'engineer', 'planner', 'coder', 'system', 'runner'];
const VALID_PHASES = ['classifying', 'negotiating_round_1', 'negotiating_round_2', 'implementing', 'done', 'deadlocked', 'heartbeat'];

function validateLine(line, lineNum) {
  const errors = [];
  const warnings = [];

  // Must be valid JSON
  let msg;
  try { msg = JSON.parse(line); } catch (e) {
    return { lineNum, errors: [`Invalid JSON: ${e.message}`], warnings: [] };
  }

  if (typeof msg !== 'object' || msg === null) {
    errors.push('Message must be a JSON object');
    return { lineNum, errors, warnings };
  }

  // Required: timestamp
  if (typeof msg.timestamp !== 'string' || isNaN(Date.parse(msg.timestamp))) {
    errors.push(`Invalid or missing timestamp: ${JSON.stringify(msg.timestamp)}`);
  }

  // Required: agent
  if (!VALID_AGENTS.includes(msg.agent)) {
    errors.push(`Invalid agent '${msg.agent}'. Must be one of: ${VALID_AGENTS.join(', ')}`);
  }

  // Required: action
  if (typeof msg.action !== 'string' || msg.action.length === 0) {
    errors.push('Missing or empty action');
  }

  // Required: payload key present
  if (!('payload' in msg)) {
    errors.push('Missing payload field');
  }

  // Conditional: phase for manager/runner
  if ((msg.agent === 'manager' || msg.agent === 'runner') && !msg.phase) {
    errors.push(`Missing phase field (required for ${msg.agent})`);
  }
  if (msg.phase && !VALID_PHASES.includes(msg.phase)) {
    warnings.push(`Unknown phase '${msg.phase}'. Valid: ${VALID_PHASES.join(', ')}`);
  }

  // Conditional: task_id for non-heartbeat, non-system
  if (msg.action !== 'heartbeat' && msg.agent !== 'system' && msg.agent !== 'runner' && !msg.task_id) {
    warnings.push('Missing task_id (recommended for cross-message correlation)');
  }

  // Check for newlines in string values (would break JSONL)
  if (typeof msg.payload === 'string' && msg.payload.includes('\n')) {
    errors.push('Payload string contains newline characters — this breaks JSONL format');
  }

  return { lineNum, errors, warnings };
}

// Main
const content = readFileSync(BUS_PATH, 'utf-8').trim();
if (!content) {
  console.log('No messages on bus (empty file).');
  process.exit(0);
}

const lines = content.split('\n');
let validCount = 0;
let invalidCount = 0;
let warningCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const result = validateLine(line, i + 1);

  if (result.errors.length > 0) {
    console.log(`Line ${result.lineNum}: FAILED`);
    result.errors.forEach(e => console.log(`  ERROR: ${e}`));
    result.warnings.forEach(w => console.log(`  WARN: ${w}`));
    invalidCount++;
  } else if (result.warnings.length > 0) {
    console.log(`Line ${result.lineNum}: OK (${result.warnings.length} warnings)`);
    result.warnings.forEach(w => console.log(`  WARN: ${w}`));
    validCount++;
    warningCount += result.warnings.length;
  } else {
    validCount++;
  }
}

console.log(`\n${validCount} valid, ${invalidCount} invalid, ${warningCount} warnings`);
process.exit(invalidCount > 0 ? 1 : 0);
