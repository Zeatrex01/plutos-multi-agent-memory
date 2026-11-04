// Whether a module is the script Node was started with, for files that are both a library and a
// command (a hook, a worker). Inside a bundle (build.mjs) every module shares the bundle's own URL,
// so the plain comparison is true for all of them at once: each command ran on load, and the
// bundled MCP server exited before it answered. The build defines these two variables, so inside a
// bundle this is false. No other imports: hooks load this on every tool call.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLED = process.env.PLUTOS_PACKAGED === '1' || process.env.PLUTOS_BUNDLED_MCP === '1';

export const isEntry = url => !BUNDLED && !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(url));
