// The recommendation engine — the missing center the vision needed: scan a project's
// actual files, combine that with any Setup interview answers (if the owner opted in),
// and produce one recommendation (MCPs, coordination). Works with
// ZERO interview answers — "Structure only" / MCP-less projects still get real signal.
import fs from 'fs';
import path from 'path';
import { detectProjectType } from './codeindex.mjs';

const FRONTEND_DEPS = ['react', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', '@angular/core', 'react-native', 'expo', 'vite', 'solid-js'];
const BACKEND_DEPS = ['express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi', 'restify'];
const TEST_DEPS = ['jest', 'vitest', 'mocha', 'ava', 'jasmine', '@testing-library/react'];

function readJsonSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// A "test" script is a test setup whatever runner it calls (PLUT_OS's own runs tools/*-test.mjs with
// plain node and has no test dependency or test/ folder). `npm init` writes a placeholder that only
// fails, `echo "Error: no test specified" && exit 1`, and that one is no tests at all.
function hasTestScript(pkg) {
    const script = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test.trim() : '';
    return script !== '' && !/no test specified/i.test(script);
}

// Read-only filesystem scan — no writes, safe to call on every Setup tab load.
// → { stack, frameworks, hasFrontendDeps, hasBackendDeps, hasTests, isMonorepo, isGitRepo }
export function scanProject(root) {
    const signals = {
        stack: 'unknown', // unity | unreal | godot | node | python | unknown
        frameworks: [],
        hasFrontendDeps: false,
        hasBackendDeps: false,
        hasTests: false,
        isMonorepo: false,
        isGitRepo: fs.existsSync(path.join(root, '.git'))
    };
    if (!root || !fs.existsSync(root)) return signals;

    if (detectProjectType(root) === 'unity') {
        signals.stack = 'unity';
        return signals;
    }

    // Unreal: a .uproject file is the engine's own project marker — unmistakable.
    if (fs.readdirSync(root).some(f => f.endsWith('.uproject'))) {
        signals.stack = 'unreal';
        return signals;
    }

    // Godot: project.godot is the engine's project marker.
    if (fs.existsSync(path.join(root, 'project.godot'))) {
        signals.stack = 'godot';
        return signals;
    }

    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
        signals.stack = 'node';
        const pkg = readJsonSafe(pkgPath) || {};
        const depNames = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
        signals.frameworks = depNames.filter(d => FRONTEND_DEPS.includes(d) || BACKEND_DEPS.includes(d));
        signals.hasFrontendDeps = depNames.some(d => FRONTEND_DEPS.includes(d));
        signals.hasBackendDeps = depNames.some(d => BACKEND_DEPS.includes(d));
        signals.hasTests = depNames.some(d => TEST_DEPS.includes(d))
            || hasTestScript(pkg)
            || ['test', 'tests', '__tests__'].some(d => fs.existsSync(path.join(root, d)));
        signals.isMonorepo = !!pkg.workspaces;
        return signals;
    }

    if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'))) {
        signals.stack = 'python';
        signals.hasBackendDeps = true; // loose default: a bare Python project here is usually a service/tool
        signals.hasTests = ['test', 'tests'].some(d => fs.existsSync(path.join(root, d)));
        return signals;
    }

    return signals;
}

// Single source of the MCP/coordination mapping — used both for scan-driven recommendations
// (empty answers) and the Setup interview's own recommendation (empty signals). The role
// advice that lived here left on 2026-11-04 with the role bundles it pointed at.
// → { mcps, coordination, reasons }
export function buildRecommendation(signals = {}, answers = {}) {
    const reasons = [];

    // A game is recognised, but the core recommends no game role: a field's guidance comes from its
    // domain pack. The reason line says what was seen and where guidance lives.
    if (signals.stack === 'unity' || signals.stack === 'unreal' || signals.stack === 'godot' || answers.type === 'game') {
        const seen = { unity: 'a Unity project (Assets/ + ProjectSettings/)', unreal: 'an Unreal project (.uproject)', godot: 'a Godot project (project.godot)' }[signals.stack] || 'a game (your answer)';
        reasons.push(`game project: ${seen}; game guidance comes from a game domain pack, not from the core`);
    }

    const coordination = answers.team === 'small-team' || answers.team === 'larger-team' || answers.ai === 'multiple' || !!signals.isMonorepo;
    if (coordination) {
        reasons.push(signals.isMonorepo
            ? 'board coordination emphasized — monorepo, likely multiple coordinated agents'
            : 'board coordination emphasized — multiple agents / team members share BOARD.md');
    }

    reasons.push('PLUT_OS already provides the shared context ledger and generated Codebase Index; third-party MCP extensions stay an explicit owner choice');
    return { mcps: [], coordination, reasons };
}
