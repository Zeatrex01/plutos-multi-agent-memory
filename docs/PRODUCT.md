# The PLUT_OS product

PLUT_OS is open source under the Apache License 2.0. The product is the portable folder `npm run build`
writes to `dist/`. It is the smallest set that runs PLUT_OS. It holds no research, no owner records and
no source maps, and it is ready for a later public extraction if the owner ever wants one. The list of
what ships is in `tools/product.mjs`. `build.mjs` copies from that list, and `tools/product-test.mjs`
checks it in `npm test`, so the build and the check cannot drift apart.

## What ships

| In `dist/` | From | Why |
|---|---|---|
| `PLUT_OS` (`PLUT_OS.exe` on Windows) | `dashboard.mjs`, bundled with `lib/` into a Node single-executable | The dashboard; it needs no Node on the machine. A build targets the OS it runs on. |
| `index.mjs` | `index.mjs`, bundled with `lib/` and the npm dependencies | The MCP server each AI client starts with its own Node; no `npm install` needed. |
| `ui/`, `dashboard-ui.html`, `browser-client/` | the same paths | The interface, served by the dashboard; the optional browser client. |
| `lib/` | `lib/` | Modules that run from source: the hooks (session brief, guard, push gate, claim check), the detached context worker and the research fetcher's Python bridge. |
| `scaffold/` | `scaffold/` | The kit a project receives. |
| `cli.mjs` | `cli.mjs` | `plutos report`, `plutos check` and the other commands, which need no AI. |
| `tools/council.mjs`, `council.config.json` | the same paths | The council moderator and its departments. |
| `AGENTS.md`, `package.json` | the same paths | The coordination rules a kit installs; the version. |
| `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `README.txt` | `LICENSE`; written by the build | The licence, the licences of the software inside, how to run it. |

A file git ignores is never copied. A new file not yet added to git is copied.

## What never ships

- `docs/` and the repository's own working records; `graphify-out/`, `.claude/`, `.plutos/`.
- The tests (`tools/*-test.mjs`, `tools/mcp-test.mjs`, `tools/smoke-test.mjs`) and the other developer tools in
  `tools/`, except `tools/council.mjs`.
- Source maps. esbuild writes none, and no shipped file carries a source-map comment.

## Licence

`LICENSE` is the Apache License 2.0 and `NOTICE` names the copyright holder and the vendored software. `package.json` says `Apache-2.0`; `private` stays set only so the folder is never published to npm by accident.
Third-party software keeps its own licence:

- `THIRD_PARTY_NOTICES.txt` is written at build time from what esbuild actually bundled. It gives each
  npm package's name, version, licence and licence text, and the licence of the Node.js runtime the
  executable is a copy of. At present the bundled packages are the MCP SDK and its dependencies:
  MIT, ISC and BSD-3-Clause.
- The vendored UI scripts in `ui/vendor/` (lucide, ISC; vis-network, Apache-2.0 or MIT)
  carry their licence headers.

Fonts and Godot export templates are not approved for download or redistribution. Ask the owner
first.

## How it is checked

`tools/product-test.mjs`, part of `npm test`:

1. The shipped source text holds no personal address, home-folder path, secret or source map. It uses
   the scanner in `lib/release-scan.mjs` on the shipped files only.
2. Nothing from the records, research or tests is on the shipped list.
3. A file git ignores is not copied; a new file not yet added is.
4. Both bundles build with the build's own options. The dashboard bundle is CommonJS, so a top-level
   `await` in any module it imports fails here, not on the owner's machine.
5. The bundled MCP server answers `initialize`. Inside a bundle every module shares the bundle's URL.
   Before `lib/entry.mjs`, a module that is also a command (a hook) ran its command on load, and the
   bundled server exited before it answered.
6. `THIRD_PARTY_NOTICES.txt` names every bundled package with its licence text, and Node.js.

The test bundles in a temp folder. It does not run the full build, which copies the Node binary. To
check a release by hand, run `npm run build`, start `dist/PLUT_OS --no-open` with `PLUTOS_PORT` set,
and send `initialize` to `node dist/index.mjs`.

For the whole repository rather than the product, `node tools/release-scan.mjs` reports what would
leak if it were published: personal information, secrets, source maps, Turkish text, and the names
in the untracked `.plutos/release-terms.txt` (the owner's list of other projects' names).

## Building

- `npm run build`: console build. `npm run build:app`: Windows, no console window. `npm run build:lite`:
  no exe; the dashboard is one bundle, `PLUT_OS.cjs`, started by `START_PLUT_OS.bat` or `start-plutos.sh`
  with the machine's Node 22+ (which the MCP server, the hooks and the CLI need anyway). About 5 MB
  instead of about 125 MB.
  `BUILD_PLUT_OS.bat` asks which one to build and runs `build.mjs` in the terminal.
- The build needs the devDependencies (esbuild, postject, resedit). The product needs none of them.
