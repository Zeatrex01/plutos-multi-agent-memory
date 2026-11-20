// Codex in the token ledger (lib/codex-usage.mjs, merged by lib/usage.mjs). Hermetic: synthetic
// ~/.codex/sessions and ~/.claude/projects under a temp HOME, never this machine's real records.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-codex-usage-'));
process.env.HOME = process.env.USERPROFILE = tmp;
const { readCodexSession, codexFiles, normalize } = await import('../lib/codex-usage.mjs');
const usage = await import('../lib/usage.mjs');

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}

const sessions = path.join(tmp, '.codex', 'sessions');
const today = new Date();
const dayDir = (daysAgo) => {
    const d = new Date(today.getTime() - daysAgo * 86400000);
    const p = path.join(sessions, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    fs.mkdirSync(p, { recursive: true });
    return p;
};
const U = (input, cached, out, reasoning, write = 0) => ({
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
    output_tokens: out, reasoning_output_tokens: reasoning, total_tokens: input + out
});
const meta = (id, cwd) => JSON.stringify({ timestamp: '2026-11-20T10:00:00Z', type: 'session_meta', payload: { id, cwd, base_instructions: { text: 'x'.repeat(5000) } } });
const turn = (model) => JSON.stringify({ timestamp: '2026-11-20T10:00:01Z', type: 'turn_context', payload: { model } });
const rec = (rid, u, ts) => JSON.stringify({ timestamp: ts, type: 'token_usage_record', payload: { response_id: rid, usage: u } });
const count = (total, ts) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });
const write = (dir, name, lines) => { const f = path.join(dir, name); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };

const mine = path.join(tmp, 'work', 'mine');

// records + the cumulative counts that repeat them: counted once, from the records
const both = write(dayDir(0), 'rollout-a.jsonl', [
    meta('sess-both', mine), turn('gpt-6.1-sol'),
    rec('r1', U(1000, 800, 100, 30), '2026-11-20T10:00:02Z'), count(U(1000, 800, 100, 30), '2026-11-20T10:00:03Z'),
    rec('r2', U(2000, 1500, 200, 50), '2026-11-20T10:00:04Z'), count(U(3000, 2300, 300, 80), '2026-11-20T10:00:05Z'),
    rec('r2', U(2000, 1500, 200, 50), '2026-11-20T10:00:06Z')   // a repeated response id is not counted twice
]);
// token_count only (no records): the last cumulative total
const countOnly = write(dayDir(0), 'rollout-b.jsonl', [
    meta('sess-count', mine), turn('gpt-6.1-sol'),
    count(U(500, 100, 40, 10), '2026-11-20T11:00:00Z'), count(U(900, 300, 90, 20), '2026-11-20T11:05:00Z')
]);
// someone else's project
write(dayDir(0), 'rollout-c.jsonl', [
    meta('sess-other', path.join(tmp, 'work', 'theirs')), turn('gpt-6.1-sol'),
    rec('x1', U(9000, 0, 9000, 0), '2026-11-20T12:00:00Z')
]);
// an old day, outside the default window
write(dayDir(400), 'rollout-old.jsonl', [
    meta('sess-old', mine), turn('gpt-old'), rec('o1', U(10, 0, 10, 0), '2025-10-16T10:00:00Z')
]);

check('field mapping: cache split from input, reasoning split from output', () => {
    const n = normalize(U(1000, 800, 100, 30, 50));
    assert.equal(n.input_tokens, 150);
    assert.equal(n.cache_read_input_tokens, 800);
    assert.equal(n.cache_creation_input_tokens, 50);
    assert.equal(n.output_tokens, 70);
    assert.equal(n.output_tokens_details.thinking_tokens, 30);
    assert.equal(n.output_tokens + n.output_tokens_details.thinking_tokens, 100);   // = Codex output_tokens, not 130
});
check('records present: summed per response, repeated response id and counts ignored', () => {
    const s = readCodexSession(both);
    assert.equal(s.sessionId, 'sess-both');
    assert.equal(s.cwd, mine);
    assert.equal(s.entries.length, 2);
    assert.equal(s.entries.reduce((a, e) => a + e.usage.output_tokens + e.usage.output_tokens_details.thinking_tokens, 0), 300);
    assert.equal(s.entries[0].model, 'gpt-6.1-sol');
    assert.equal(s.first, '2026-11-20T10:00:02Z');
});
check('token_count only: the last cumulative total, once', () => {
    const s = readCodexSession(countOnly);
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0].usage.output_tokens_details.thinking_tokens, 20);
    assert.equal(s.entries[0].usage.cache_read_input_tokens, 300);
    assert.equal(s.entries[0].usage.input_tokens, 600);
});
check('a session of another project is dropped by cwd before it is read', () => {
    assert.equal(readCodexSession(path.join(dayDir(0), 'rollout-c.jsonl'), (cwd) => cwd === mine), null);
});
check('the date folder limits which files are listed', () => {
    const names = (days) => codexFiles({ sinceDays: days }).map(f => path.basename(f.file)).sort();
    assert.deepEqual(names(90), ['rollout-a.jsonl', 'rollout-b.jsonl', 'rollout-c.jsonl']);
    assert.ok(names(500).includes('rollout-old.jsonl'));
});

