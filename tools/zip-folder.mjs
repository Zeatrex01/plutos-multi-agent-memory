// Zips a folder's contents (not the folder itself) with the platform's own archiver, so packing
// needs no npm dependency: PowerShell's ZipFile on Windows, `zip` elsewhere.
import fs from 'fs';
import { execFileSync } from 'child_process';

export function zipFolder(sourceDir, zipPath) {
    fs.rmSync(zipPath, { force: true });
    if (process.platform === 'win32') {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:PLUTOS_PACK_SOURCE, $env:PLUTOS_PACK_ZIP)'],
        { windowsHide: true, env: { ...process.env, PLUTOS_PACK_SOURCE: sourceDir, PLUTOS_PACK_ZIP: zipPath } });
    } else execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: sourceDir });
}
