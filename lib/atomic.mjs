// Atomic, conflict-safe read-modify-write for the shared coordination files (BOARD.md,
// AGENT_BOARD.md, ROSTER.md, CONTINUITY.md). Multiple AI agents write these concurrently.
//
// History, because it explains the design: the first version was "optimistic" — read, mutate,
// re-read to see if anyone wrote in between, then rename into place. The re-read happened
// BEFORE the temp-file write, so two processes could both pass the check and both rename;
// the second rename won and the first writer's update vanished while its caller was told
// success. Measured, not hypothetical: 2 agents × 25 board entries lost 12 of 50 (24%).
// A coordination system may refuse a write, but it must never lie about having done one.
//
// The fix is a real mutex. fs.mkdirSync() is atomic on POSIX and NTFS — exactly one process
// can create the directory; everyone else gets EEXIST and waits. Inside the lock the
// read-modify-write is single-writer, and the final rename() keeps readers from ever seeing
// a half-written file (readers don't take the lock at all).
//
// Stale locks: a process killed inside its critical section leaves the lock dir behind.
// Each holder stamps owner.json (pid + time); a waiter that has watched the SAME lock
// instance stay put for STALE_MS may reclaim it, and only once the stamped holder process is
// confirmed absent. mtime of the dir itself is not trusted for staleness — antivirus/backup
// tools touch directories — the birth stamp inside is.
//
// Reclaiming used to be rmSync. A reclaimer delayed between its stale check and the rmSync
// then deleted the lock the NEXT writer had just taken, and two writers ran at once. Now the
// stale lock is renamed to a permanent tombstone named after the exact instance it saw
// (`<lock>.stale.<pid|unstamped>.<birth>`). A second, delayed reclaimer renames onto that same
// nonempty destination, which fails on POSIX and NTFS, so it can never move a newer lock away.
//
// A lock with no readable stamp (the holder died between mkdir and the stamp write, or the
// stamp write failed) used to have no birth at all, so it was never stolen: one such
// directory, measured on a real install, wedged every mcp_status.json writer for six weeks
// and froze the dashboard for ~3s per request. Only for that case the directory's mtime
// stands in for the birth. A touch can only make it look younger, which delays a steal and
// never causes an early one; a live holder mid-stamp is milliseconds old and is left alone.
import fs from 'fs';
import path from 'path';
import { clientProcessPresence } from './client-process.mjs';

const STALE_MS = 10_000;   // a critical section is file I/O only; stamped recovery also needs an absent holder
const WAIT_MS = 15;        // per retry sleep; total patience = LOCK_TRIES × WAIT_MS ≈ 3s
const LOCK_TRIES = 200;

// Synchronous sleep without spinning the CPU. All writers in this codebase are sync
// (dashboard route handlers call these functions directly), so the wait must be sync too.
const sleep = (ms) => {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
};

function lockPathFor(filePath) {
    return `${filePath}.lock`;
}

function tryReadStamp(lockDir) {
    try { return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); }
    catch (e) { return null; }
}

function stamplessBirth(lockDir) {
    try { return fs.statSync(lockDir).mtimeMs; }
    catch (e) { return null; }
}

// The fence file that makes an empty (unstamped) lock's tombstone nonempty. It is deliberately
// NOT owner.json: if the rename after writing it fails (Windows refuses to rename a directory
// while a scanner holds a file inside it), an owner.json carrying this live process's pid would
// look like a live holder and wedge the lock for as long as this process runs. A fence file
// leaves the lock unstamped, so it is simply reclaimable again after another STALE_MS.
const FENCE_FILE = 'reclaim.json';

// Tombstones are one tiny directory per crashed lock, kept on purpose (removing them would
// reopen the race above). A walker that would read them as state (studio snapshots) skips them,
// and MACHINE_IGNORES keeps them out of git.
// shortcut: no automatic cleanup; offline cleanup if growth ever matters.
export function isLockTombstone(name) {
    return /\.lock\.stale\.(?:\d+|unstamped)\.[\d.]+$/.test(name);
}

