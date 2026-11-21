'use strict';

// Evaluates the skills by running them headless (`claude -p`), in a throwaway clone of the repo so
// nothing lands in it or in the session transcripts (`--no-session-persistence`).
//   node scripts/skill-evals.js [--ref=REF] [--repeat=N] [--dry-run] [--budget=USD] [SKILL...]
// Each `.claude/skills/<name>/evals.json` (or a user skill's, in ~/.claude/skills) holds `routing`: `{ prompt, expect }` cases, `expect` being the
// skill (a built-in one too) the prompt should load, or `-` for none; and, for a skill safe to run
// unattended, `dryRun`: the command to run it with. Routing stops each run at its first tool call;
// --dry-run also runs each `dryRun` to the end (budget-capped, about $0.50–$2 each) and reports its
// failed and denied calls. The clone is of the working tree (uncommitted changes included) or of REF,
// to compare a skill change before and after.
// Verified on Claude Code 2.1.296: stream-json emits each `tool_use` before running it, the `result`
// event carries `total_cost_usd`, and --no-session-persistence writes no transcript.
// Each run's results go to scripts/dev-metrics.js (`evals`), to compare with earlier runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { record, history } = require('./dev-metrics');

const ROOT = path.join(__dirname, '..');
const USER_SKILLS = path.join(os.homedir(), '.claude', 'skills');
// The user-level setup-review skill's transcript parser (template-CLAUDE.md), only needed by --dry-run.
const TRANSCRIPTS = path.join(USER_SKILLS, 'setup-review', 'transcripts.js');
const PARALLEL = 4;
const ROUTING_FLAGS = ['--disallowedTools', 'Bash Edit Write NotebookEdit Agent Workflow', '--max-budget-usd', '0.5'];

// A clone sharing ROOT's objects, with no remote; `ref` undefined: HEAD plus the working tree's changes.
function cloneTree(ref, withModules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-evals-'));
  const git = (args, opts) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  git(['clone', '-q', '--shared', '--no-checkout', ROOT, dir]);
  git(['-C', dir, 'remote', 'remove', 'origin']);
  git(['-C', dir, 'checkout', '-q', '--detach', ref ?? git(['rev-parse', 'HEAD']).trim()]);
  if (ref === undefined) {
    const diff = git(['diff', '--binary', 'HEAD']);
    if (diff) git(['-C', dir, 'apply', '--whitespace=nowarn'], { input: diff });
    for (const f of git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    }
  }
  // A copy, not a symlink: a dry run may install packages. Reflinked where the filesystem allows.
  if (withModules) execFileSync('cp', ['-a', '--reflink=auto', path.join(ROOT, 'node_modules'), dir]);
  return dir;
}

// Runs `claude -p prompt` in `cwd`; `stop(entry)` returning true ends it early. Resolves to the
// stream's entries (assistant and user turns, the `result`).
function runClaude(cwd, prompt, flags, stop = () => false) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...flags];
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const entries = [];
    let buffer = '';
    let stopped = false;
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines.filter((l) => l.startsWith('{'))) {
        const entry = JSON.parse(line);
        if (stopped || !['assistant', 'user', 'result'].includes(entry.type)) continue;
        entries.push(entry);
        if (stop(entry)) {
          stopped = true;
          child.kill();
        }
      }
    });
    child.on('close', () => resolve(entries));
  });
}

const firstTool = (entry) =>
  entry.type === 'assistant' &&
  (entry.message?.content ?? []).find((c) => c.type === 'tool_use' && c.name !== 'ToolSearch');

// A routing run's entries → the skill its first tool call loaded, or `-` (with the tool, if any).
function routedTo(entries) {
  const tool = entries.map(firstTool).find(Boolean);
  if (tool?.name === 'Skill') return tool.input.skill;
  return tool ? `- (${tool.name})` : '-';
}

// A dry run's entries → `{ cost, turns, minutes, calls, denied, errors }`; `callSummary` (transcripts.js)
// counts the calls.
function dryRunSummary(entries, names, callSummary) {
  const lines = entries.filter((e) => e.type !== 'result').map((e) => JSON.stringify(e));
  const result = entries.find((e) => e.type === 'result') ?? {};
  return {
    cost: result.total_cost_usd ?? 0,
    turns: result.num_turns ?? 0,
    minutes: (result.duration_ms ?? 0) / 60000,
    ...callSummary(lines, names),
  };
}

