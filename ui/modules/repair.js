// An explicit project target and saved preview travel with every repair/restore click.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';
import { showToast } from './toast.js';

let dialog;
let generation = 0;

async function request(url, body) {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json();
    if (!response.ok || result.success === false) throw Object.assign(new Error(result.message || (result.errors || []).map(e => e.message || e).join('; ') || t('repair_failed')), { result });
    return result;
}

function ensureDialog() {
    if (dialog?.isConnected) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'repair-dialog';
    dialog.addEventListener('cancel', event => { if (dialog.dataset.busy === 'true') event.preventDefault(); });
    // margin:auto centres the open dialog; the page's `* { margin: 0 }` reset had pinned it top-left.
    dialog.style.cssText = 'margin:auto;width:min(720px,90vw);max-height:85vh;overflow:auto;background:var(--bg-primary);color:var(--text-title);border:1px solid var(--border-subtle);border-radius:12px;padding:1.4rem;';
    document.body.appendChild(dialog);
    return dialog;
}

function frame(host, project, body) {
    host.innerHTML = `<h2 style="margin-top:0;">${t('repair_title')}</h2>
        <p>${t('repair_target')}</p><p style="overflow-wrap:anywhere;font-family:var(--font-mono);">${escHtml(project)}</p>
        <div id="repair-body">${body}</div><p role="status" id="repair-message" style="overflow-wrap:anywhere;"></p>
        <button id="repair-close" class="btn-secondary" style="margin-top:1rem;">${t('repair_close')}</button>`;
    host.querySelector('#repair-close').addEventListener('click', () => host.close());
}

function backupsHtml(backups) {
    if (!backups?.length) return '';
    return `<h3>${t('repair_backups')}</h3>${backups.map((b, i) => `<div style="display:flex;gap:1rem;align-items:center;margin-top:0.6rem;">
        <span>${escHtml(new Date(b.createdAt).toLocaleString())}</span>
        <button class="btn-secondary btn-sm" data-restore="${i}">${t('repair_restore')}</button></div>`).join('')}`;
}

async function restore(host, project, backupId) {
    const message = host.querySelector('#repair-message');
    const buttons = [...host.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    host.dataset.busy = 'true';
    try {
        const result = await request('/api/workspaces/repair/restore', { projectRoot: project, backupId });
        frame(host, project, `<p>${t('repair_restored')}</p><p>${escHtml((result.restored || []).join(', '))}</p>`);
    } catch (error) { message.textContent = error.message; }
    finally { host.dataset.busy = 'false'; buttons.forEach(button => { button.disabled = false; }); }
}

function bindBackups(host, project, backups) {
    host.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', () => {
        const backup = backups[Number(button.dataset.restore)];
        if (!backup) return;
        frame(host, project, `<p>${t('repair_restore_confirm')}</p>
            <ul>${(backup.changed || []).map(file => `<li>${escHtml(file)}</li>`).join('')}</ul>
            <button id="repair-restore-confirm" class="btn-primary">${t('repair_restore')}</button>`);
        host.querySelector('#repair-restore-confirm').addEventListener('click', () => restore(host, project, backup.backupId));
    }));
}

async function showPreview(host, project, requestGeneration = ++generation) {
    frame(host, project, `<p>${t('loading')}</p>`);
    try {
        const preview = await request(`/api/workspaces/repair/preview?project=${encodeURIComponent(project)}`);
        if (!host.open || requestGeneration !== generation) return;
        const changes = preview.changes || [], backups = preview.backups || [];
        frame(host, preview.projectRoot, `<p>${t('repair_preview_note')}</p>
            ${changes.length ? `<ul>${changes.map(change => `<li style="margin:0.6rem 0;overflow-wrap:anywhere;"><b>${escHtml(change.path)}</b> — ${escHtml(change.reason || change.action)}</li>`).join('')}</ul>` : `<p>${t('repair_no_changes')}</p>`}
            ${(preview.warnings || []).map(warning => `<p>${escHtml(typeof warning === 'string' ? warning : warning.message)}</p>`).join('')}
            ${changes.length ? `<button id="repair-apply" class="btn-primary">${t('repair_apply')}</button>` : ''}
            ${backupsHtml(backups)}`);
        bindBackups(host, preview.projectRoot, backups);
        host.querySelector('#repair-apply')?.addEventListener('click', async () => {
            const buttons = [...host.querySelectorAll('button')];
            buttons.forEach(button => { button.disabled = true; });
            host.dataset.busy = 'true';
            try {
                const result = await request('/api/workspaces/repair', { projectRoot: preview.projectRoot, token: preview.token });
                const saved = result.backupId && result.restoreAvailable !== false
                    ? [{ backupId: result.backupId, createdAt: new Date().toISOString(), changed: result.changed || [] }] : [];
                frame(host, result.projectRoot, `<p>${t('repair_done')}</p>
                    <ul>${(result.changed || []).map(file => `<li>${escHtml(file)}</li>`).join('')}</ul>
                    ${(result.warnings || []).map(warning => `<p>${escHtml(typeof warning === 'string' ? warning : warning.message)}</p>`).join('')}
                    ${backupsHtml(saved)}`);
                bindBackups(host, result.projectRoot, saved);
            } catch (error) {
                const result = error.result;
                if (result?.backupId && result.restoreAvailable) {
                    const backups = [{ backupId: result.backupId, createdAt: new Date().toISOString(), changed: result.changed || [] }];
                    frame(host, preview.projectRoot, `<p>${escHtml(error.message)}</p>${backupsHtml(backups)}`);
                    bindBackups(host, preview.projectRoot, backups);
                } else {
                    const message = host.querySelector('#repair-message');
                    message.textContent = error.message + ' ';
                    const retry = document.createElement('button');
                    retry.className = 'btn-secondary btn-sm';
                    retry.textContent = t('repair_refresh');
                    retry.addEventListener('click', () => showPreview(host, preview.projectRoot));
                    message.appendChild(retry);
                }
            } finally { host.dataset.busy = 'false'; buttons.forEach(button => { button.disabled = false; }); }
        });
    } catch (error) { if (requestGeneration === generation && host.open) host.querySelector('#repair-message').textContent = error.message; }
}

export async function openProjectRepair() {
    const project = window.activeWorkspacePath;
    if (!project) { showToast(t('repair_select_project'), true); return; }
    const host = ensureDialog();
    if (host.open) return;
    host.showModal();
    await showPreview(host, project);
}
