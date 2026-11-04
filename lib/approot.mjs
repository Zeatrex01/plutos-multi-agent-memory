// Single source of the install root. Two cases:
//  - dev / repo checkout: this file lives in lib/, root is one level up
//  - packaged Windows exe (npm run build → dist/PLUT_OS.exe): the build defines
//    PLUTOS_PACKAGED at bundle time, and the exe ships in a portable folder with
//    ui/, scaffold/, and the templates sitting next to it — root is the exe's dir.
//  - lite package (npm run build:lite → dist/PLUT_OS.cjs run by the machine's Node): also
//    PLUTOS_PACKAGED, plus PLUTOS_LITE, so the root is the bundle's own folder, not Node's.
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultPlutosHome, devHomeConflict } from './home-dir.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = process.env.PLUTOS_PACKAGED === '1'
    ? (process.env.PLUTOS_LITE === '1' ? MODULE_DIR : path.dirname(process.execPath))
    : (process.env.PLUTOS_BUNDLED_MCP === '1'
        ? MODULE_DIR
        : path.resolve(MODULE_DIR, '..'));

export { defaultPlutosHome };

export const PLUTOS_HOME_IS_EXPLICIT = typeof process.env.PLUTOS_HOME === 'string'
    && process.env.PLUTOS_HOME.trim().length > 0;
export const PLUTOS_HOME_DIR = path.resolve(PLUTOS_HOME_IS_EXPLICIT
    ? process.env.PLUTOS_HOME
    : defaultPlutosHome());

// Stop before anything reads or writes the folder: lib/workspaces.mjs bootstraps it on import.
const DEV_HOME_CONFLICT = devHomeConflict(PLUTOS_HOME_DIR);
if (DEV_HOME_CONFLICT) throw new Error(DEV_HOME_CONFLICT);

// Read-only migration source. Only hub-owned files are copied from here; a project may also
// have its own `.plutos` directory, so migration must never move/delete the directory whole.
export const LEGACY_PLUTOS_HOME_DIR = path.join(APP_ROOT, '.plutos');
