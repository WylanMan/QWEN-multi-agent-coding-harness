#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: cli.js <filename>');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length !== 1) {
    usage();
  }

  const filename = args[0];

  let content;
  try {
    content = fs.readFileSync(filename, 'utf8');
  } catch (err) {
    console.error(`Error reading file "${filename}": ${err.message}`);
    process.exit(1);
  }

  const lines = content.split('\n');
  // If the file ends with a newline, the last element is an empty string — don't count it
  const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  const charCount = content.length;

  console.log(`${lineCount} ${wordCount} ${charCount} ${filename}`);
}

main();