// Take the lock or throw. Returns an unlock function.
export function acquireLock(filePath) {
    const lockDir = lockPathFor(filePath);
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });

    let watched = null;   // { birth } of the lock instance we are waiting on
    let lastPermissionError = null;
    for (let i = 0; i < LOCK_TRIES; i++) {
        try {
            fs.mkdirSync(lockDir);   // atomic: exactly one winner
            const stamp = { pid: process.pid, birth: Date.now() };
            try { fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(stamp)); } catch (e) { /* stamp is advisory */ }
            return () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (e) { /* releasing best-effort */ } };
        } catch (e) {
            if (e.code !== 'EEXIST') {
                // Windows can briefly deny recreation while another process releases the
                // directory. Retry inside the same budget, without treating denial as ownership.
                if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(e.code)) {
                    lastPermissionError = e;
                    sleep(WAIT_MS);
                    continue;
                }
                throw e;
            }
            lastPermissionError = null;
            const stamp = tryReadStamp(lockDir);
            const birth = stamp ? stamp.birth : stamplessBirth(lockDir);
            // Same lock instance, alive past any plausible critical section. A stamped lock is
            // reclaimed only when its holder is confirmed absent: a live holder keeps its lock even
            // during a long install, and a pid we may not signal (EPERM) does not prove a crash.
            // An unstamped lock has no pid to ask, so its age alone decides.
            if (watched && watched.birth === birth
                && (stamp ? Number.isSafeInteger(birth) : Number.isFinite(birth)) && birth > 0
                && Date.now() - birth > STALE_MS
                && (!stamp || clientProcessPresence(stamp.pid) === 'absent')) {
                // Rename, never delete: the nonempty tombstone fences this exact old instance,
                // so a delayed second reclaimer's rename fails even if lockDir now belongs to a
                // new writer. mkdir stays the arbiter for who takes the lock next.
                try {
                    const fence = path.join(lockDir, FENCE_FILE);
                    // wx: never overwrite; a failure means someone else is acting on this dir.
                    if (!stamp && !fs.existsSync(fence)) fs.writeFileSync(fence,
                        JSON.stringify({ reclaimer: process.pid, at: Date.now() }), { flag: 'wx' });
                    fs.renameSync(lockDir, `${lockDir}.stale.${stamp ? stamp.pid : 'unstamped'}.${birth}`);
                } catch (e2) { /* another reclaimer or a new writer won; observe again */ }
                watched = null;
                continue;
            }
            if (!watched || watched.birth !== birth) watched = { birth };
            sleep(WAIT_MS);
        }
    }
    if (lastPermissionError) throw lastPermissionError;
    throw Object.assign(new Error(`${path.basename(filePath)} is locked by another writer — retry the operation.`), { code: 'ELOCKED' });
}

// Two defenses, because there are two kinds of writer:
//  - LOCKED writers (every MCP tool and dashboard route) — serialized by the mutex above,
//    which closes the measured 24% lost-update race between two AI tools.
//  - UNLOCKED writers — "any AI participates just by editing the files" is the product's
//    contract, and a hand edit (or an editor save) takes no lock. For those, re-read just
//    before the rename; if the bytes moved since our read, re-apply the mutation on the
//    fresh content. Inside the lock only unlocked writers can trip this, so the retry
//    actually converges instead of two locked writers ping-ponging.
// Readers take no lock, and Windows refuses to replace a file another process has open: a
// reader holding the target for a few milliseconds made the locked writer fail with EPERM, and
// left its temp file behind. Retry briefly inside the same lock; on a real failure remove the
// temp file and surface the original error.
// The base check in updateFileAtomically ran before the first rename attempt, so a retry is
// a later replacement than that check vouched for: an unlocked edit landing while a reader
// held the file would be overwritten. Before each retry the target must still be exactly what
// the mutation was based on; otherwise refuse rather than lose that edit.
const RENAME_TRIES = 50;   // × WAIT_MS ≈ 750ms of patience for a reader to let go
function renameIntoPlace(tmp, filePath, base, exists) {
    for (let i = 0; ; i++) {
        try {
            if (i && (fs.existsSync(filePath) !== exists || exists && fs.readFileSync(filePath, 'utf8') !== base))
                throw new Error(`${path.basename(filePath)} changed during replacement — retry the operation.`);
            fs.renameSync(tmp, filePath);
            return;
        }
        catch (e) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code) && i < RENAME_TRIES) { sleep(WAIT_MS); continue; }
            try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* the original error is the one that matters */ }
            throw e;
        }
    }
}

export function updateFileAtomically(filePath, mutate, { seed = '', skipUnchanged = false } = {}, retries = 5) {
    const unlock = acquireLock(filePath);
    try {
        for (let attempt = 0; ; attempt++) {
            const exists = fs.existsSync(filePath);
            const base = exists ? fs.readFileSync(filePath, 'utf8') : seed;
            if (!exists) fs.mkdirSync(path.dirname(filePath), { recursive: true });

            const { content: next, result } = mutate(base);

            const currentlyExists = fs.existsSync(filePath);
            const current = currentlyExists ? fs.readFileSync(filePath, 'utf8') : null;
            const unchanged = exists ? current === base : !currentlyExists;

            if (unchanged) {
                if (skipUnchanged && exists && next === base) return result;
                // rename() is atomic on NTFS/POSIX — no reader ever sees a half-written board.
                const tmp = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
                fs.writeFileSync(tmp, next, 'utf8');
                renameIntoPlace(tmp, filePath, base, exists);
                return result;
            }
            if (attempt >= retries) {
                throw new Error(`${path.basename(filePath)} is being updated concurrently — retry the operation.`);
            }
            // else: an unlocked writer landed mid-flight — loop and re-apply on their content.
        }
    } finally {
        unlock();
    }
}
