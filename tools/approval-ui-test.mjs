// Browser-module execution with synthetic projects/tickets; never contacts a live server.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const code = [source('../ui/esc.js'), source('../ui/modules/return-summary.js'), source('../ui/modules/approvals.js')].join('\n');
const ticket = (question = 'Question A', id = 'ask-copy-abcdef') => ({ id, agent: 'AI', question, expiresAt: Date.now() + 120000 });
const payload = (root = 'C:/A', questions = [ticket()]) => ({ projectRoot: root, pending: questions });
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };

function harness(active = 'C:/A') {
    let dock, cards = [], renders = 0, focused = 0;
    const requests = [], toasts = [];
    const document = {
        body: { appendChild: element => { dock = element; } },
        createElement: () => ({
            set innerHTML(value) {
                this.html = value; renders++;
                cards = [...value.matchAll(/class="ask-card" data-ask-id="([^"]*)" data-ask-project-root="([^"]*)"/g)]
                    .map(match => {
                        const card = { dataset: { askId: match[1], askProjectRoot: match[2] },
                            input: { value: '', focus: () => { focused++; } }, ttl: {},
                            remove: () => { cards = cards.filter(item => item !== card); },
                            scrollIntoView: () => {}, querySelector: () => card.input };
                        return card;
                    });
            },
            get innerHTML() { return this.html || ''; }
        }),
        getElementById: id => id === 'ask-dock' ? dock : cards.find(card => id === `ask-note-${card.dataset.askId}`)?.input,
        querySelector: selector => selector.startsWith('.ask-card')
            ? cards.find(card => selector.includes(`"${card.dataset.askId}"`))
            : cards.find(card => selector.includes(`"${card.dataset.askId}"`))?.ttl,
        querySelectorAll: () => cards,
        addEventListener: () => {}
    };
    const window = { activeWorkspacePath: active, addEventListener: () => {} };
    const context = vm.createContext({ document, window, CSS: { escape: value => value }, t: key => key,
        localStorage: { getItem: () => null, setItem: () => {} }, showToast: (...args) => toasts.push(args),
        setInterval: () => 1,
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
    vm.runInContext(code + '\nglobalThis.api = { tick };', context);
    const reply = (index, data, ok = true) => requests[index].resolve({ ok, json: async () => data });
    return { ...context.api, window, requests, reply, toasts, get cards() { return cards; },
        get html() { return dock?.innerHTML || ''; }, get renders() { return renders; }, get focused() { return focused; } };
}

{
    const h = harness(undefined);
    h.window.activeWorkspacePath = undefined;
    check('unknown project never issues an unscoped approval request', !await h.tick() && h.requests.length === 0);
}

{
    const h = harness();
    const initial = h.tick(); h.reply(0, payload()); await initial;
    check('polling names the captured project', new URL(h.requests[0].url, 'http://localhost').searchParams.get('project') === 'C:/A');
    check('each displayed card carries its verified response root', h.cards[0].dataset.askProjectRoot === 'C:/A');
    h.cards[0].input.value = 'Keep my draft';
    const renders = h.renders;
    const repeat = h.tick(); h.reply(1, payload()); await repeat;
    check('unchanged project and tickets preserve the draft input', h.renders === renders && h.cards[0].input.value === 'Keep my draft');
    const focus = h.window.focusApproval(ticket().id, 'c:/a'); h.reply(2, payload()); await focus;
    check('summary focus verifies and opens the requested project ticket', h.focused === 1);
    const wrong = h.tick(); h.reply(3, payload('C:/B', [ticket('Wrong project')]));
    check('a response from another project is rejected', !await wrong && !h.html.includes('Wrong project'));
    const offlineFocus = h.window.focusApproval(ticket().id, 'C:/A'); h.requests[4].reject(new Error('offline')); await offlineFocus;
    check('failed refresh cannot focus an unverified cached question', h.focused === 1 && h.toasts.at(-1)[1] === true);
}

{
    const h = harness();
    const old = h.tick(), current = h.tick();
    h.reply(1, payload('C:/A', [ticket('Newest question', 'ask-new-abcdef')])); await current;
    h.reply(0, payload()); await old;
    check('out-of-order polling cannot restore an older ticket set', h.html.includes('Newest question') && !h.html.includes('Question A'));
    const moving = h.tick(); h.window.activeWorkspacePath = 'C:/B'; h.reply(2, payload('C:/A', [ticket('Late A')])); await moving;
    check('project changes while fetching reject the old project response', !h.html.includes('Late A'));
}

{
    const h = harness();
    const initial = h.tick(); h.reply(0, payload()); await initial;
    h.window.activeWorkspacePath = 'C:/B';
    const switched = h.tick();
    check('a known project switch removes old cards before fetching', h.cards.length === 0);
    h.reply(1, payload('C:/B', [ticket('Question B')])); await switched;
    check('copied ticket IDs are separated by the project fingerprint', h.html.includes('Question B') && h.cards[0].dataset.askProjectRoot === 'C:/B');
    const before = h.requests.length;
    await h.window.answerAsk(ticket().id, 'approved', undefined, 'C:/A');
    check('a delayed old-card click cannot answer a same-ID ticket in another project', h.requests.length === before && h.toasts.at(-1)[1]);
    await h.window.focusApproval(ticket().id, 'C:/A');
    check('stale summary focus cannot open a copied ticket in the new project', h.requests.length === before && h.focused === 0);
}

{
    const h = harness();
    const initial = h.tick(); h.reply(0, payload()); await initial;
    h.cards[0].input.value = 'Captured note';
    const oldRead = h.tick();
    h.window.activeWorkspacePath = 'C:/B';
    const answer = h.window.answerAsk(ticket().id, 'approved', undefined, 'C:/A');
    const sent = JSON.parse(h.requests[2].options.body);
    check('answers post the displayed root and draft, never the new active root', sent.projectRoot === 'C:/A' && sent.note === 'Captured note');
    h.reply(1, payload()); await oldRead;
    check('a read started before answering cannot recreate the removed card', h.cards.length === 0);
    h.reply(2, { success: false, message: 'Project changed' }, false); await answer;
    check('server project rejection is surfaced as a failure', h.toasts.at(-1)[0] === 'Project changed' && h.toasts.at(-1)[1]);
    h.reply(3, payload('C:/B', []));
    await new Promise(resolve => setImmediate(resolve));
    check('after answering, the next refresh names the current known project', new URL(h.requests[3].url, 'http://localhost').searchParams.get('project') === 'C:/B');
}

console.log(`\n${passed} passed, 0 failed`);
