'use strict';

// Lints the Claude Code setup where a rule is mechanical, so setup-review stops finding it by reading:
// each skill's frontmatter (name matches its directory, a "Use when" in a description within the limit),
// setup-backlog.md's header dates once it holds items, and permission allows that would
// pre-approve an ask-first action — failing for the committed
// settings.json, a warning for this machine's settings.local.json (setup-review reports it).
// Run by `npm run check`; setup-review proposes a rule here for any finding that recurs.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAX_DESCRIPTION = 1024; // the Agent Skills spec's limit

// One command per ask-first action in CLAUDE.md and ~/.claude/CLAUDE.md; no allow may match one an ask rule doesn't.
const ASK_FIRST = [
  'git commit -m x',
  'git push origin main',
  'git push --force',
  'git push origin --delete x',
  'git reset --hard HEAD',
  'git branch -D x',
  'git clean -fd',
  'git restore .',
  'git checkout -- .',
  'rm x',
  'sqlite3 db.sqlite',
  'npm install x',
  'npm i x',
  'npm publish',
  'gh pr create',
  'gh issue create',
  'gh pr comment 1',
  'gh issue comment 1',
  'ssh steam.isonoe.net',
  'node scripts/merge.js finish x', // fast-forwards main
];

// Claude Code's Bash rule syntax: `Bash` (any), `Bash(cmd)`, `Bash(prefix:*)`, `*` as a wildcard.
function ruleMatches(rule, command) {
  const m = rule.match(/^Bash(?:\((.*)\))?$/);
  if (!m) return false;
  if (m[1] === undefined) return true;
  if (m[1].endsWith(':*')) return command.startsWith(m[1].slice(0, -2));
  const glob = m[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${glob}$`).test(command);
}

// `file`: path for messages; `settings`: its parsed JSON.
function permissionProblems(file, settings) {
  const asked = (command) => (settings.permissions?.ask ?? []).some((rule) => ruleMatches(rule, command));
  return (settings.permissions?.allow ?? []).flatMap((rule) =>
    ASK_FIRST.filter((command) => ruleMatches(rule, command) && !asked(command)).map(
      (command) => `${file}: allow "${rule}" pre-approves an ask-first action (\`${command}\`)`,
    ),
  );
}

// `dir`: the skill's directory name; `source`: its SKILL.md.
function skillProblems(dir, source) {
  const front = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!front) return [`${dir}: SKILL.md has no frontmatter`];
  const field = (name) => front.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1].trim();
  const name = field('name');
  const description = field('description') ?? '';
  return [
    name !== dir && `${dir}: frontmatter name "${name}" doesn't match its directory`,
    !/Use when/.test(description) && `${dir}: description has no "Use when"`,
    description.length > MAX_DESCRIPTION &&
      `${dir}: description is ${description.length} characters (max ${MAX_DESCRIPTION})`,
  ].filter(Boolean);
}

// `source`: setup-backlog.md. Undated, the next run re-reads transcripts an earlier one already read.
function ledgerProblems(source) {
  if (!/\*\*P\d+ ·/.test(source)) return [];
  const header = source.match(/^Last reviewed: .*$/m)?.[0] ?? '';
  return /\bnever\b/.test(header) ? ['docs/dev/setup-backlog.md: holds items but its header dates say "never"'] : [];
}

function main() {
  const skills = path.join(ROOT, '.claude', 'skills');
  const problems = fs.readdirSync(skills).flatMap((dir) => {
    const file = path.join(skills, dir, 'SKILL.md');
    return fs.existsSync(file) ? skillProblems(dir, fs.readFileSync(file, 'utf8')) : [`${dir}: no SKILL.md`];
  });
  const settings = (name) => {
    const file = path.join(ROOT, '.claude', name);
    return fs.existsSync(file) ? permissionProblems(`.claude/${name}`, JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
  };
  problems.push(...ledgerProblems(fs.readFileSync(path.join(ROOT, 'docs', 'dev', 'setup-backlog.md'), 'utf8')));
  problems.push(...settings('settings.json'));
  for (const warning of settings('settings.local.json')) console.warn(`warning: ${warning}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { ruleMatches, permissionProblems, skillProblems, ledgerProblems };