// Runs `jobs` (async thunks) `limit` at a time, results in order.
async function pool(jobs, limit) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const ref = option('ref');
  const repeat = Number(option('repeat') ?? 1);
  const budget = option('budget') ?? '2';
  const dryRun = args.includes('--dry-run');
  const only = args.filter((a) => !a.startsWith('--'));
  const known = /^--(ref=\S+|repeat=\d+|budget=[\d.]+|dry-run)$/;
  if (args.some((a) => a.startsWith('--') && !known.test(a)) || !(repeat > 0)) {
    console.error('Usage: node scripts/skill-evals.js [--ref=REF] [--repeat=N] [--dry-run] [--budget=USD] [SKILL...]');
    process.exit(1);
  }
  if (dryRun && !fs.existsSync(TRANSCRIPTS)) {
    console.error(`--dry-run needs ${TRANSCRIPTS} (template-CLAUDE.md's user-level skills)`);
    process.exit(1);
  }
  const dir = cloneTree(ref, dryRun);
  try {
    const skillsDirs = [path.join(dir, '.claude', 'skills'), USER_SKILLS];
    const skills = skillsDirs.flatMap((d) =>
      fs.existsSync(d) ? fs.readdirSync(d).map((name) => ({ name, file: path.join(d, name, 'evals.json') })) : [],
    );
    // A user skill shadows a project one of the same name; it is the live one, whatever --ref says.
    const live = skills.filter((s, i) => !skills.slice(i + 1).some((t) => t.name === s.name));
    const names = live.map((s) => s.name);
    if (ref && live.some((s) => s.file.startsWith(USER_SKILLS) && fs.existsSync(s.file)))
      console.log(`User skills are the installed ones, not ${ref}'s: compare them by checking out their own repo.`);
    const evals = live
      .filter(({ name }) => !only.length || only.includes(name))
      .map(({ name, file }) => [name, file])
      .filter(([, file]) => fs.existsSync(file))
      .map(([name, file]) => ({ name, ...JSON.parse(fs.readFileSync(file, 'utf8')) }));
    console.log(`Evaluating ${ref ?? 'the working tree'} (${evals.map((e) => e.name).join(', ')})\n\nRouting:`);
    const cases = evals.flatMap((e) => e.routing.map((c) => ({ skill: e.name, ...c })));
    const got = await pool(
      cases.flatMap((c) =>
        Array.from({ length: repeat }, () => () => runClaude(dir, c.prompt, ROUTING_FLAGS, firstTool).then(routedTo)),
      ),
      PARALLEL,
    );
    let passed = 0;
    const routing = {};
    cases.forEach((c, i) => {
      const runs = got.slice(i * repeat, (i + 1) * repeat);
      const ok = runs.filter((r) => r === c.expect || (c.expect === '-' && r.startsWith('-'))).length;
      passed += ok;
      routing[c.skill] = (routing[c.skill] ?? 0) + ok;
      console.log(`  ${ok === repeat ? '✓' : '✗'} ${c.skill}: "${c.prompt}" → ${runs.join(', ')} (want ${c.expect})`);
    });
    const previous = history('evals').findLast((r) => r.cases === cases.length && r.repeat === repeat);
    console.log(
      `  ${passed}/${cases.length * repeat} routed as expected${previous ? ` (last comparable run, ${previous.at.slice(0, 10)}: ${previous.passed})` : ''}`,
    );
    // Per skill, passed runs out of cases × repeat, so a later run shows a routing regression.
    const row = { ref: ref ?? 'working tree', repeat, routing, cases: cases.length, passed };
    if (!dryRun) return record('evals', row);
    const { callSummary } = require(TRANSCRIPTS);
    row.dryRuns = {};
    console.log('\nDry runs:');
    for (const e of evals.filter((e) => e.dryRun)) {
      // `auto`, as in an interactive session: the classifier's denials are part of what's measured.
      const entries = await runClaude(dir, e.dryRun, ['--permission-mode', 'auto', '--max-budget-usd', budget]);
      const s = dryRunSummary(entries, names, callSummary);
      console.log(
        `  ${e.dryRun}: $${s.cost.toFixed(2)} · ${s.minutes.toFixed(1)} min · ${s.turns} turns · ${s.calls} calls · ${s.denied} denied · ${s.errors.length} failed`,
      );
      for (const error of s.errors) console.log(`    ✗ ${error}`);
      row.dryRuns[e.name] = { cost: s.cost, minutes: s.minutes, denied: s.denied, failed: s.errors.length };
    }
    record('evals', row);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { routedTo, dryRunSummary, pool };
