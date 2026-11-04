// Evidence-aware shared context.
//
// A session note is not a fact merely because an AI wrote it. CONTEXT.json keeps durable
// claims separate from the session ledger and records the exact source-file hashes that
// supported them at capture time. session_start re-evaluates those hashes every time:
// unchanged, evidence-backed claims may be shown as current; changed/missing/drifted sources
// are quarantined; notes without exact evidence stay visibly unverified.
//
// A changed source does not always mean a changed fact. When the file's hash moved but the
// exact excerpt the claim was captured from is still in it, verbatim, the claim goes to a third
// state, "needs review", instead of quarantine: an unrelated edit elsewhere in the file (a
// comment, a new function) no longer silences a claim, and the check stays deterministic,
// since the excerpt is compared byte for byte, not judged. Only the cited file itself is
// softened this way; changed referenced code and document drift still quarantine.
//
// This is provenance + freshness, not an oracle. A matching excerpt proves that the cited
// source contains the evidence and has not changed — not that every interpretation is true.
//
// Since 2026-11-04 the same file holds the project's decisions as records (`decisions`, beside
// `claims`): one minted id each, a text, optional sources, and `supersedes` when a decision
// reverses an earlier one. A decision's status is derived at read time like a claim's: reversed
// when another decision supersedes it, verified when its evidence still matches, else valid.
// Decisions are never trimmed or aged out; the digest in CONTINUITY.md stays the human view.
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { updateFileAtomically } from './atomic.mjs';
import { docDrift, referencedFiles } from './hygiene.mjs';

export const CONTEXT_LIMITS = {
    claims: 80,
    // Decisions are not trimmed: past this cap a write is refused, and `plutos check --memory`
    // warns from 90% on, so retiring comes before the refusal.
    decisions: 200,
    claimChars: 500,
    sourcesPerClaim: 8,
    sourcePathChars: 500,
    evidenceChars: 500,
    sourceBytes: 5 * 1024 * 1024,
    referencesPerMarkdown: 24,
    referenceBytes: 2 * 1024 * 1024,
    registryBytes: 512 * 1024,
    briefCurrent: 20,
    // Claims whose file changed but whose excerpt is still there are a soft check: the newest five
    // show, the rest are a count (twelve took a quarter of this repository's brief).
    briefNeedsReview: 5,
    // Quarantined claims are ones whose source changed after capture: a few show what kind they
    // are, and the rest are a count. Twelve of them took a quarter of the hook's 10,000 characters.
    briefStale: 3
};

const VERSION = 1;

// Zero-width, byte-order-mark and bidirectional controls: invisible when rendered, so a record
// carrying one can read differently from what it shows. Refused on every write.
const HIDDEN_UNICODE = /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/;
export function hasHiddenUnicode(text) {
    return HIDDEN_UNICODE.test(String(text || ''));
}
function refuseHidden(what, text) {
    if (hasHiddenUnicode(text)) throw new Error(`${what} carries a hidden character (zero-width or bidirectional control); remove it.`);
}

// The marker's own length, so a cap can never be blown by editing the marker. Hand-counting it
// is what broke the shared-claims registry: the writer emitted max + 2 characters and the reader
// refuses anything over max, so ONE claim two characters too long made the whole file unreadable
// and every claim in it read as unverified.
const TRUNCATED = ' ...[truncated]';

function flat(value, max) {
    const out = String(value).replace(/\s*\r?\n\s*/g, ' ').trim();
    return out.length > max ? out.slice(0, max - TRUNCATED.length) + TRUNCATED : out;
}

function evidenceText(value) {
    const out = String(value || '').replace(/\r\n/g, '\n').trim();
    return out.length > CONTEXT_LIMITS.evidenceChars
        ? out.slice(0, CONTEXT_LIMITS.evidenceChars)
        : out;
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

// A claim's id is a hash of its wording (two captures of the same sentence are one claim); a
// decision's id is minted once and never depends on the wording, so it can be cited and superseded.
export function claimId(claim) {
    return hash(claim.toLocaleLowerCase('en-US')).slice(0, 24);
}
export const DECISION_ID = /^d-[0-9a-f]{12}$/;
export function mintDecisionId() {
    return `d-${randomBytes(6).toString('hex')}`;
}

// Case folding that treats the Turkish dotless ı and dotted İ as i, so two records that differ
// only in the keyboard they were typed on are the same text.
export function foldText(text) {
    return String(text || '').replace(/İ/g, 'i').replace(/ı/g, 'i').toLocaleLowerCase('en-US');
}

function gitHead(projectRoot) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: projectRoot, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch (e) {
        return '';
    }
}

function registrySeed() {
    return { version: VERSION, updatedAt: null, claims: [], decisions: [] };
}

