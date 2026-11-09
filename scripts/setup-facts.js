'use strict';

// Facts for the setup-review skill.
//   node scripts/setup-facts.js                    each script's callers (tests and the changelog excluded —
//                                                  a script only they mention has no caller), and which read
//                                                  arguments without printing a usage line
//   node scripts/setup-facts.js --cost             time and output size of the gates an agent runs, and each
//                                                  gate's change since the last run, and the check runs (hooks
//                                                  included) since then: blocked commits, timings (scripts/dev-metrics.js)
//   node scripts/setup-facts.js --transcripts[=N|=DATE]  the last N (default 20) sessions', or everything
//                                                  after DATE's, largest outputs, slowest calls, repeated command
//                                                  pairs, denied and rejected calls, the newest entry read and,
//                                                  after DATE, commits made against git commit calls read;
//                                                  commands are reduced to their first words, so no arguments
//                                                  (or secrets) print; then interrupts and how the user answered
//                                                  each skill's questions
//     --digest=DIR                                 also writes one file per session to DIR: prompts, the last
//                                                  paragraph of the reply before each, skill runs, failed calls, interrupts, rejections
//                                                  with the user's reason, questions and answers — long tokens
//                                                  redacted, for the reader judging them
//                                                  and which docs were read, how often whole
//   node scripts/setup-facts.js --agents[=ID]      per subagent of session ID (default: the newest with any):
//                                                  time, turns, cache reads, failed calls, time in tests/e2e/commits, all tool time and its top commands

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { record, history } = require('./dev-metrics');
const backlogRuns = require('./backlog-run-log');
const { describeRun } = require('./e2e-flakes');

const ROOT = path.join(__dirname, '..');
const COST_SCRIPTS = ['check', 'test', 'test:e2e', 'build'];
const TOP = 10;

// `files`: [relPath, text] pairs; a script is called as `scripts/<name>(.js)` or `./<name>(.js)`.
function callers(name, files) {
  const ref = new RegExp(`(?:scripts/|\\./)${name}(?:\\.js)?(?![\\w-])`);
  return files
    .filter(([file, text]) => file !== `scripts/${name}.js` && !file.startsWith('test/') && ref.test(text))
    .map(([file]) => file);
}

function argsWithoutUsage(source) {
  return source.includes('process.argv') && !source.includes('Usage');
}

const TOOLS = ['npm', 'npx', 'git', 'node', 'gh'];

// Commands whose time is the gates' (tests, e2e, commit hooks), not the agent's thinking.
const GATE = /^(npm test|npm run test(:one|:e2e)?|node scripts\/e2e\.js|git commit)$/;

// `cd x && FOO=1 npm run test:one a.js | tail` → `npm run test:one`. A chain is keyed by its gate if it
// has one, where its time goes: `git add a && git commit && git log` → `git commit` (and its hook).
function commandKey(command) {
  const keys = command
    .split(/&&|\|\||[|;\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^cd\s/.test(s))
    .map((segment) => {
      // Env assignments, `time`, and the options naming a directory (`git -C <dir>`, `npm --prefix <dir>`) say nothing.
      const words = segment
        .split(/\s+/)
        .filter((w, i) => !/^\w+=/.test(w) && !(i === 0 && w === 'time'))
        .filter((w, i, all) => !['-C', '--prefix'].includes(w) && !['-C', '--prefix'].includes(all[i - 1]));
      const [cmd, sub, ...rest] = words;
      if (!TOOLS.includes(cmd)) return cmd ?? '';
      return [cmd, sub, sub === 'run' ? rest.find((w) => !w.startsWith('-')) : undefined].filter(Boolean).join(' ');
    });
  return keys.find((k) => GATE.test(k)) ?? keys[0] ?? '';
}

const text = (content) => (typeof content === 'string' ? content : (content ?? []).map((c) => c.text ?? '').join(''));

// One session's JSONL lines → its tool calls, in order: `{ key, bytes, ms, error, denied, rejected }`.
function parseSession(lines) {
  const calls = new Map();
  for (const line of lines) {
    const entry = JSON.parse(line);
    // These replay earlier calls and results without a timestamp; they'd overwrite the timings with NaN.
    if (entry.type === 'api-request-blob') continue;
    for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (part.type === 'tool_use') {
        const key = part.name === 'Bash' ? commandKey(part.input.command ?? '') : part.name;
        calls.set(part.id, { key, start: Date.parse(entry.timestamp) });
      } else if (part.type === 'tool_result' && calls.has(part.tool_use_id)) {
        const call = calls.get(part.tool_use_id);
        const out = text(part.content);
        Object.assign(call, {
          bytes: out.length,
          ms: Date.parse(entry.timestamp) - call.start,
          error: Boolean(part.is_error),
          denied: Boolean(part.is_error) && /^Permission for this action was denied/.test(out),
          rejected: Boolean(part.is_error) && /^The user doesn't want to proceed/.test(out),
        });
      }
    }
  }
  return [...calls.values()].filter((c) => c.bytes !== undefined).map(({ start, ...c }) => c);
}

