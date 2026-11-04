// Folder navigation for the in-page "Add Project" browser.
import fs from 'fs';
import path from 'path';

// → { path, parent, dirs: [{name, path}] } ; empty reqPath lists drives (win) or / (unix)
export function listDirs(reqPath) {
    if (!reqPath) {
        const drives = [];
        if (process.platform === 'win32') {
            for (let i = 65; i <= 90; i++) {
                const d = String.fromCharCode(i) + ':/';
                if (fs.existsSync(d)) drives.push({ name: d, path: d });
            }
        } else {
            drives.push({ name: '/', path: '/' });
        }
        return { path: '', parent: null, dirs: drives };
    }
    const normalized = path.resolve(reqPath).split(path.sep).join('/');
    const dirs = fs.readdirSync(normalized, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('$') && d.name !== 'System Volume Information')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => ({ name: d.name, path: (normalized.endsWith('/') ? normalized : normalized + '/') + d.name }));
    const parentRaw = path.dirname(normalized);
    const parent = parentRaw === normalized ? null : parentRaw.split(path.sep).join('/');
    return { path: normalized, parent, dirs };
}