function validSources(sources) {
    return Array.isArray(sources) && sources.length <= CONTEXT_LIMITS.sourcesPerClaim
        && sources.every(source => source && typeof source === 'object'
            && typeof source.path === 'string' && source.path.length <= CONTEXT_LIMITS.sourcePathChars
            && (!Array.isArray(source.references) || source.references.length <= CONTEXT_LIMITS.referencesPerMarkdown));
}

function parseRegistry(content) {
    if (!String(content || '').trim()) return registrySeed();
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.claims)) {
        throw new Error('CONTEXT.json is not a valid PLUT_OS context registry.');
    }
    if (parsed.claims.length > CONTEXT_LIMITS.claims) {
        throw new Error(`CONTEXT.json exceeds the ${CONTEXT_LIMITS.claims}-claim limit.`);
    }
    for (const [index, item] of parsed.claims.entries()) {
        if (!item || typeof item !== 'object' || typeof item.claim !== 'string'
            || item.claim.length > CONTEXT_LIMITS.claimChars || !Array.isArray(item.sources)) {
            throw new Error(`CONTEXT.json claim ${index} violates the bounded registry contract.`);
        }
        if (!validSources(item.sources)) throw new Error(`CONTEXT.json claim ${index} has an invalid source snapshot.`);
    }
    // `decisions` is optional so a registry written before 2026-11-04 still loads.
    const decisions = parsed.decisions == null ? [] : parsed.decisions;
    if (!Array.isArray(decisions)) throw new Error('CONTEXT.json decisions must be an array.');
    if (decisions.length > CONTEXT_LIMITS.decisions) {
        throw new Error(`CONTEXT.json exceeds the ${CONTEXT_LIMITS.decisions}-decision limit.`);
    }
    for (const [index, item] of decisions.entries()) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string'
            || item.text.length > CONTEXT_LIMITS.claimChars || !validSources(item.sources == null ? [] : item.sources)
            || (item.supersedes != null && typeof item.supersedes !== 'string')) {
            throw new Error(`CONTEXT.json decision ${index} violates the bounded registry contract.`);
        }
    }
    return { version: VERSION, updatedAt: parsed.updatedAt || null, claims: parsed.claims, decisions };
}

export function contextPathFor(projectRoot) {
    return path.join(projectRoot, 'docs', 'handoff', 'CONTEXT.json');
}

function normalizeSources(what, rawValue) {
    const rawSources = rawValue == null ? [] : (Array.isArray(rawValue) ? rawValue : [rawValue]);
    if (rawSources.length > CONTEXT_LIMITS.sourcesPerClaim) {
        throw new Error(`${what}.sources exceeds the ${CONTEXT_LIMITS.sourcesPerClaim}-source limit.`);
    }
    return rawSources.map((source, sourceIndex) => {
        if (typeof source === 'string') {
            if (source.length > CONTEXT_LIMITS.sourcePathChars || /[\r\n]/.test(source)) {
                throw new Error(`${what}.sources[${sourceIndex}] has an invalid or oversized path.`);
            }
            const sourcePath = source.trim();
            if (!sourcePath) throw new Error(`${what}.sources[${sourceIndex}] is required.`);
            refuseHidden(`${what}.sources[${sourceIndex}]`, sourcePath);
            return { path: sourcePath, evidence: '' };
        }
        if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.path !== 'string') {
            throw new Error(`${what}.sources[${sourceIndex}] must name a path.`);
        }
        if (source.path.length > CONTEXT_LIMITS.sourcePathChars || /[\r\n]/.test(source.path)) {
            throw new Error(`${what}.sources[${sourceIndex}].path is invalid or oversized.`);
        }
        const sourcePath = source.path.trim();
        if (!sourcePath) throw new Error(`${what}.sources[${sourceIndex}].path is required.`);
        if (source.evidence != null && typeof source.evidence !== 'string') {
            throw new Error(`${what}.sources[${sourceIndex}].evidence must be a string.`);
        }
        if (source.evidence != null && source.evidence.replace(/\r\n/g, '\n').trim().length > CONTEXT_LIMITS.evidenceChars) {
            throw new Error(`${what}.sources[${sourceIndex}].evidence exceeds the ${CONTEXT_LIMITS.evidenceChars}-character limit.`);
        }
        refuseHidden(`${what}.sources[${sourceIndex}].path`, sourcePath);
        refuseHidden(`${what}.sources[${sourceIndex}].evidence`, source.evidence);
        return { path: sourcePath, evidence: evidenceText(source.evidence) };
    });
}