// `sessions`: parseSession results.
function commitCalls(sessions) {
  return sessions.flat().filter((c) => c.key === 'git commit' && !c.error).length;
}

// A user turn that is a prompt, not a tool result, a slash command's echo, a background task's
// notification or a loaded skill's text.
function isPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return !/^\s*<(command|local-command|task-notification)\b/.test(content);
  return (
    Array.isArray(content) &&
    content.every((c) => c.type === 'text') &&
    !content.some((c) => c.text.startsWith('Base directory for this skill'))
  );
}

// Parsed entries → tokens their responses read (`input`: uncached, cache writes and cache reads) and
// wrote (`output`). A response spans several entries, each repeating its usage so far: the max per id counts.
function tokens(entries) {
  const byId = new Map();
  for (const e of entries) {
    const u = e.type === 'assistant' && e.message?.id && e.message.usage;
    if (!u) continue;
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const seen = byId.get(e.message.id) ?? { input: 0, output: 0 };
    byId.set(e.message.id, { input: Math.max(seen.input, input), output: Math.max(seen.output, u.output_tokens ?? 0) });
  }
  return [...byId.values()].reduce((sum, t) => ({ input: sum.input + t.input, output: sum.output + t.output }), {
    input: 0,
    output: 0,
  });
}

// One session's JSONL lines → each run of a skill in `names`, by `/name` or the Skill tool:
// `{ skill, ms, tokens }`, running to the next prompt (or the session's end); tokens of the main thread only.
function skillRuns(lines, names) {
  // Replayed calls have no timestamp (see parseSession): a run started from one would last NaN.
  const entries = lines.map((line) => JSON.parse(line)).filter((entry) => entry.type !== 'api-request-blob');
  const runs = [];
  entries.forEach((entry, i) => {
    const content = entry.message?.content;
    const skill =
      typeof content === 'string'
        ? content.match(/<command-name>\/([\w:-]+)<\/command-name>/)?.[1]
        : (Array.isArray(content) ? content : []).find((c) => c.type === 'tool_use' && c.name === 'Skill')?.input
            ?.skill;
    if (!names.includes(skill)) return;
    const end = entries.slice(i + 1).find(isPrompt) ?? entries.findLast((e) => e.timestamp);
    runs.push({
      skill,
      ms: Date.parse(end.timestamp) - Date.parse(entry.timestamp),
      tokens: tokens(entries.slice(i, entries.indexOf(end) + 1)),
    });
  });
  return runs;
}

// One transcript's JSONL lines → the skills in `names` whose SKILL.md a Read call or a shell read opened:
// a lane agent told to follow a skill reads it without starting it.
function skillReads(lines, names) {
  const read = new Set();
  for (const line of lines) {
    const content = JSON.parse(line).message?.content;
    for (const part of Array.isArray(content) ? content : []) {
      if (part.type !== 'tool_use') continue;
      const target =
        part.name === 'Read'
          ? part.input.file_path
          : part.name === 'Bash' && READER.test(part.input.command ?? '')
            ? part.input.command
            : '';
      for (const [, name] of (target ?? '').matchAll(/\.claude\/skills\/([\w-]+)\/SKILL\.md/g))
        if (names.includes(name)) read.add(name);
    }
  }
  return read;
}

