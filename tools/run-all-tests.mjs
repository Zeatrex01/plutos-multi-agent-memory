#!/usr/bin/env node
// Run every suite even if an earlier one fails, so a smoke failure cannot hide an MCP
// or build regression. After its own output each suite gets one line here, its result and
// its time, and the end names the failed suites again, so a failure is found without reading
// the whole log.
//
// Every suite has a timeout: 10 minutes, or PLUTOS_SUITE_TIMEOUT_MS. The slowest suite takes a
// few minutes on Windows CI. A suite that runs past it is stopped, counted as failed, and the
// next one runs; before, one hung suite held CI until GitHub's six-hour job limit.
//
// Exit status: 0 when every suite passed, else the last failed suite's (1 for a suite that was
// stopped or did not start). `npm test` runs this through lib/push-gate.mjs, which records the
// tested tree only on 0.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = ['tools/smoke-test.mjs', 'tools/mcp-test.mjs', 'tools/launcher-test.mjs', 'tools/windows-startup-test.mjs', 'tools/build-test.mjs',
    'tools/watcher-test.mjs', 'tools/session-memory-test.mjs', 'tools/management-test.mjs',
    'tools/return-summary-test.mjs', 'tools/verification-test.mjs', 'tools/repair-test.mjs', 'tools/approval-ui-test.mjs',
    'tools/recommend-godot-test.mjs', 'tools/council-test.mjs', 'tools/git-history-test.mjs', 'tools/push-gate-test.mjs', 'tools/hooks-test.mjs', 'tools/claim-check-test.mjs', 'tools/claims-test.mjs', 'tools/changelog-test.mjs', 'tools/release-scan-test.mjs', 'tools/product-test.mjs', 'tools/prune-branches-test.mjs', 'tools/launcher-stub-test.mjs', 'tools/update-test.mjs', 'tools/update-check-test.mjs', 'tools/session-close-test.mjs', 'tools/research-test.mjs', 'tools/research-mcp-test.mjs', 'tools/mcp-manager-test.mjs', 'tools/atomic-lock-test.mjs', 'tools/approval-tiers-test.mjs', 'tools/task-context-test.mjs', 'tools/token-budget-test.mjs', 'tools/working-agreement-test.mjs', 'tools/drawers-test.mjs', 'tools/dev-mode-test.mjs', 'tools/board-delta-test.mjs', 'tools/hub-config-test.mjs', 'tools/cli-profile-test.mjs', 'tools/coordination-test.mjs', 'tools/wait-test.mjs', 'tools/publish-core-test.mjs', 'tools/scope-test.mjs', 'tools/mini-test.mjs', 'tools/coverage-test.mjs', 'tools/rule-of-two-test.mjs', 'tools/skills-test.mjs', 'tools/memory-test.mjs', 'tools/memory-index-test.mjs', 'tools/harness-bench-test.mjs', 'tools/kit-history-test.mjs', 'tools/audit-test.mjs', 'tools/spend-test.mjs'];
// Suites that test files the published copy does not carry (tools/publish-core.mjs PRIVATE): they
// run where they exist. Any other missing suite still fails below.
const WORKING_COPY_ONLY = ['tools/architecture-docs-test.mjs'];
suites.push(...WORKING_COPY_ONLY.filter(file => fs.existsSync(path.join(root, file))));
const timeout = Number(process.env.PLUTOS_SUITE_TIMEOUT_MS) || 600_000;
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
const started = Date.now();
const failures = [];
let failed = 0;
for (const file of suites) {
    const start = Date.now();
    const result = spawnSync(process.execPath, [path.join(root, file)], { stdio: 'inherit', timeout });
    const took = seconds(Date.now() - start);
    if (result.status === 0) { console.log(`✔ ${file} (${took})`); continue; }
    failed = result.status || 1;
    const why = result.error?.code === 'ETIMEDOUT' ? `timed out after ${seconds(timeout)}`
        : result.error ? `did not start: ${result.error.message}`
            : result.signal ? `terminated by ${result.signal}` : `exit ${result.status}`;
    failures.push(`${file}: ${why}`);
    console.log(`✘ ${file}: ${why} (${took})`);
}
console.log(failures.length
    ? `\n${failures.length} of ${suites.length} suites failed (${seconds(Date.now() - started)}):\n${failures.map(line => `  ${line}`).join('\n')}`
    : `\nAll ${suites.length} suites passed (${seconds(Date.now() - started)}).`);
// exitCode, not exit(): the summary must reach a piped stdout (CI) before the process ends.
process.exitCode = failed;
