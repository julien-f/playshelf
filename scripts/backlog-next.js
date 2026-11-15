'use strict';

// Prints the next backlog number: one past the highest ever used, in the backlog file or any commit
// message — fixed items leave the file, so its own highest number would reuse one history cites.
//   node scripts/backlog-next.js <C|U|P>

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FILES = { C: 'docs/dev/code-backlog.md', U: 'docs/dev/improvements.md', P: 'docs/dev/setup-backlog.md' };

function nextNumber(letter, texts) {
  let max = 0;
  for (const text of texts)
    for (const [, n] of text.matchAll(new RegExp(`\\b${letter}(\\d+)\\b`, 'g'))) max = Math.max(max, Number(n));
  return `${letter}${max + 1}`;
}

function main() {
  const [letter] = process.argv.slice(2);
  if (!(letter in FILES)) {
    console.error('Usage: node scripts/backlog-next.js <C|U|P>');
    process.exit(1);
  }
  const root = path.join(__dirname, '..');
  const backlog = fs.readFileSync(path.join(root, FILES[letter]), 'utf8');
  // Every commit message, which outgrew execFileSync's 1 MB default buffer.
  const log = execFileSync('git', ['log', '--all', '--format=%B'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  console.log(nextNumber(letter, [backlog, log]));
}

if (require.main === module) main();

module.exports = { nextNumber };
