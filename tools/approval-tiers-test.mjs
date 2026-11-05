// Approval tiers and seals: where an approval may come from is decided by the action, and a
// ticket edited on disk reads as tampered and runs nothing. No new ticket carries an action since
// 2026-11-04 (profiles and system roles were cut), so the T2 fixtures are minted in the shape of
// before the cut: those tickets still exist in projects and must verify, answer and settle.
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-approval-home-'));
process.env.PLUTOS_HOME = home;
const { createApproval, answerApproval, readApproval, runApprovedAction, approvalTier, tierAllows, approvalsDir, askSeal, designPickImagePath } = await import('../lib/approvals.mjs');
const { applyApprovedSideEffects } = await import('../lib/approval-effects.mjs');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-approval-project-'));
const cast = { kind: 'profile_full', projectRoot: project, packageId: 'profile:full', version: 'a'.repeat(64), target: 'full', proposal: { kernel: 'Claude Code', casts: [] } };
const ticketFile = id => path.join(project, '.plutos', 'approvals', `${id}.json`);
const edit = (id, change) => { const t = JSON.parse(fs.readFileSync(ticketFile(id), 'utf8')); change(t); fs.writeFileSync(ticketFile(id), JSON.stringify(t)); };
// A ticket as createApproval wrote it before the cut, sealed with the real key.
const legacyTicket = (question) => {
    const now = Date.now();
    const ticket = { id: `ask-${now.toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`, agent: 'Codex', question, context: null, options: null,
        action: cast, status: 'pending', note: null, option: null, tier: 'T2', createdAt: now, expiresAt: now + 30 * 60_000, answeredAt: null, answeredVia: null };
    ticket.askSeal = askSeal(ticket);
    fs.mkdirSync(approvalsDir(project), { recursive: true });
    fs.writeFileSync(ticketFile(ticket.id), JSON.stringify(ticket, null, 2));
    return ticket;
};

