// The owner's working agreement and profile: how every AI in every project decides, proposes and
// asks, and what it has learned about the owner. Both ride in the session_start brief because
// AGENTS.md is copied once and never updated, so a rule written only there would miss every
// project kitted before it. Profiles live in the hub, never in a project repository: they
// describe a person, and a repository can be shared or public.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { APP_ROOT, PLUTOS_HOME_DIR } from './approot.mjs';

export const AGREEMENT_FILE = 'WORKING_AGREEMENT.md';
export const PROFILE_MAX_CHARS = 2000;
const STALE_DAYS = 30;

// One file per project, named so the owner can tell them apart and two folders with the same
// name cannot collide.
export function projectProfilePath(projectRoot, home = PLUTOS_HOME_DIR) {
    const resolved = path.resolve(projectRoot);
    const key = crypto.createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 10);
    const name = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'project';
    return path.join(home, 'profiles', `${name}-${key}.md`);
}

const readTrimmed = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return ''; } };

export function workingAgreement(home = PLUTOS_HOME_DIR, appRoot = APP_ROOT, projectRoot = null) {
    const own = path.join(home, AGREEMENT_FILE);
    const shipped = readTrimmed(path.join(appRoot, 'scaffold', AGREEMENT_FILE));
    let rules = readTrimmed(own) || shipped;
    if (!rules) return '';
    // The scope rule (project-scissors at the centre) and the rule to record an owner's decision when
    // he states it (core's trial, 2026-11: a chat decision held in later sessions 8 of 9 times when
    // written where the next start shows it, 3 of 9 when not) ride in every brief, also under an
    // owner's own copy made before they existed; they are added to the brief, the owner's file is not edited.
    // So do "tools before agents" and "no silent shortcut" (field reports 2026-11-14: sessions spent
    // agent runs on look-ups a tool answers, and took shortcuts without naming their later cost).
    for (const [rule, marker] of [[/^\d+\. Scope before features/, 'project-scissors'], [/^\d+\. When the owner states a decision/, 'plutos_decide'],
        [/^\d+\. Tools before agents/, 'Tools before agents'], [/^\d+\. No silent shortcut/, 'No silent shortcut']]) {
        const line = shipped.split('\n').find(l => rule.test(l));
        if (line && !rules.includes(marker)) rules += `\n${line}`;
    }
    let out = `\n\n${rules}\n(Owner's copy, for a standing preference the owner states: ${own}.)`;
    if (!projectRoot) return out;
    const file = projectProfilePath(projectRoot, home);
    const profile = readTrimmed(file);
    let age = Infinity;
    try { age = (Date.now() - fs.statSync(file).mtimeMs) / 86_400_000; } catch (e) { /* no profile yet */ }
    if (profile) {
        const body = profile.length > PROFILE_MAX_CHARS ? `${profile.slice(0, PROFILE_MAX_CHARS)}\n[profile truncated; read the file for the rest]` : profile;
        out += `\n\nOWNER PROFILE FOR THIS PROJECT (${file})\n${body}`;
    }
    if (age > STALE_DAYS) out += `\n${profile ? 'The project profile is over 30 days old' : 'No owner profile for this project yet'}: before this session ends, ask the owner how they want to work here and write it to ${file}.`;
    return out;
}
