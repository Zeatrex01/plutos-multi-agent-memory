// Browser-module execution with synthetic projects/tickets; never contacts a live server.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const code = [source('../ui/esc.js'), source('../ui/modules/project-key.js'), source('../ui/modules/approvals.js')].join('\n');
const ticket = (question = 'Question A', id = 'ask-copy-abcdef') => ({ id, agent: 'AI', question, expiresAt: Date.now() + 120000 });
const payload = (root = 'C:/A', questions = [ticket()]) => ({ projectRoot: root, pending: questions });
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };

// The questions render into Home's #home-waiting container; the other pages only get a count on
// the Home nav item. `home` is null to model a page without the Home markup.
function harness(active = 'C:/A', { home = true, t = key => key } = {}) {
    let cards = [], renders = 0;
    const requests = [], toasts = [];
    const badge = () => ({ className: '', textContent: '', title: '', remove() { navButton.badge = null; } });
    const navButton = { badge: null, querySelector: () => navButton.badge, appendChild: element => { navButton.badge = element; } };
    const container = home ? {
        set innerHTML(value) {
            this.html = value; renders++;
            cards = [...value.matchAll(/class="ask-card" data-ask-id="([^"]*)" data-ask-project-root="([^"]*)"/g)]
                .map(match => {
                    const card = { dataset: { askId: match[1], askProjectRoot: match[2] },
                        input: { value: '' }, ttl: {},
                        remove: () => { cards = cards.filter(item => item !== card); } };
                    return card;
                });
        },
        get innerHTML() { return this.html || ''; }
    } : null;
    const document = {
        hidden: false,
        createElement: () => badge(),
        getElementById: id => id === 'home-waiting' ? container : cards.find(card => id === `ask-note-${card.dataset.askId}`)?.input,
        querySelector: selector => selector.startsWith('.ask-card')
            ? cards.find(card => selector.includes(`"${card.dataset.askId}"`))
            : cards.find(card => selector.includes(`"${card.dataset.askId}"`))?.ttl,
        querySelectorAll: selector => selector.includes('tab-btn') ? [navButton] : [],
        addEventListener: () => {}
    };
    const window = { activeWorkspacePath: active, addEventListener: () => {} };
    const context = vm.createContext({ document, window, CSS: { escape: value => value }, t,
        localStorage: { getItem: () => null, setItem: () => {} }, showToast: (...args) => toasts.push(args),
        setInterval: () => 1,
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
    vm.runInContext(code + '\nglobalThis.api = { tick, refreshApprovals };', context);
    const reply = (index, data, ok = true) => requests[index].resolve({ ok, json: async () => data });
    return { ...context.api, window, requests, reply, toasts, navButton, get cards() { return cards; },
        get html() { return container?.innerHTML || ''; }, get renders() { return renders; } };
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
    check('the Home nav item carries the count of waiting questions', h.navButton.badge?.textContent === '1');
    const refresh = h.refreshApprovals(); h.reply(2, payload()); await refresh;
    check('opening Home refreshes without repainting an unchanged set', h.renders === renders && h.cards[0].input.value === 'Keep my draft');
    const wrong = h.tick(); h.reply(3, payload('C:/B', [ticket('Wrong project')]));
    check('a response from another project is rejected', !await wrong && !h.html.includes('Wrong project'));
    const offline = h.tick(); h.requests[4].reject(new Error('offline'));
    check('an offline refresh keeps the cards already shown', !await offline && h.cards.length === 1);
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

{
    const h = harness();
    const empty = h.tick(); h.reply(0, payload('C:/A', [])); await empty;
    check('no waiting question shows one line on Home and no count', h.html.includes('home_waiting_none') && h.cards.length === 0 && !h.navButton.badge);
    const images = { ...ticket('Pick one'), options: ['Left', 'Right'], images: ['shots/a.png', 'shots/b.png'] };
    const withImages = h.tick(); h.reply(1, payload('C:/A', [images])); await withImages;
    check('a question shows its images inline, each through the scoped image route',
        (h.html.match(/<img src="\/api\/approvals\/image\?project=C%3A%2FA&amp;path=shots%2F[ab]\.png"/g) || []).length === 2);
    check('option buttons replace the plain approve button', h.html.includes('ask-opt') && !h.html.includes('ask-yes'));
}

{
    // The note placeholder's example is quoted ("do B instead"); unescaped, the quote closed the
    // attribute and the placeholder read "Optional note back to the agent — e.g." (2026-11-14).
    const h = harness('C:/A', { t: key => key === 'approval_note_ph' ? 'Note — e.g. "do B instead"' : key });
    const quoted = h.tick(); h.reply(0, payload()); await quoted;
    check('the note placeholder keeps its quoted example', h.html.includes('placeholder="Note — e.g. &quot;do B instead&quot;"'));
}

{
    const h = harness('C:/A', { home: false });
    const offPage = h.tick(); h.reply(0, payload()); await offPage;
    check('without Home markup nothing is drawn over the page, only the nav count', h.cards.length === 0 && h.navButton.badge?.textContent === '1');
}

console.log(`\n${passed} passed, 0 failed`);
