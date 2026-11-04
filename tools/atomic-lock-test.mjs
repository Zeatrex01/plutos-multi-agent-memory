#!/usr/bin/env node
// A busy lock must be recognisable by its code (meetings and goals treat ELOCKED as "busy, retry"),
// and process presence must never claim a dead or foreign process is ours to stop.
// Stale-lock recovery renames to a permanent tombstone, and only for an absent holder: a delayed
// reclaimer must never move away the lock a newer writer has just taken. A replacement retried
// after a Windows rename denial must never overwrite an edit that landed in between.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock, updateFileAtomically, isLockTombstone } from '../lib/atomic.mjs';
import { clientProcessPresence, findClientExecutable } from '../lib/client-process.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-atomic-lock-'));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };
// A pid that certainly belonged to a process and is now gone: a child that has already exited.
const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
const plantLock = (lock, stamp) => { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(stamp)); };
const backdate = dir => { const old = new Date(Date.now() - 60000); fs.utimesSync(dir, old, old); return fs.statSync(dir).mtimeMs; };
// The rename-retry path only runs on Windows. Pretending to be win32 lets Linux CI guard it too;
// nothing else in updateFileAtomically consults process.platform on the paths these tests take.
const asWindows = fn => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try { return fn(); } finally { Object.defineProperty(process, 'platform', platform); }
};