try {
    check('a plain question is T0; a ticket from before the cut with an action is T2', approvalTier(null) === 'T0' && approvalTier(cast) === 'T2');
    check('only T0 is approvable remotely today; everything is approvable locally',
        tierAllows('T0', 'remote') && !tierAllows('T1', 'remote') && !tierAllows('T2', 'remote') && ['T0', 'T1', 'T2'].every(t => tierAllows(t, 'local')));
    check('a new ticket cannot carry an action', /Invalid approval action/.test(throws(() => createApproval(project, { agent: 'Codex', question: 'Cast the project?', action: cast }))));

    const plain = createApproval(project, { agent: 'Codex', question: 'Split the task in two?' });
    check('a new ticket stores its tier and an ask seal', plain.tier === 'T0' && plain.action === null && /^[a-f0-9]{64}$/.test(plain.askSeal));
    answerApproval(project, plain.id, { decision: 'approved', via: 'remote' });
    check('a phone may approve a plain question, and the answer records remote', readApproval(project, plain.id).status === 'approved' && readApproval(project, plain.id).answeredVia === 'remote');

    const install = legacyTicket('Cast the project?');
    check('a ticket from before the cut still verifies and lists as pending', readApproval(project, install.id).status === 'pending');
    check('a phone cannot approve a cast', /PLUTOS computer only/.test(throws(() => answerApproval(project, install.id, { decision: 'approved', via: 'remote' }))));
    check('the refused approval leaves it pending', readApproval(project, install.id).status === 'pending');
    const rejected = legacyTicket('Cast the project later?');
    answerApproval(project, rejected.id, { decision: 'rejected', via: 'remote' });
    check('a phone can always reject', readApproval(project, rejected.id).status === 'rejected');

    // Tampering: the cheap attack is editing the JSON in the project.
    const forged = legacyTicket('Cast the project again?');
    edit(forged.id, t => { t.status = 'approved'; t.answeredAt = Date.now(); t.answeredVia = 'local'; });
    check('a hand-approved ticket reads as tampered', readApproval(project, forged.id).status === 'tampered');
    let ran = false;
    const forgedRun = throws(() => runApprovedAction(project, forged.id, cast, () => { ran = true; }));
    check('a tampered approval runs nothing', !ran && /Invalid approval action|changed outside PLUTOS/.test(forgedRun), forgedRun);
    const forgedPlain = createApproval(project, { agent: 'Codex', question: 'Delete the backups?' });
    edit(forgedPlain.id, t => { t.status = 'approved'; t.answeredAt = Date.now(); t.answeredVia = 'local'; });
    check('a hand-approved plain question reads as tampered too', readApproval(project, forgedPlain.id).status === 'tampered');

    const swapped = legacyTicket('Cast the project?');
    edit(swapped.id, t => { t.action.proposal.kernel = 'Codex'; });
    check('a pending ticket whose action was swapped cannot be answered', /changed outside PLUTOS after it was asked/.test(throws(() => answerApproval(project, swapped.id, { decision: 'approved' }))));

    const relabelled = legacyTicket('Cast the project now?');
    check('a remote answer cannot be relabelled local', (() => {
        answerApproval(project, relabelled.id, { decision: 'rejected', via: 'remote' });
        edit(relabelled.id, t => { t.status = 'approved'; t.answeredVia = 'local'; });
        return readApproval(project, relabelled.id).status === 'tampered';
    })());

    const real = legacyTicket('Cast the project for real?');
    answerApproval(project, real.id, { decision: 'approved' });
    const settled = readApproval(project, real.id);
    check('a local approval of a ticket from before the cut settles cleanly and applies nothing',
        settled.status === 'approved' && settled.answeredVia === 'local' && applyApprovedSideEffects(project, settled) === null && readApproval(project, real.id).status === 'approved');
    let ranReal = false;
    check('no action runs any more, even on an intact approved ticket', /Invalid approval action/.test(throws(() => runApprovedAction(project, real.id, cast, () => { ranReal = true; }))) && !ranReal);
    // A/B design pick: a question may show renders, only from docs/ai/design-picks/ (owner, 2026-11-05).
    const picks = path.join(project, 'docs', 'ai', 'design-picks', 'today');
    fs.mkdirSync(picks, { recursive: true });
    fs.writeFileSync(path.join(picks, 'A.png'), 'png'); fs.writeFileSync(path.join(picks, 'B.png'), 'png');
    fs.writeFileSync(path.join(project, 'secret.png'), 'x');
    const pick = createApproval(project, { agent: 'Claude', question: 'Which design for Today?', options: ['A', 'B', 'Neither'], images: ['docs/ai/design-picks/today/A.png', './docs/ai/design-picks/today/B.png'] });
    check('a design pick keeps its images, normalised, and its seal holds', JSON.stringify(pick.images) === JSON.stringify(['docs/ai/design-picks/today/A.png', 'docs/ai/design-picks/today/B.png']) && readApproval(project, pick.id).images.length === 2);
    const picked = (answerApproval(project, pick.id, { decision: 'approved', option: 'B', note: 'less text' }), readApproval(project, pick.id));
    check('the owner picks B with a note', picked.status === 'approved' && picked.option === 'B' && picked.note === 'less text');
    check('an image outside design-picks is refused', /under docs\/ai\/design-picks/.test(throws(() => createApproval(project, { agent: 'C', question: 'q', images: ['secret.png'] }))));
    check('a path that climbs out is refused', /under docs\/ai\/design-picks/.test(throws(() => createApproval(project, { agent: 'C', question: 'q', images: ['docs/ai/design-picks/../../../secret.png'] }))));
    check('a missing image is refused', /No image at/.test(throws(() => createApproval(project, { agent: 'C', question: 'q', images: ['docs/ai/design-picks/today/C.png'] }))));
    check('a non-image is refused', /under docs\/ai\/design-picks/.test(throws(() => createApproval(project, { agent: 'C', question: 'q', images: ['docs/ai/design-picks/today/A.html'] }))));
    check('at most four images', /At most 4 images/.test(throws(() => createApproval(project, { agent: 'C', question: 'q', images: Array(5).fill('docs/ai/design-picks/today/A.png') }))));
    if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(project, 'secret.png'), path.join(picks, 'link.png'));
        check('a link from design-picks to another project file is refused', /No image at/.test(throws(() => designPickImagePath(project, 'docs/ai/design-picks/today/link.png'))));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-outside-'));
        fs.writeFileSync(path.join(outside, 'o.png'), 'x');
        fs.symlinkSync(path.join(outside, 'o.png'), path.join(picks, 'out.png'));
        check('a link to a file outside the project is refused', /No image at/.test(throws(() => designPickImagePath(project, 'docs/ai/design-picks/today/out.png'))));
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-outdir-'));
        fs.writeFileSync(path.join(outDir, 'x.png'), 'x');
        fs.symlinkSync(outDir, path.join(project, 'docs', 'ai', 'design-picks', 'linked'), 'dir');
        check('a linked folder inside design-picks that points outside is refused', /No image at/.test(throws(() => designPickImagePath(project, 'docs/ai/design-picks/linked/x.png'))));
        fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true });
    }
    check('the same image written two ways is one image', /distinct/.test(throws(() => createApproval(project, { agent: 'C', question: 'q', images: ['docs/ai/design-picks/today/A.png', 'docs/ai/design-picks//today/./A.png'] }))));
    fs.writeFileSync(path.join(picks, 'big.png'), Buffer.alloc(8 * 1048576 + 1));
    check('an image over 8 MB is refused', /over 8 MB/.test(throws(() => createApproval(project, { agent: 'C', question: 'q', images: ['docs/ai/design-picks/today/big.png'] }))));
    const tampered = JSON.parse(fs.readFileSync(path.join(approvalsDir(project), `${pick.id}.json`), 'utf8'));
    check('a ticket without images still seals as before', askSeal({ ...tampered, images: undefined }) !== tampered.askSeal && askSeal(tampered) === tampered.askSeal);
    check('the seal key lives in the data folder, not the project',
        fs.existsSync(path.join(home, 'approval-seal.key')) && !fs.readdirSync(path.join(project, '.plutos'), { recursive: true }).some(f => String(f).includes('seal.key')));
} finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
}
console.log(`Approval tiers and seals: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