// One line, long tokens (keys, hashes) redacted, cut at `max` characters.
function clip(value, max) {
  const flat = value
    .replace(/[\w+/=-]{24,}/g, '[…]')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Whether a reply ends in a prose question or offer shows only in its last paragraph.
const lastParagraph = (reply) =>
  reply
    .trim()
    .split(/\n\s*\n/)
    .at(-1);

// A question about the Claude Code setup, by its text and option labels (descriptions mention scripts too often).
const SETUP = /CLAUDE\.md|SKILL\.md|settings(\.local)?\.json|scripts\/|\b(skill|hook|memory)s?\b/i;

// One AskUserQuestion question and its answer → `recommended` (the first option, or the one marked so),
// `other` (another option), `own` (free text) or `clarify`/`dismissed` when the user rejected the call.
function answerOutcome(question, answer, rejection) {
  if (rejection !== undefined) return /clarify/.test(rejection) ? 'clarify' : 'dismissed';
  const labels = question.options.map((o) => o.label);
  const recommended = labels.find((l) => /\(Recommended\)/.test(l)) ?? labels[0];
  if (answer === recommended) return 'recommended';
  return answer.split(', ').every((a) => labels.includes(a)) ? 'other' : 'own';
}

// One session's JSONL lines → what a reader needs for judgment, in order: `{ kind, … }` with kind
// `prompt` (`text`, `reply`: the last assistant text before it), `skill`, `error` (`key`, `text`),
// `interrupt` (`key`: the call before it, `skill`: the one running), `rejected` (`key`, `reason`) or `answer` (`skill`: the
// one running, `question`, `answer`, `outcome`, `setup`: it proposes a setup change).
function sessionEvents(lines, names) {
  const events = [];
  const calls = new Map();
  let reply = '';
  let skill;
  let lastKey;
  for (const line of lines) {
    const entry = JSON.parse(line);
    const content = entry.message?.content;
    const started = typeof content === 'string' && content.match(/<command-name>\/([\w:-]+)<\/command-name>/)?.[1];
    if (names.includes(started)) events.push({ kind: 'skill', skill: (skill = started) });
    else if (isPrompt(entry)) {
      const prompt = text(content);
      if (prompt.startsWith('[Request interrupted by user')) events.push({ kind: 'interrupt', key: lastKey, skill });
      else {
        skill = undefined;
        events.push({ kind: 'prompt', text: clip(prompt, 500), reply: clip(lastParagraph(reply), 600) });
      }
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (entry.type === 'assistant' && part.type === 'text' && part.text.trim()) reply = part.text;
      if (part.type === 'tool_use') {
        const key = part.name === 'Bash' ? commandKey(part.input.command ?? '') : part.name;
        calls.set(part.id, { key, input: part.input });
        if (part.name === 'Skill' && names.includes(part.input.skill))
          events.push({ kind: 'skill', skill: (skill = part.input.skill) });
      }
      if (part.type !== 'tool_result' || !calls.has(part.tool_use_id)) continue;
      const { key, input } = calls.get(part.tool_use_id);
      lastKey = key;
      const out = text(part.content);
      const rejection = /^The user doesn't want to proceed/.test(out)
        ? (out.split('the user said:\n')[1] ?? '').split('\n\nNote')[0]
        : undefined;
      if (key === 'AskUserQuestion' && (rejection !== undefined || !part.is_error)) {
        const answers = entry.toolUseResult?.answers ?? {};
        for (const question of input.questions ?? [])
          events.push({
            kind: 'answer',
            skill,
            question: clip(question.question, 200),
            answer: clip(answers[question.question] ?? '', 200),
            outcome: answerOutcome(question, answers[question.question] ?? '', rejection),
            setup: SETUP.test([question.question, ...question.options.map((o) => o.label)].join(' ')),
          });
      } else if (rejection !== undefined) events.push({ kind: 'rejected', key, reason: clip(rejection, 300) });
      else if (part.is_error && !/^Permission for this action was denied/.test(out))
        events.push({ kind: 'error', key, text: clip(out.split('\n').find((l) => l.trim()) ?? '', 150) });
    }
  }
  return events;
}

// A digest file's text for `sessionEvents`' output.
function digest(events) {
  const show = {
    prompt: (e) => `${e.reply ? `  (agent: ${e.reply})\n` : ''}> ${e.text}`,
    skill: (e) => `== skill ${e.skill}`,
    error: (e) => `  ✗ ${e.key}: ${e.text}`,
    interrupt: (e) => `  ⏹ interrupted after ${e.key ?? 'a reply'}`,
    rejected: (e) => `  ⊘ rejected ${e.key}${e.reason ? `: ${e.reason}` : ''}`,
    answer: (e) => `  ? [${e.outcome}${e.setup ? ', setup' : ''}] ${e.question} → ${e.answer}`,
  };
  return events.map((e) => show[e.kind](e)).join('\n') + '\n';
}

// Per running skill (or `-`): how the user answered its questions, setup proposals counted apart.
function answerStats(sessions) {
  const stats = new Map();
  for (const e of sessions.flat().filter((e) => e.kind === 'answer')) {
    const name = e.setup ? `${e.skill ?? '-'} (setup proposals)` : (e.skill ?? '-');
    const s = stats.get(name) ?? { name, recommended: 0, other: 0, own: 0, clarify: 0, dismissed: 0 };
    s[e.outcome]++;
    stats.set(name, s);
  }
  return [...stats.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Shell commands that only read or inspect, and tools (capitalized or MCP): a pair with one of them is
// exploring or editing, not a procedure to script.
const READS = new Set(['grep', 'rg', 'sed', 'cat', 'head', 'tail', 'ls', 'find', 'wc', 'awk', 'python3', 'jq', 'echo']);
const isCommand = (key) => !/^[A-Z]|^mcp__/.test(key) && !READS.has(key);

// `sessions`: arrays of parseSession's calls.
function summarize(sessions) {
  const byKey = new Map();
  const pairs = new Map();
  sessions.forEach((calls, session) => {
    calls.forEach((call, i) => {
      const s = byKey.get(call.key) ?? {
        key: call.key,
        count: 0,
        bytes: 0,
        maxBytes: 0,
        maxMs: 0,
        denied: 0,
        rejected: 0,
      };
      s.count++;
      s.bytes += call.bytes;
      s.maxBytes = Math.max(s.maxBytes, call.bytes);
      s.maxMs = Math.max(s.maxMs, call.ms);
      s.denied += call.denied ? 1 : 0;
      s.rejected += call.rejected ? 1 : 0;
      byKey.set(call.key, s);
      const next = calls[i + 1];
      if (next && next.key !== call.key) {
        const pair = `${call.key} → ${next.key}`;
        const p = pairs.get(pair) ?? { pair, count: 0, sessions: new Set() };
        p.count++;
        p.sessions.add(session);
        pairs.set(pair, p);
      }
    });
  });
  const keys = [...byKey.values()];
  const top = (list, by) => [...list].sort((a, b) => by(b) - by(a)).slice(0, TOP);
  return {
    output: top(keys, (k) => k.bytes),
    slow: top(
      keys.filter((k) => k.key !== 'AskUserQuestion'), // its time is the user's answer
      (k) => k.maxMs,
    ),
    pairs: top(
      [...pairs.values()].filter((p) => p.sessions.size >= 2 && p.pair.split(' → ').every(isCommand)),
      (p) => p.sessions.size * 1000 + p.count,
    ).map((p) => ({ pair: p.pair, count: p.count, sessions: p.sessions.size })),
    denied: keys
      .filter((k) => k.denied || k.rejected)
      .map((k) => ({ key: k.key, denied: k.denied, rejected: k.rejected })),
  };
}

// A repo doc a Read call or a shell read (cat, sed, head, tail) opened: CLAUDE.md, README.md or under docs/;
// not ~/.claude/CLAUDE.md.
const DOC = /(?:^|[\s"']|(?<!\.claude)\/)((?:docs\/[\w/-]+|README|CLAUDE)\.md)\b/g;
// A heredoc's body (a commit message, an edit script) names docs without reading them; the rest of its line stays.
const READER = /^(?:(?:do|then)\s+)?(cat|sed|head|tail)\b/;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

// One session's JSONL lines → `{ doc, whole }` per doc opened, `whole` unless the read was narrowed (a Read
// offset or limit, or sed/head/tail rather than cat).
function docReads(lines) {
  const reads = [];
  for (const line of lines)
    for (const part of [JSON.parse(line).message?.content].flat()) {
      if (part?.type !== 'tool_use') continue;
      const { file_path: file, offset, limit, command } = part.input ?? {};
      if (part.name === 'Read')
        for (const [, doc] of ` ${file ?? ''}`.matchAll(DOC))
          reads.push({ doc, whole: offset === undefined && limit === undefined });
      if (part.name !== 'Bash') continue;
      // Only a reader's own arguments, or a `for … in` list a reader goes through, not a grep's or wc's.
      const segments = (command ?? '').replace(HEREDOC, '$3').split(/&&|\|\||[;|\n]/);
      const readers = segments.map((seg) => seg.trim().match(READER)?.[1]);
      segments.forEach((seg, i) => {
        const loop = /^\s*for\s+\w+\s+in\b/.test(seg) && readers.find(Boolean);
        for (const [, doc] of readers[i] || loop ? seg.matchAll(DOC) : [])
          reads.push({ doc, whole: (readers[i] ?? loop) === 'cat' });
      });
    }
  return reads;
}

// `sessions`: arrays of docReads' reads → per doc, `{ doc, reads, whole, sessions }`, most read first.
function docReadStats(sessions) {
  const stats = new Map();
  sessions.forEach((reads, session) => {
    for (const { doc, whole } of reads) {
      const s = stats.get(doc) ?? { doc, reads: 0, whole: 0, sessions: new Set() };
      s.reads++;
      s.whole += whole ? 1 : 0;
      s.sessions.add(session);
      stats.set(doc, s);
    }
  });
  return [...stats.values()]
    .map((s) => ({ ...s, sessions: s.sessions.size }))
    .sort((a, b) => b.reads - a.reads || a.doc.localeCompare(b.doc));
}

// One subagent's JSONL lines → `{ minutes, turns, cacheRead, calls, errors, gateSec, toolSec, topTools }`. A response
// spans several lines, each repeating its usage so far, so each field's max per message id counts.
function agentSummary(lines) {
  const entries = lines.map((line) => JSON.parse(line));
  const stamps = entries.filter((e) => e.timestamp).map((e) => Date.parse(e.timestamp));
  const cache = new Map();
  for (const e of entries)
    if (e.type === 'assistant' && e.message?.id)
      cache.set(e.message.id, Math.max(cache.get(e.message.id) ?? 0, e.message.usage?.cache_read_input_tokens ?? 0));
  const calls = parseSession(lines);
  const byKey = new Map();
  for (const c of calls) byKey.set(c.key, (byKey.get(c.key) ?? 0) + c.ms / 1000);
  return {
    minutes: stamps.length ? (Math.max(...stamps) - Math.min(...stamps)) / 60000 : 0,
    turns: cache.size,
    cacheRead: [...cache.values()].reduce((a, b) => a + b, 0),
    calls: calls.length,
    errors: calls.filter((c) => c.error).length,
    gateSec: calls.filter((c) => GATE.test(c.key)).reduce((s, c) => s + c.ms, 0) / 1000,
    toolSec: calls.reduce((s, c) => s + c.ms, 0) / 1000,
    topTools: [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

function agents(sessionId) {
  const dir = path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[^\w]/g, '-'));
  const withAgents = fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'subagents')))
    .sort(
      (a, b) =>
        fs.statSync(path.join(dir, b, 'subagents')).mtimeMs - fs.statSync(path.join(dir, a, 'subagents')).mtimeMs,
    );
  const session = sessionId ?? withAgents[0];
  if (!session || !withAgents.includes(session)) throw new Error(`no subagents for session ${session ?? '(none)'}`);
  const sub = path.join(dir, session, 'subagents');
  for (const file of fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl'))) {
    const metaFile = path.join(sub, file.replace(/\.jsonl$/, '.meta.json'));
    const label = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')).description : file;
    const s = agentSummary(fs.readFileSync(path.join(sub, file), 'utf8').split('\n').filter(Boolean));
    const pct = (sec) => (s.minutes ? Math.round((sec / 60 / s.minutes) * 100) : 0);
    const top = s.topTools.map(([key, sec]) => `${key} ${Math.round(sec)} s`).join(', ');
    console.log(
      `${label}: ${s.minutes.toFixed(1)} min · ${s.turns} turns · ${(s.cacheRead / 1e6).toFixed(1)}M cache read · ${s.calls} calls (${s.errors} failed) · gates ${Math.round(s.gateSec)} s (${pct(s.gateSec)}%) · tools ${Math.round(s.toolSec)} s (${pct(s.toolSec)}%: ${top})`,
    );
  }
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const mtok = (t) => `${(t.input / 1e6).toFixed(1)}M in / ${(t.output / 1e3).toFixed(0)}K out`;

function cost() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(`CLAUDE.md (loaded every turn): ${kb(fs.statSync(path.join(ROOT, 'CLAUDE.md')).size)}`);
  const docs = fs
    .readdirSync(path.join(ROOT, 'docs'), { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .map((f) => [`docs/${f.split(path.sep).join('/')}`, fs.statSync(path.join(ROOT, 'docs', f)).size])
    .sort((a, b) => b[1] - a[1]);
  console.log(
    `Largest docs: ${docs
      .slice(0, 5)
      .map(([f, size]) => `${f} ${kb(size)}`)
      .join(', ')}`,
  );
  const last = history('cost').at(-1);
  const seconds = {};
  for (const script of COST_SCRIPTS) {
    const start = Date.now();
    const { status, stdout, stderr } = spawnSync(npm, ['run', '-s', script], { cwd: ROOT, encoding: 'utf8' });
    const run = { seconds: Number(((Date.now() - start) / 1000).toFixed(1)), out: stdout + stderr, status };
    console.log(costLine(script, run, last));
    if (!status) seconds[script] = run.seconds;
  }
  record('cost', { seconds });
  const since = last?.at ?? '';
  console.log(
    `Check runs${since ? ` since ${since.slice(0, 10)}` : ''} (scripts/check.js): ${checkStats(history('checks').filter((r) => r.at > since))}`,
  );
  console.log(backlogRuns.summary(history('backlog-run'), history('backlog-escape'), history('checks')));
  console.log(
    `Hook e2e runs since ${since.slice(0, 10) || 'ever'} (scripts/e2e.js): ${e2eRunStats(history('e2e-runs').filter((r) => r.at > since))}`,
  );
  const flakes = history('flakes').at(-1);
  if (flakes) console.log(`Last e2e flake measure (scripts/e2e-flakes.js): ${describeRun(flakes)}`);
}

// Check runs → `12 commits (2 blocked: lint ×2), median 3.1 s, slowest step e2e 18.0 s · 3 full runs (0 failed)`.
function checkStats(rows) {
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const total = (r) => Math.max(0, ...Object.values(r.seconds)); // steps run in parallel
  const part = (run, label) => {
    const mine = rows.filter((r) => r.run === run);
    const failed = mine.filter((r) => r.failed.length);
    const counts = new Map();
    for (const name of failed.flatMap((r) => r.failed)) counts.set(name, (counts.get(name) ?? 0) + 1);
    const why = [...counts].map(([name, n]) => `${name} ×${n}`).join(', ');
    const slowest = mine.flatMap((r) => Object.entries(r.seconds)).sort((a, b) => b[1] - a[1])[0];
    return `${mine.length} ${label} (${failed.length} ${run === 'commit' ? 'blocked' : 'failed'}${why ? `: ${why}` : ''})${mine.length ? `, median ${median(mine.map(total))} s, slowest step ${slowest[0]} ${slowest[1]} s` : ''}`;
  };
  return `${part('commit', 'commits')} · ${part('full', 'full runs')}`;
}

// Hook e2e runs, by projects asked → which ran: `desktop+phone ×3: phone 2, skipped 1 · desktop ×5: desktop 5`.
function e2eRunStats(rows) {
  const groups = Map.groupBy(rows, (r) => r.asked.join('+'));
  if (!groups.size) return 'none';
  return [...groups]
    .map(([asked, runs]) => {
      const counts = Map.groupBy(runs, (r) => r.ran.join('+') || 'skipped');
      return `${asked} ×${runs.length}: ${[...counts].map(([ran, rs]) => `${ran} ${rs.length}`).join(', ')}`;
    })
    .join(' · ');
}

// A failed run (e.g. e2e's port taken by another checkout) is no baseline: it isn't recorded or compared.
function costLine(script, { seconds, out, status }, last) {
  const size = `${seconds} s, ${kb(out.length)}, ${out.split('\n').length} lines`;
  if (status) return `npm run ${script}: ${size}, exit ${status}, not recorded`;
  return `npm run ${script}: ${size}${costDelta(last?.seconds[script], seconds, last?.at)}`;
}

// ` (+30% since 2026-10-12) ⚠` against the last --cost run; ⚠ past SLOWER.
const SLOWER = 0.25;
function costDelta(before, now, at) {
  if (!before) return '';
  const change = (now - before) / before;
  return ` (${change >= 0 ? '+' : ''}${Math.round(change * 100)}% since ${at.slice(0, 10)})${change > SLOWER ? ' ⚠' : ''}`;
}

// A session's JSONL lines after `since` (ms); lines without a timestamp stay with their neighbours.
function linesSince(lines, since) {
  return lines.filter((line) => {
    const t = JSON.parse(line).timestamp;
    return !t || Date.parse(t) > since;
  });
}

// `{ limit }` or `{ since }` (ms): the newest `limit` sessions, or every entry after `since`.
function transcripts({ limit, since }, digestDir) {
  const dir = path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[^\w]/g, '-'));
  const sorted = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const files = since === undefined ? sorted.slice(0, limit) : sorted.filter((f) => fs.statSync(f).mtimeMs > since);
  const read = files
    .map((f) => [path.basename(f, '.jsonl'), fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)])
    .map(([id, lines]) => [id, since === undefined ? lines : linesSince(lines, since)])
    .filter(([, lines]) => lines.length);
  const logs = read.map(([, lines]) => lines);
  const sessions = logs.map(parseSession);
  const newest = logs
    .flat()
    .reduce((max, line) => Math.max(max, Date.parse(JSON.parse(line).timestamp ?? '') || 0), since ?? 0);
  const names = fs.readdirSync(path.join(ROOT, '.claude', 'skills'));
  const events = logs.map((lines) => sessionEvents(lines, names));
  if (digestDir) {
    fs.mkdirSync(digestDir, { recursive: true });
    read.forEach(([id], i) => fs.writeFileSync(path.join(digestDir, `${id}.txt`), digest(events[i])));
  }
  const { output, slow, pairs, denied } = summarize(sessions);
  const total = tokens(logs.flat().map((line) => JSON.parse(line)));
  console.log(
    `${logs.length} sessions, ${sessions.flat().length} tool calls, ${mtok(total)} (main threads), newest entry ${newest ? new Date(newest).toISOString() : 'none'}`,
  );
  if (since !== undefined) {
    // Commits far above the commit calls mean sessions held elsewhere (another machine, the web) went unread.
    const commits = execFileSync('git', ['rev-list', '--count', `--since=${new Date(since).toISOString()}`, 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    console.log(`Commits since then: ${commits} · git commit calls read: ${commitCalls(sessions)}`);
  }
  console.log('\nLargest output (total · max · calls):');
  for (const k of output) console.log(`  ${k.key}: ${kb(k.bytes)} · ${kb(k.maxBytes)} · ${k.count}`);
  console.log('\nSlowest call (elapsed, including any permission wait):');
  for (const k of slow) console.log(`  ${k.key}: ${(k.maxMs / 1000).toFixed(0)} s`);
  console.log('\nCommand pairs repeated across sessions (sessions · times):');
  for (const p of pairs) console.log(`  ${p.pair}: ${p.sessions} · ${p.count}`);
  console.log('\nDenied by the permission classifier · rejected by the user:');
  for (const d of denied) console.log(`  ${d.key}: ${d.denied} · ${d.rejected}`);
  // Subagents act on the session's behalf, so their transcripts count for skills followed and docs read.
  const subagentLogs = read.map(([id]) => {
    const sub = path.join(dir, id, 'subagents');
    return fs.existsSync(sub)
      ? fs
          .readdirSync(sub)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => fs.readFileSync(path.join(sub, f), 'utf8').split('\n').filter(Boolean))
      : [];
  });
  console.log(
    '\nSkill runs (runs · sessions · longest run to the next prompt · tokens, main thread · interrupts · sessions whose subagents read its SKILL.md):',
  );
  const runs = logs.map((lines) => skillRuns(lines, names));
  const followed = subagentLogs.map((agents) => new Set(agents.flatMap((lines) => [...skillReads(lines, names)])));
  const interrupts = events.flat().filter((e) => e.kind === 'interrupt');
  for (const name of names) {
    const mine = runs.map((r) => r.filter((run) => run.skill === name));
    const all = mine.flat();
    const longest = all.length ? `${Math.round(Math.max(...all.map((r) => r.ms)) / 60000)} min` : 'never run';
    const used = all.reduce((sum, r) => ({ input: sum.input + r.tokens.input, output: sum.output + r.tokens.output }), {
      input: 0,
      output: 0,
    });
    console.log(
      `  ${name}: ${all.length} · ${mine.filter((r) => r.length).length} · ${longest} · ${mtok(used)} · ${interrupts.filter((e) => e.skill === name).length} · ${followed.filter((s) => s.has(name)).length}`,
    );
  }
  console.log(
    `\nInterrupts: ${interrupts.length} (${interrupts.filter((e) => !e.skill).length} outside a skill) in ${events.filter((s) => s.some((e) => e.kind === 'interrupt')).length} sessions`,
  );
  console.log(
    '\nQuestions by running skill (recommended taken · other option · own answer · asked to clarify · dismissed):',
  );
  for (const s of answerStats(events))
    console.log(`  ${s.name}: ${s.recommended} · ${s.other} · ${s.own} · ${s.clarify} · ${s.dismissed}`);
  console.log('\nDocs read (reads · whole · transcripts, subagents counted apart):');
  const existing = (d) => fs.existsSync(path.join(ROOT, d.doc)); // not a test fixture's made-up path
  for (const d of docReadStats([...logs, ...subagentLogs.flat()].map(docReads)).filter(existing))
    console.log(`  ${d.doc}: ${d.reads} · ${d.whole} · ${d.sessions}`);
  if (digestDir) console.log(`\nDigests: ${read.length} files in ${digestDir}`);
}

function scripts() {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('docs/images/') && !['package-lock.json', 'CHANGELOG.md'].includes(f))
    .map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
  for (const [file, source] of files.filter(([f]) => /^scripts\/[^/]+\.js$/.test(f))) {
    const name = path.basename(file, '.js');
    const by = callers(name, files);
    const notes = [by.length ? `called by ${by.join(', ')}` : 'NO CALLER'];
    if (argsWithoutUsage(source)) notes.push('reads arguments, no usage line');
    console.log(`${name}: ${notes.join('; ')}`);
  }
}

if (require.main === module) {
  const [flag, ...more] = process.argv.slice(2);
  const digestDir = flag?.startsWith('--transcripts')
    ? more.find((a) => a.startsWith('--digest='))?.slice(9)
    : undefined;
  const rest = more.filter((a) => digestDir === undefined || a !== `--digest=${digestDir}`);
  const value = flag?.startsWith('--transcripts') ? (flag.split('=')[1] ?? '20') : '20';
  const range = /^\d+$/.test(value) ? { limit: Number(value) } : { since: Date.parse(value) };
  if (
    rest.length ||
    (flag && !/^--(cost|transcripts(=[\w:.+-]+)?|agents(=[\w-]+)?)$/.test(flag)) ||
    !(range.limit > 0 || range.since > 0)
  ) {
    console.error(
      'Usage: node scripts/setup-facts.js [--cost | --transcripts[=N|=DATE] [--digest=DIR] | --agents[=SESSION_ID]]',
    );
    process.exit(1);
  }
  if (flag?.startsWith('--agents')) {
    try {
      agents(flag.split('=')[1]);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  } else if (flag === '--cost') cost();
  else if (flag?.startsWith('--transcripts')) transcripts(range, digestDir);
  else scripts();
}

module.exports = {
  callers,
  argsWithoutUsage,
  commandKey,
  costDelta,
  costLine,
  checkStats,
  e2eRunStats,
  parseSession,
  commitCalls,
  linesSince,
  tokens,
  skillRuns,
  skillReads,
  answerOutcome,
  sessionEvents,
  digest,
  answerStats,
  summarize,
  agentSummary,
  docReads,
  docReadStats,
};