// Accepts the legacy string form and the evidence-aware object form. Validation happens
// before the session ledger is written, preserving session_end's all-inputs-are-bounded rule.
export function normalizeLearned(value) {
    if (value == null || value === '') return [];
    const values = Array.isArray(value) ? value : [value];
    if (values.length > CONTEXT_LIMITS.claims) {
        throw new Error(`learned exceeds the ${CONTEXT_LIMITS.claims}-claim limit.`);
    }
    return values.map((item, index) => {
        if (typeof item === 'string') {
            const claim = flat(item, CONTEXT_LIMITS.claimChars);
            if (!claim) throw new Error(`learned[${index}] is required.`);
            refuseHidden(`learned[${index}]`, claim);
            return { claim, sources: [], origin: 'session-note' };
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`learned[${index}] must be a string or a claim object.`);
        }
        if (typeof item.claim !== 'string') throw new Error(`learned[${index}].claim must be a string.`);
        const claim = flat(item.claim, CONTEXT_LIMITS.claimChars);
        if (!claim) throw new Error(`learned[${index}].claim is required.`);
        refuseHidden(`learned[${index}].claim`, claim);
        const sources = normalizeSources(`learned[${index}]`, item.sources);
        if (item.replaces != null && typeof item.replaces !== 'string') throw new Error(`learned[${index}].replaces must be the text of the claim it corrects.`);
        const replaces = item.replaces ? flat(item.replaces, CONTEXT_LIMITS.claimChars) : '';
        refuseHidden(`learned[${index}].replaces`, replaces);
        return { claim, sources, origin: item.origin ? flat(item.origin, 60) : '', ...(replaces ? { replaces } : {}) };
    });
}

// `decided` accepts a string (the decision text) or `{ decision, supersedes?, sources? }`, where
// `supersedes` is the id of the decision this one reverses. → [{ text, sources, supersedes? }]
export function normalizeDecided(value) {
    if (value == null || value === '') return [];
    const values = Array.isArray(value) ? value : [value];
    if (values.length > CONTEXT_LIMITS.decisions) {
        throw new Error(`decided exceeds the ${CONTEXT_LIMITS.decisions}-decision limit.`);
    }
    return values.map((item, index) => {
        const raw = typeof item === 'string' ? { decision: item } : item;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error(`decided[${index}] must be a string or { decision, supersedes?, sources? }.`);
        }
        if (typeof raw.decision !== 'string') throw new Error(`decided[${index}].decision must be a string.`);
        const text = flat(raw.decision, CONTEXT_LIMITS.claimChars);
        if (!text) throw new Error(`decided[${index}] is required.`);
        refuseHidden(`decided[${index}]`, text);
        let supersedes;
        if (raw.supersedes != null && raw.supersedes !== '') {
            if (typeof raw.supersedes !== 'string' || !DECISION_ID.test(raw.supersedes.trim())) {
                throw new Error(`decided[${index}].supersedes must be a decision id (d-… as plutos memory list shows it).`);
            }
            supersedes = raw.supersedes.trim();
        }
        return { text, sources: normalizeSources(`decided[${index}]`, raw.sources), ...(supersedes ? { supersedes } : {}) };
    });
}

function safeSource(projectRoot, requested) {
    if (path.isAbsolute(requested)) return { error: 'absolute source paths are not allowed' };
    const root = path.resolve(projectRoot);
    const full = path.resolve(root, requested);
    const rel = path.relative(root, full);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return { error: 'source path leaves the project' };
    }
    // The lexical check above is not enough when a project-local symlink/junction points
    // outside the repository. Resolve existing paths before reading; missing paths continue
    // to the caller so it can report the more useful "source does not exist" reason.
    let realRoot;
    try { realRoot = fs.realpathSync(root); }
    catch (e) { return { error: 'project root real path cannot be verified' }; }
    let resolved = full;
    if (fs.existsSync(full)) {
        try { resolved = fs.realpathSync(full); }
        catch (e) { return { error: 'source real path cannot be verified' }; }
        const realRel = path.relative(realRoot, resolved);
        if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
            return { error: 'source resolves outside the project' };
        }
    }
    return { full: resolved, rel: rel.replace(/\\/g, '/') };
}