// the merged ledger: a Claude transcript for the same project plus the Codex sessions above
const claudeDir = path.join(tmp, '.claude', 'projects', usage.encodeProjectDir(mine));
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, 'cs1.jsonl'), JSON.stringify({
    timestamp: '2026-11-20T09:00:00Z', message: { model: 'claude-x', usage: { input_tokens: 5, output_tokens: 11, cache_read_input_tokens: 7000 } }
}) + '\n');

const led = usage.readTokenUsage(mine, { force: true, onlyProject: true });
check('ledger totals add Claude and this project\'s Codex sessions, nothing from another project', () => {
    assert.equal(led.available, true);
    assert.equal(led.totals.calls, 4);                 // 1 Claude + 2 records + 1 count-only total
    assert.equal(led.totals.output + led.totals.thinking, 11 + 300 + 90);
    assert.equal(led.totals.cacheRead, 7000 + 2300 + 300);
});
check('per-tool totals', () => {
    const byName = Object.fromEntries(led.clients.map(c => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['claude-code', 'codex']);
    assert.equal(usage.workDone(byName.codex), 390);
    assert.equal(usage.workDone(byName['claude-code']), 11);
});
check('Codex sessions attribute to the project by cwd; models and sessions carry their tool', () => {
    assert.ok(led.projects.every(p => p.name === usage.encodeProjectDir(mine)));
    assert.ok(led.sessions.some(s => s.id === 'sess-both' && s.client === 'codex'));
    assert.ok(!led.sessions.some(s => s.id === 'sess-other'));
    assert.equal(led.models.find(m => m.name === 'gpt-6.1-sol').client, 'codex');
    assert.equal(led.models.find(m => m.name === 'claude-x').client, 'claude-code');
    assert.ok(led.agents.some(a => a.id === 'codex' && a.main === false));
});
check('the day window is honoured, and widening it reads the old session too', () => {
    const wide = usage.readTokenUsage(mine, { force: true, onlyProject: true, sinceDays: 500 });
    assert.equal(wide.totals.calls, led.totals.calls + 1);
});
check('with no Claude folder at all, Codex alone still answers', () => {
    fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true });
    const only = usage.readTokenUsage(mine, { force: true, onlyProject: true });
    assert.equal(only.available, true);
    assert.deepEqual(only.clients.map(c => c.name), ['codex']);
});

// the shared byte budget is spent newest-first: a big old Claude file must not starve today's Codex
const mineDir = path.join(tmp, '.claude', 'projects', usage.encodeProjectDir(mine));
fs.mkdirSync(mineDir, { recursive: true });
const claudeLine = (out) => JSON.stringify({ timestamp: '2026-11-10T09:00:00Z', message: { model: 'claude-x', usage: { output_tokens: out } } });
const bigFile = path.join(mineDir, 'big-old.jsonl');
fs.writeFileSync(bigFile, [claudeLine(1000), 'x'.repeat(60000), ''].join(String.fromCharCode(10)));
const hourAgo = new Date(Date.now() - 3600 * 1000);
fs.utimesSync(bigFile, hourAgo, hourAgo);
const ancientFile = path.join(mineDir, 'ancient.jsonl');
fs.writeFileSync(ancientFile, [claudeLine(5000), ''].join(String.fromCharCode(10)));
const longAgo = new Date(Date.now() - 200 * 86400000);
fs.utimesSync(ancientFile, longAgo, longAgo);
const codexBytes = [both, countOnly].reduce((n, f) => n + fs.statSync(f).size, 0);   // this project's Codex files (the other project's add no bytes)
const bigSize = fs.statSync(bigFile).size;
const savedBudget = usage.USAGE_LIMITS.maxTotalBytes;
try {
    usage.USAGE_LIMITS.maxTotalBytes = bigSize + codexBytes - 1;   // fits the Codex files, not the Claude file on top
    const tight = usage.readTokenUsage(mine, { force: true, onlyProject: true });
    check('a small budget skips the older Claude file, not the newer Codex sessions', () => {
        assert.ok(tight.clients.some(c => c.name === 'codex'));
        assert.equal(usage.workDone(tight.clients.find(c => c.name === 'codex')), 390);
        assert.ok(!tight.clients.some(c => c.name === 'claude-code'));
        assert.equal(tight.truncated, true);
        assert.equal(tight.skippedFiles, 1);
    });
    usage.USAGE_LIMITS.maxTotalBytes = savedBudget;
    const roomy = usage.readTokenUsage(mine, { force: true, onlyProject: true });
    check('Claude transcripts older than sinceDays are not read; a wider window reads them', () => {
        assert.equal(usage.workDone(roomy.clients.find(c => c.name === 'claude-code')), 1000);   // big-old only
        const wide = usage.readTokenUsage(mine, { force: true, onlyProject: true, sinceDays: 500 });
        assert.equal(usage.workDone(wide.clients.find(c => c.name === 'claude-code')), 6000);
        assert.ok(wide.scannedFiles > roomy.scannedFiles);
    });
} finally { usage.USAGE_LIMITS.maxTotalBytes = savedBudget; }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ncodex-usage-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