try {
    const file = path.join(scratch, 'state.json');
    check('a held lock refuses a second writer with code ELOCKED', () => {
        const unlock = acquireLock(file);
        try {
            assert.throws(() => acquireLock(file), error => error.code === 'ELOCKED' && /locked by another writer/.test(error.message));
        } finally { unlock(); }
    });
    check('a released lock can be taken again', () => { acquireLock(file)(); });
    check('an aged dead-holder lock is recovered with its nonempty fence retained', () => {
        assert.equal(clientProcessPresence(deadPid), 'absent');
        const target = path.join(scratch, 'dead-lock'), lock = `${target}.lock`;
        const stamp = { pid: deadPid, birth: Date.now() - 20000 };
        plantLock(lock, stamp);
        const unlock = acquireLock(target);
        try {
            assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).pid, process.pid);
            const tombstone = `${lock}.stale.${stamp.pid}.${stamp.birth}`;
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tombstone, 'owner.json'))), stamp);
            assert.equal(isLockTombstone(path.basename(tombstone)), true);
        } finally { unlock(); }
    });
    check('an aged lock belonging to a live holder cannot be stolen', () => {
        const target = path.join(scratch, 'live-lock'), lock = `${target}.lock`;
        const stamp = { pid: process.pid, birth: Date.now() - 20000 };
        plantLock(lock, stamp);
        assert.throws(() => acquireLock(target), error => error.code === 'ELOCKED');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))), stamp);
    });
    check('a delayed stale reclaimer cannot replace a new live lock or its nonempty fence', () => {
        const target = path.join(scratch, 'reclaimer-race'), lock = `${target}.lock`;
        const stamp = { pid: deadPid, birth: Date.now() - 20000 }, liveStamp = { pid: process.pid, birth: Date.now() };
        const tombstone = `${lock}.stale.${stamp.pid}.${stamp.birth}`, rename = fs.renameSync;
        plantLock(lock, stamp);
        let raced = false, refused = false;
        fs.renameSync = function (source, destination) {
            if (source === lock && !raced) {
                raced = true;
                // The competing reclaimer wins, then a writer acquires the original path.
                rename(lock, tombstone); plantLock(lock, liveStamp);
                try { return rename(source, destination); }
                catch (error) { refused = true; throw error; }
            }
            return rename(source, destination);
        };
        try { assert.throws(() => acquireLock(target), error => error.code === 'ELOCKED'); }
        finally { fs.renameSync = rename; }
        assert.equal(raced, true); assert.equal(refused, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))), liveStamp);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tombstone, 'owner.json'))), stamp);
    });
    check('an old empty lock is recovered into a nonempty permanent tombstone', () => {
        const target = path.join(scratch, 'empty-state'), lock = `${target}.lock`;
        fs.mkdirSync(lock);
        const tombstone = `${lock}.stale.unstamped.${backdate(lock)}`;
        acquireLock(target)();
        assert.equal(fs.existsSync(lock), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(tombstone, 'reclaim.json'))).reclaimer, process.pid);
        assert.equal(isLockTombstone(path.basename(tombstone)), true);
    });
    check('an empty-lock reclaimer cannot rename a replacement writer into the old tombstone', () => {
        const target = path.join(scratch, 'empty-race'), lock = `${target}.lock`;
        fs.mkdirSync(lock);
        const tombstone = `${lock}.stale.unstamped.${backdate(lock)}`;
        const liveStamp = { pid: process.pid, birth: Date.now() }, rename = fs.renameSync;
        let raced = false, refused = false;
        fs.renameSync = function (source, destination) {
            if (source === lock && !raced) {
                raced = true;
                rename(lock, tombstone); plantLock(lock, liveStamp);
                try { return rename(source, destination); }
                catch (error) { refused = true; throw error; }
            }
            return rename(source, destination);
        };
        try { assert.throws(() => acquireLock(target), error => error.code === 'ELOCKED'); }
        finally { fs.renameSync = rename; }
        assert.equal(raced, true); assert.equal(refused, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))), liveStamp);
        assert.equal(JSON.parse(fs.readFileSync(path.join(tombstone, 'reclaim.json'))).reclaimer, process.pid);
    });
    check('a failed empty-lock reclaim leaves no live-looking stamp behind', () => {
        // Windows refuses to rename a directory while a scanner holds a file in it. The fence
        // written first must not read as this live process holding the lock, or it never frees.
        const target = path.join(scratch, 'empty-denied'), lock = `${target}.lock`, rename = fs.renameSync;
        fs.mkdirSync(lock);
        backdate(lock);
        let denied = 0;
        fs.renameSync = function (source, destination) {
            if (source === lock) { denied++; throw Object.assign(new Error('Injected directory rename denial'), { code: 'EPERM' }); }
            return rename(source, destination);
        };
        try { assert.throws(() => acquireLock(target), error => error.code === 'ELOCKED'); }
        finally { fs.renameSync = rename; }
        assert.ok(denied >= 1);
        assert.equal(fs.existsSync(path.join(lock, 'owner.json')), false);
        backdate(lock);
        acquireLock(target)();
        assert.equal(fs.existsSync(lock), false);
    });
    check('a transient Windows replacement denial retries the same mutation and result', () => {
        const target = path.join(scratch, 'rename-retry'), rename = fs.renameSync, result = { unchangedIdentity: true };
        fs.writeFileSync(target, 'before');
        let mutations = 0, replacements = 0;
        fs.renameSync = function (source, destination) {
            if (destination === target && ++replacements === 1) throw Object.assign(new Error('Injected replacement denial'), { code: 'EPERM' });
            return rename(source, destination);
        };
        try {
            assert.equal(asWindows(() => updateFileAtomically(target, content => { mutations++; return { content: content + '-after', result }; })), result);
        } finally { fs.renameSync = rename; }
        assert.equal(mutations, 1); assert.equal(replacements, 2); assert.equal(fs.readFileSync(target, 'utf8'), 'before-after');
    });
    check('a Windows replacement retry never overwrites an intervening unlocked edit', () => {
        const target = path.join(scratch, 'rename-conflict'), rename = fs.renameSync;
        fs.writeFileSync(target, 'before');
        let mutations = 0, replacements = 0;
        fs.renameSync = function (source, destination) {
            if (destination === target && ++replacements === 1) {
                fs.writeFileSync(target, 'external-edit');
                throw Object.assign(new Error('Injected replacement denial'), { code: 'EPERM' });
            }
            return rename(source, destination);
        };
        try {
            assert.throws(() => asWindows(() => updateFileAtomically(target, () => { mutations++; return { content: 'replacement' }; })), /changed during replacement/);
        } finally { fs.renameSync = rename; }
        assert.equal(mutations, 1); assert.equal(replacements, 1); assert.equal(fs.readFileSync(target, 'utf8'), 'external-edit');
        assert.equal(fs.readdirSync(scratch).some(name => name.startsWith('rename-conflict.') && name.endsWith('.tmp')), false);
    });
    check('process presence: this process is present, a bad pid is unobserved', () => {
        assert.equal(clientProcessPresence(process.pid), 'present');
        assert.equal(clientProcessPresence(0), 'unobserved');
        assert.equal(clientProcessPresence(-5), 'unobserved');
        assert.equal(clientProcessPresence(1.5), 'unobserved');
    });
    check('finding a client executable only returns a real file on PATH', () => {
        assert.equal(findClientExecutable('plutos-no-such-client-xyz'), undefined);
        assert.ok(fs.statSync(findClientExecutable('node')).isFile());
    });
    console.log(`Atomic lock: ${checks} passed, 0 failed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