export function snapshotSource(projectRoot, source) {
    const safe = safeSource(projectRoot, source.path);
    if (safe.error) return { source: null, issue: `${source.path}: ${safe.error}` };
    let stat;
    try { stat = fs.statSync(safe.full); } catch (e) {
        return { source: null, issue: `${safe.rel}: source file does not exist` };
    }
    if (!stat.isFile()) return { source: null, issue: `${safe.rel}: source is not a file` };
    if (stat.size > CONTEXT_LIMITS.sourceBytes) {
        return { source: null, issue: `${safe.rel}: source exceeds the ${Math.round(CONTEXT_LIMITS.sourceBytes / 1024 / 1024)} MB verification limit` };
    }
    const bytes = fs.readFileSync(safe.full);
    const content = bytes.toString('utf8').replace(/\r\n/g, '\n');
    const evidence = evidenceText(source.evidence);
    const evidenceMatched = !!evidence && content.includes(evidence);
    const references = [];
    const referenceIssues = [];
    if (safe.rel.toLowerCase().endsWith('.md')) {
        const refs = referencedFiles(projectRoot, safe.rel);
        if (refs.length > CONTEXT_LIMITS.referencesPerMarkdown) {
            referenceIssues.push(`${safe.rel}: document names ${refs.length} code files; verification limit is ${CONTEXT_LIMITS.referencesPerMarkdown}`);
        }
        for (const rel of refs.slice(0, CONTEXT_LIMITS.referencesPerMarkdown)) {
            const refSafe = safeSource(projectRoot, rel);
            if (refSafe.error) {
                referenceIssues.push(`${rel}: referenced path ${refSafe.error}`);
                continue;
            }
            let refStat;
            try { refStat = fs.statSync(refSafe.full); } catch (e) {
                referenceIssues.push(`${refSafe.rel}: referenced file is missing`);
                continue;
            }
            if (!refStat.isFile() || refStat.size > CONTEXT_LIMITS.referenceBytes) {
                referenceIssues.push(`${refSafe.rel}: referenced file cannot be hash-checked`);
                continue;
            }
            references.push({ path: refSafe.rel, sha256: hash(fs.readFileSync(refSafe.full)), bytes: refStat.size });
        }
    }
    return {
        source: {
            path: safe.rel,
            sha256: hash(bytes),
            bytes: stat.size,
            evidenceSha256: evidenceMatched ? hash(evidence) : null,
            // Kept so a later edit elsewhere in the file can be told apart from an edit to it.
            evidence: evidenceMatched ? evidence : null,
            evidenceBytes: evidenceMatched ? Buffer.byteLength(evidence, 'utf8') : 0,
            references
        },
        issues: [
            ...(!evidence ? [`${safe.rel}: no exact evidence excerpt was supplied`]
                : !evidenceMatched ? [`${safe.rel}: evidence excerpt was not found in the source`] : []),
            ...referenceIssues
        ]
    };
}

function snapshotAll(projectRoot, requestedSources) {
    const issues = [];
    const sources = [];
    for (const requested of requestedSources) {
        const captured = snapshotSource(projectRoot, requested);
        if (captured.source) sources.push(captured.source);
        if (captured.issue) issues.push(captured.issue); // v1 compatibility with early captures
        if (captured.issues?.length) issues.push(...captured.issues);
    }
    const sourceBacked = sources.length > 0
        && sources.length === requestedSources.length
        && sources.every(source => !!source.evidenceSha256)
        && issues.length === 0;
    return { sources, issues, sourceBacked };
}

function buildEntry(projectRoot, learned, meta) {
    const { sources, issues, sourceBacked } = snapshotAll(projectRoot, learned.sources);
    const capturedAt = new Date().toISOString();
    return {
        id: claimId(learned.claim),
        claim: learned.claim,
        strength: sourceBacked ? 'source-backed' : 'unverified',
        sources,
        issues,
        capturedAt,
        capturedBy: flat(meta.ai || 'unknown', 100),
        capturedHead: meta.head || gitHead(projectRoot),
        origin: learned.origin || meta.origin || 'session-end'
    };
}

// Over the cap the oldest unverified claims leave first, then the oldest overall. They are not
// dropped: the caller archives `dropped` with reason 'cap', so a record is never lost silently.
function trimClaims(claims) {
    if (claims.length <= CONTEXT_LIMITS.claims) return { kept: claims, dropped: [] };
    const sorted = [...claims].sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    const dropped = [];
    while (sorted.length > CONTEXT_LIMITS.claims) {
        const unverified = sorted.findIndex(item => item.strength !== 'source-backed');
        dropped.push(...sorted.splice(unverified >= 0 ? unverified : 0, 1));
    }
    return { kept: sorted, dropped };
}

function serializeRegistry(next) {
    const serialized = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > CONTEXT_LIMITS.registryBytes) {
        throw new Error(`CONTEXT.json would exceed the ${Math.round(CONTEXT_LIMITS.registryBytes / 1024)} KB registry limit.`);
    }
    return serialized;
}

// One atomic read-modify-write of the registry. `mutate(registry)` returns `{ registry, result }`
// or null for "nothing to write"; the validated, size-checked result is what lands on disk.
export function updateRegistry(projectRoot, mutate) {
    const file = contextPathFor(projectRoot);
    if (fs.existsSync(file) && fs.statSync(file).size > CONTEXT_LIMITS.registryBytes) {
        throw new Error(`CONTEXT.json exceeds the ${Math.round(CONTEXT_LIMITS.registryBytes / 1024)} KB registry limit.`);
    }
    return updateFileAtomically(file, (content) => {
        const registry = parseRegistry(content);
        const out = mutate(registry);
        if (!out) return { content, result: null };
        if (!out.registry) return { content, result: out.result };   // reported, nothing to write
        const next = { ...registry, ...out.registry, version: VERSION, updatedAt: new Date().toISOString() };
        if (next.claims.length > CONTEXT_LIMITS.claims) throw new Error(`CONTEXT.json would exceed the ${CONTEXT_LIMITS.claims}-claim limit.`);
        if (next.decisions.length > CONTEXT_LIMITS.decisions) {
            throw new Error(`CONTEXT.json holds ${CONTEXT_LIMITS.decisions} decisions, its limit: retire or supersede one (plutos memory retire) before adding another.`);
        }
        return { content: serializeRegistry(next), result: out.result };
    }, { seed: JSON.stringify(registrySeed(), null, 2) + '\n' });
}

