// board_read deltas (lib/board-delta.mjs): what one session was shown, and what changed since.
// The protocol side (cursor, since, short revisions) is in tools/mcp-test.mjs.
import { createBoardReads } from '../lib/board-delta.mjs';
import { parseBoardEntries } from '../lib/board.mjs';

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };
const board = (...blocks) => parseBoardEntries(blocks.map(([agent, status, title, task]) => `### ${agent} · ${status} · ${title}\n- **Task:** ${task}\n`).join('\n'));
const titles = list => list.map(e => e.title).join(',');

const read = createBoardReads();
const v1 = board(['A', 'TODO', 'one', 'x'], ['B', 'TODO', 'two', 'y'], ['C', 'DONE', 'three', 'z']);
const first = read('main:', v1);
check('a first read is full and has a 12-hex cursor', first.mode === 'full' && first.shown.length === 3 && /^[0-9a-f]{12}$/.test(first.cursor));
check('the same board shown in full gives the same cursor', read('main:', v1).cursor === first.cursor);

const v2 = board(['A', 'IN_PROGRESS', 'one', 'x'], ['B', 'TODO', 'two', 'y'], ['D', 'TODO', 'four', 'w']);
const second = read('main:', v2, first.cursor);
check('a changed and an added entry come back, the untouched one does not', second.mode === 'delta' && titles(second.shown) === 'one,four', titles(second.shown));
check('a removed entry is named', second.removed.length === 1 && second.removed[0].agent === 'C' && second.removed[0].title === 'three', JSON.stringify(second.removed));
check('the rest is counted', second.unchanged === 1);
const again = read('main:', v2, second.cursor);
check('an unchanged board reports same, with the same cursor', again.mode === 'same' && again.shown.length === 0 && again.cursor === second.cursor && again.unchanged === 3);
check('an older cursor still diffs against what it was', titles(read('main:', v2, first.cursor).shown) === 'one,four');

check('a cursor from another board is not used', read('agents:', v2, first.cursor).mode === 'unknown');
check('an unknown cursor is a full read', read('main:', v2, 'ffffffffffff').mode === 'unknown');

// A read that trims to its limit records only what it returned.
const trimmed = read('main:', v2, undefined, pool => pool.slice(0, 1));
check('a trimmed read returns what the limit allows and counts the rest as pending', trimmed.shown.length === 1 && trimmed.pending === 3);
const followUp = read('main:', v2, trimmed.cursor);
check('the entries a trimmed read left out come back on the next delta', followUp.mode === 'delta' && titles(followUp.shown) === 'two,four', titles(followUp.shown));
check('and only then is the board the same', read('main:', v2, followUp.cursor).mode === 'same');

const d1 = read('main:', board(['A', 'TODO', 'same', 'first'], ['A', 'TODO', 'same', 'second']));
const d2 = read('main:', board(['A', 'TODO', 'same', 'first'], ['A', 'TODO', 'same', 'changed']), d1.cursor);
check('two entries with the same agent and title are told apart', d2.shown.length === 1 && d2.shown[0].fields.Task === 'changed', JSON.stringify(d2.shown));

const small = createBoardReads({ max: 2 });
const s1 = small('main:', board(['A', 'TODO', 'a', 'x']));
small('main:', board(['A', 'TODO', 'b', 'x'])); small('main:', board(['A', 'TODO', 'c', 'x']));
check('old snapshots are dropped past the limit', small('main:', board(['A', 'TODO', 'c', 'x']), s1.cursor).mode === 'unknown');
check('a separate server process knows none of these cursors', createBoardReads()('main:', v2, second.cursor).mode === 'unknown');

console.log(`Board deltas: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