// Upserts by normalized claim. A later unverified extraction cannot downgrade an existing
// evidence-backed claim; a new evidence-backed capture refreshes its source snapshots.
// → { added, updated, replaced, archived, replaceMissed?, sourceBacked, unverified, path }
export function recordContextClaims(projectRoot, normalizedClaims, meta = {}) {
    const file = contextPathFor(projectRoot);
    if (!normalizedClaims.length) return { added: 0, updated: 0, replaced: 0, archived: 0, sourceBacked: 0, unverified: 0, path: file };
    for (const [i, item] of normalizedClaims.entries()) {
        refuseHidden(`learned[${i}]`, item.claim);
        for (const source of item.sources || []) { refuseHidden(`learned[${i}] source path`, source.path); refuseHidden(`learned[${i}] evidence`, source.evidence); }
    }
    const incoming = normalizedClaims.map(item => buildEntry(projectRoot, item, meta));
    return updateRegistry(projectRoot, (registry) => {
        const byId = new Map(registry.claims.filter(item => item && item.id && item.claim).map(item => [item.id, item]));
        let added = 0, updated = 0;
        const replaced = [];
        const replaceMissed = [];
        for (const [i, entry] of incoming.entries()) {
            const wanted = normalizedClaims[i].replaces;
            if (!wanted) continue;
            const old = byId.get(claimId(wanted));
            if (old && old.id !== entry.id) {
                byId.delete(old.id);
                // Superseded, never rewritten: the old record keeps its id and points at its successor.
                replaced.push({ ...old, archivedAt: entry.capturedAt, supersededBy: entry.id, reason: `replaced by: ${entry.claim}` });
            } else if (!old) replaceMissed.push(wanted);
        }
        for (const entry of incoming) {
            const previous = byId.get(entry.id);
            if (!previous) {
                byId.set(entry.id, entry);
                added++;
                continue;
            }
            updated++;
            if (previous.strength === 'source-backed' && entry.strength !== 'source-backed') {
                byId.set(entry.id, { ...previous, lastSeenAt: entry.capturedAt, lastSeenBy: entry.capturedBy });
            } else {
                byId.set(entry.id, { ...entry, firstCapturedAt: previous.firstCapturedAt || previous.capturedAt });
            }
        }
        const { kept, dropped } = trimClaims([...byId.values()]);
        const now = new Date().toISOString();
        const gone = [...replaced, ...dropped.map(item => ({ ...item, archivedAt: now, reason: 'cap' }))];
        if (gone.length) archiveRecords(projectRoot, gone);
        return {
            registry: { claims: kept },
            result: {
                added, updated, replaced: replaced.length, archived: dropped.length,
                // A correction whose old claim is not in the record says so instead of passing silently.
                ...(replaceMissed.length ? { replaceMissed } : {}),
                sourceBacked: incoming.filter(item => item.strength === 'source-backed').length,
                unverified: incoming.filter(item => item.strength !== 'source-backed').length,
                path: file
            }
        };
    });
}

function buildDecision(projectRoot, item, meta) {
    const { sources, issues } = snapshotAll(projectRoot, item.sources || []);
    return {
        id: item.id && DECISION_ID.test(item.id) ? item.id : mintDecisionId(),
        text: item.text,
        sources,
        ...(issues.length ? { issues } : {}),
        ...(item.supersedes ? { supersedes: item.supersedes } : {}),
        capturedAt: item.capturedAt === null ? null : (item.capturedAt || new Date().toISOString()),
        capturedBy: flat(item.capturedBy || meta.ai || 'unknown', 100),
        capturedHead: item.capturedHead != null ? item.capturedHead : (meta.head || gitHead(projectRoot)),
        origin: item.origin || meta.origin || 'session-end',
        ...(Number.isInteger(item.digestIndex) ? { digestIndex: item.digestIndex } : {})
    };
}

// Appends decision records. A decision whose text (case-folded) is already recorded is not
// recorded twice, the way the digest skips exact repeats; `supersedes` must name a recorded
// decision, and one that is already reversed cannot be reversed again (supersede its successor).
// → { added, repeated, reversed, supersedeMissed?, ids, path }
export function recordDecisions(projectRoot, normalizedDecisions, meta = {}) {
    const file = contextPathFor(projectRoot);
    if (!normalizedDecisions.length) return { added: 0, repeated: 0, reversed: 0, ids: [], path: file };
    for (const [i, item] of normalizedDecisions.entries()) {
        refuseHidden(`decided[${i}]`, item.text);
        for (const source of item.sources || []) { refuseHidden(`decided[${i}] source path`, source.path); refuseHidden(`decided[${i}] evidence`, source.evidence); }
    }
    return updateRegistry(projectRoot, (registry) => {
        const decisions = [...registry.decisions];
        const byText = new Map(decisions.map(item => [foldText(item.text), item]));
        const byId = new Map(decisions.map(item => [item.id, item]));
        const reversedIds = new Set(decisions.map(item => item.supersedes).filter(Boolean));
        const ids = [];
        const supersedeMissed = [];
        let added = 0, repeated = 0, reversed = 0;
        for (const item of normalizedDecisions) {
            const known = byText.get(foldText(item.text));
            if (known) { repeated++; ids.push(known.id); continue; }
            let supersedes = item.supersedes;
            if (supersedes) {
                const old = byId.get(supersedes);
                if (!old) { supersedeMissed.push(supersedes); supersedes = undefined; }
                else if (reversedIds.has(old.id)) throw new Error(`${old.id} is already reversed; supersede its successor instead.`);
            }
            const entry = buildDecision(projectRoot, { ...item, supersedes }, meta);
            decisions.push(entry);
            byText.set(foldText(entry.text), entry);
            byId.set(entry.id, entry);
            ids.push(entry.id);
            added++;
            if (supersedes) { reversedIds.add(supersedes); reversed++; }
        }
        if (!added) return { result: { added, repeated, reversed, ...(supersedeMissed.length ? { supersedeMissed } : {}), ids, path: file } };
        return {
            registry: { decisions },
            result: { added, repeated, reversed, ...(supersedeMissed.length ? { supersedeMissed } : {}), ids, path: file }
        };
    });
}

export function readRegistry(projectRoot) {
    const file = contextPathFor(projectRoot);
    if (!fs.existsSync(file)) return { file, exists: false, registry: registrySeed(), error: null };
    try {
        if (fs.statSync(file).size > CONTEXT_LIMITS.registryBytes) {
            throw new Error(`CONTEXT.json exceeds the ${Math.round(CONTEXT_LIMITS.registryBytes / 1024)} KB registry limit.`);
        }
        return { file, exists: true, registry: parseRegistry(fs.readFileSync(file, 'utf8')), error: null };
    } catch (e) {
        return { file, exists: true, registry: registrySeed(), error: e.message };
    }
}

function assessSource(projectRoot, source, markdownDrift) {
    const safe = safeSource(projectRoot, source.path || '');
    if (safe.error) return `${source.path || '(missing path)'}: ${safe.error}`;
    let stat;
    try { stat = fs.statSync(safe.full); } catch (e) { return `${safe.rel}: source is missing`; }
    if (!stat.isFile()) return `${safe.rel}: source is no longer a file`;
    if (stat.size > CONTEXT_LIMITS.sourceBytes) return `${safe.rel}: source is now too large to verify`;
    const bytes = fs.readFileSync(safe.full);
    let review = null;
    if (!source.sha256 || hash(bytes) !== source.sha256) {
        // The stored excerpt must still hash to what was captured, so editing CONTEXT.json
        // cannot turn a removed fact into one that "is still there".
        const evidence = typeof source.evidence === 'string' && source.evidence
            && source.evidenceSha256 === hash(source.evidence) ? source.evidence : null;
        if (!evidence || !bytes.toString('utf8').replace(/\r\n/g, '\n').includes(evidence)) return `${safe.rel}: source changed after capture`;
        review = { soft: true, reason: `${safe.rel}: source edited after capture; the cited excerpt is still there verbatim` };
    }
    for (const reference of Array.isArray(source.references) ? source.references : []) {
        const refSafe = safeSource(projectRoot, reference.path || '');
        if (refSafe.error) return `${reference.path || '(missing path)'}: referenced path ${refSafe.error}`;
        let refStat;
        try { refStat = fs.statSync(refSafe.full); } catch (e) { return `${refSafe.rel}: referenced file is missing`; }
        if (!refStat.isFile() || refStat.size > CONTEXT_LIMITS.referenceBytes) {
            return `${refSafe.rel}: referenced file can no longer be hash-checked`;
        }
        if (!reference.sha256 || hash(fs.readFileSync(refSafe.full)) !== reference.sha256) {
            return `${safe.rel}: referenced code changed (${refSafe.rel})`;
        }
    }
    const drift = markdownDrift[safe.rel];
    if (drift && drift.tracked && !drift.snapshot && drift.staleRefs?.length) {
        return `${safe.rel}: document references changed code (${drift.staleRefs.slice(0, 3).join(', ')})`;
    }
    return review;
}

// A decision's evidence holds when the exact excerpt captured with it is still in the cited
// file, verbatim; an edit elsewhere in that file does not unsettle a decision. null, or why not.
function decisionEvidenceGone(projectRoot, source) {
    const safe = safeSource(projectRoot, source.path || '');
    if (safe.error) return `${source.path || '(missing path)'}: ${safe.error}`;
    let bytes;
    try { bytes = fs.readFileSync(safe.full); } catch (e) { return `${safe.rel}: source is missing`; }
    const evidence = typeof source.evidence === 'string' && source.evidence
        && source.evidenceSha256 === hash(source.evidence) ? source.evidence : null;
    if (!evidence) return `${safe.rel}: no evidence excerpt was captured`;
    if (source.sha256 && hash(bytes) === source.sha256) return null;
    return bytes.toString('utf8').replace(/\r\n/g, '\n').includes(evidence) ? null : `${safe.rel}: the cited excerpt is no longer in the source`;
}

// Newest first: by capture date, then by digest position (or registry position) for the
// decisions one session recorded together. An undated (migrated) record sorts as oldest.
function newestDecisionFirst(a, b) {
    const byDate = String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''));
    return byDate || (b.order - a.order);
}

// Status is derived at read time and is therefore never itself stale.
// A claim whose sources never change stayed current for ever (board P3, 2026-09-02: claims want a
// half-life). Its file still holds the excerpt, but what it says beyond that file may have moved:
// after CLAIM_REVIEW_DAYS without being captured again it is listed for review, not as fact.
export const CLAIM_REVIEW_DAYS = 90;

// Decision statuses, derived, never stored:
//   reversed — another decision's `supersedes` names this id (`reversedBy` lists them);
//   verified — at least one source, every captured excerpt matched at capture, and every one is
//              still in its file verbatim now;
//   valid    — every other decision: no sources, or a source whose excerpt is gone (`reasons`).
export function assessContext(projectRoot, { now = new Date() } = {}) {
    const { file, exists, registry, error } = readRegistry(projectRoot);
    const emptyDecisions = { valid: [], verified: [], reversed: [] };
    if (error) return { path: file, exists, error, current: [], review: [], stale: [], unverified: [], counts: { current: 0, review: 0, stale: 0, unverified: 0 }, decisions: emptyDecisions };

    const markdown = [...new Set(registry.claims.flatMap(item => (item.sources || []).map(source => source.path))
        .filter(rel => typeof rel === 'string' && rel.toLowerCase().endsWith('.md')))];
    const markdownDrift = markdown.length ? docDrift(projectRoot, markdown) : {};
    const current = [], review = [], stale = [], unverified = [];
    for (const raw of registry.claims) {
        if (!raw || typeof raw.claim !== 'string') continue;
        const item = { ...raw, type: 'claim', reasons: [...(Array.isArray(raw.issues) ? raw.issues : [])] };
        if (raw.strength !== 'source-backed' || !Array.isArray(raw.sources) || !raw.sources.length) {
            item.status = 'unverified';
            unverified.push(item);
            continue;
        }
        let hard = item.reasons.length > 0;
        for (const source of raw.sources) {
            const result = assessSource(projectRoot, source, markdownDrift);
            if (!result) continue;
            if (typeof result === 'string') { hard = true; item.reasons.push(result); }
            else item.reasons.push(result.reason);
        }
        const seen = Date.parse(raw.lastSeenAt || raw.capturedAt || '');
        const age = Number.isFinite(seen) ? Math.floor((now - seen) / 864e5) : 0;
        if (!hard && age > CLAIM_REVIEW_DAYS) item.reasons.push(`captured ${age} days ago and not captured again since; check it before relying on it`);
        if (hard) { item.status = 'stale'; stale.push(item); }
        else if (item.reasons.length) { item.status = 'review'; review.push(item); }
        else { item.status = 'verified'; current.push(item); }
    }
    const newest = (a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt));
    current.sort(newest); review.sort(newest); stale.sort(newest); unverified.sort(newest);

    const decisions = { valid: [], verified: [], reversed: [] };
    const reversedBy = new Map();
    for (const raw of registry.decisions) {
        if (raw.supersedes) reversedBy.set(raw.supersedes, [...(reversedBy.get(raw.supersedes) || []), raw.id]);
    }
    registry.decisions.forEach((raw, index) => {
        const item = { ...raw, type: 'decision', order: Number.isInteger(raw.digestIndex) ? raw.digestIndex : index, reasons: [...(Array.isArray(raw.issues) ? raw.issues : [])], reversedBy: reversedBy.get(raw.id) || [] };
        if (item.reversedBy.length) item.status = 'reversed';
        else {
            const sources = Array.isArray(raw.sources) ? raw.sources : [];
            if (sources.length && !item.reasons.length) {
                for (const source of sources) {
                    const gone = decisionEvidenceGone(projectRoot, source);
                    if (gone) item.reasons.push(gone);
                }
            }
            item.status = sources.length && !item.reasons.length ? 'verified' : 'valid';
        }
        decisions[item.status].push(item);
    });
    for (const list of Object.values(decisions)) list.sort(newestDecisionFirst);
    return {
        path: file, exists, error: null, current, review, stale, unverified,
        counts: { current: current.length, review: review.length, stale: stale.length, unverified: unverified.length },
        decisions
    };
}

// --- Claims age out ------------------------------------------------
// A claim quarantined for QUARANTINE_DAYS goes to the archive: its source changed and nobody
// re-captured it, so it is history, not context. The days count from the first commit after the
// capture that touched one of its sources, or else from the first session end that saw it
// quarantined. Runs at every session end; the archive is cold storage, never in the brief.
// Decisions never age: they hold until one supersedes them.
export const QUARANTINE_DAYS = 14;

function archivePath(projectRoot, at) {
    return path.join(projectRoot, 'docs', 'handoff', 'archive', `CONTEXT-${at.slice(0, 7)}.jsonl`);
}

// Appends records to the month's archive file; each carries `archivedAt` and a `reason`
// ('cap', 'replaced by: …', 'retired: …', or the quarantine reasons).
export function archiveRecords(projectRoot, records) {
    const file = archivePath(projectRoot, records[0].archivedAt);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, records.map(item => JSON.stringify(item)).join('\n') + '\n');
}

function staleSince(projectRoot, item) {
    let first = null;
    for (const source of item.sources || []) {
        try {
            const dates = execFileSync('git', ['log', `--since=${item.capturedAt}`, '--format=%cI', '--', source.path],
                { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim().split('\n').filter(Boolean);
            const earliest = dates.at(-1);
            if (earliest && (!first || Date.parse(earliest) < Date.parse(first))) first = new Date(Date.parse(earliest)).toISOString();
        } catch { /* not a repository, or no such path in its history */ }
    }
    return first;
}

// What ageing does to a registry's claims at `now`: which it keeps (some newly marked), which go.
function planAgeOut(projectRoot, registry, stale, now) {
    const keep = [], gone = [];
    let changed = false;
    for (const item of registry.claims) {
        if (!stale.has(item.id)) {
            if (item.quarantinedAt) { const { quarantinedAt, ...rest } = item; keep.push(rest); changed = true; } else keep.push(item);
            continue;
        }
        const since = item.quarantinedAt || staleSince(projectRoot, item) || now.toISOString();
        if (now - Date.parse(since) >= QUARANTINE_DAYS * 24 * 3600e3) {
            gone.push({ ...item, quarantinedAt: since, archivedAt: now.toISOString(), reason: stale.get(item.id).reasons.join('; ') });
        } else {
            keep.push({ ...item, quarantinedAt: since });
            if (item.quarantinedAt !== since) changed = true;
        }
    }
    return { keep, gone, changed };
}

/** → { archived }: claims quarantined past QUARANTINE_DAYS leave CONTEXT.json for the archive. */
export function ageOutClaims(projectRoot, { now = new Date() } = {}) {
    const status = assessContext(projectRoot);
    if (status.error || !status.exists) return { archived: 0 };
    const stale = new Map(status.stale.map(item => [item.id, item]));
    const file = contextPathFor(projectRoot);
    return updateFileAtomically(file, (content) => {
        const registry = parseRegistry(content);
        const { keep, gone, changed } = planAgeOut(projectRoot, registry, stale, now);
        if (!gone.length && !changed) return { content, result: { archived: 0 } };
        if (gone.length) archiveRecords(projectRoot, gone);   // before the registry drops them
        const next = { ...registry, version: VERSION, updatedAt: now.toISOString(), claims: keep };
        return { content: JSON.stringify(next, null, 2) + '\n', result: { archived: gone.length } };
    }, { seed: JSON.stringify(registrySeed(), null, 2) + '\n' });
}

/** The same plan without writing: → { wouldArchive: [{id, claim, since, reason}], quarantined: n }. */
export function previewAgeOut(projectRoot, { now = new Date() } = {}) {
    const status = assessContext(projectRoot, { now });
    if (status.error || !status.exists) return { wouldArchive: [], quarantined: 0 };
    const stale = new Map(status.stale.map(item => [item.id, item]));
    const { registry } = readRegistry(projectRoot);
    const { keep, gone } = planAgeOut(projectRoot, registry, stale, now);
    return {
        wouldArchive: gone.map(item => ({ id: item.id, claim: item.claim, since: item.quarantinedAt, reason: item.reason })),
        quarantined: keep.filter(item => item.quarantinedAt).length
    };
}
