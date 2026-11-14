// The static approvals page: what it lists, what it escapes, and that it answers nothing. Synthetic
// home and project in a temp folder; the browser launcher is a fake on PATH, never a real browser.
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-approvals-page-'));
process.env.PLUTOS_HOME = path.join(temp, 'home');
process.env.HOME = process.env.USERPROFILE = path.join(temp, 'user');
const { createApproval, writeApprovalsPage, approvalsDir, APPROVALS_PAGE, answerCommands, resolveOptionArg, shellQuote } = await import('../lib/approvals.mjs');

let passed = 0;
const check = (name, cond) => { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); };

try {
    const project = path.join(temp, 'project');
    const picks = path.join(project, 'docs', 'ai', 'design-picks', 'today page');
    fs.mkdirSync(picks, { recursive: true });
    fs.writeFileSync(path.join(picks, 'A.png'), 'png');
    fs.writeFileSync(path.join(picks, 'B.png'), 'png');

    const empty = writeApprovalsPage(project);
    check('the page is written under design-picks and its path returned', empty === path.join(project, ...APPROVALS_PAGE.split('/'))
        && fs.readFileSync(empty, 'utf8').includes('No questions waiting.'));
    {
        const { execFileSync } = await import('child_process');
        let git = true; try { execFileSync('git', ['init', '-q', project], { stdio: 'ignore' }); } catch { git = false; }
        if (git) {
            writeApprovalsPage(project);
            let ignored = true; try { execFileSync('git', ['check-ignore', '-q', APPROVALS_PAGE], { cwd: project, stdio: 'ignore' }); } catch { ignored = false; }
            check('the page is kept out of git (pending questions are not project history)', ignored);
        }
    }

    const pick = createApproval(project, { agent: 'Claude', question: 'Which <b>design</b> & why?', context: 'Two "renders"',
        options: ['A <script>', 'B'], images: ['docs/ai/design-picks/today page/A.png', 'docs/ai/design-picks/today page/B.png'] });
    const plain = createApproval(project, { agent: 'Codex', question: 'Ship it?' });
    const html = fs.readFileSync(writeApprovalsPage(project), 'utf8');

    check('every pending ticket is listed, one without images included', html.includes(pick.id) && html.includes(plain.id) && html.includes('Ship it?'));
    check('text is escaped', html.includes('Which &lt;b&gt;design&lt;/b&gt; &amp; why?') && html.includes('A &lt;script&gt;')
        && html.includes('Two &quot;renders&quot;') && !html.includes('<b>design'));
    check('options are numbered', /<ol><li>A &lt;script&gt;<\/li><li>B<\/li><\/ol>/.test(html));
    check('images are relative to the page and labelled by option', html.includes('<img src="today%20page/A.png" alt="Option 1: A &lt;script&gt;">')
        && html.includes('<img src="today%20page/B.png" alt="Option 2: B">') && html.includes('<figcaption>Option 2: B</figcaption>'));
    // By number, with the CLI's absolute path and the project: option text never reaches the shell.
    const cmds = answerCommands(project, pick);
    check('each option has its exact answer command, by number, runnable from any folder',
        cmds.length === 3 && cmds.every(c => html.includes(c.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;')))
        && /^node '.*cli\.mjs' approve ask-\S+ '.*project' --option 1$/.test(answerCommands(project, pick, { platform: 'linux' })[0]) && cmds[1].endsWith('--option 2')
        && /reject ask-\S+ '.*project'$/.test(answerCommands(project, pick, { platform: 'linux' })[2]) && cmds.every(c => !c.includes('script')));
    check('a ticket without options gets approve and reject, no --option', answerCommands(project, plain).length === 2
        && !answerCommands(project, plain).some(c => c.includes('--option')));
    const hostile = createApproval(project, { agent: 'Claude', question: 'Pick', options: ['$(touch pwned)', '`id` "x" \'y\''] });
    check('option text with shell syntax never appears in a command', answerCommands(project, hostile).every(c => !/pwned|`id`/.test(c)));
    check('Windows commands use double quotes', /^node ".*cli\.mjs" approve \S+ ".*project" --option 1$/.test(answerCommands(project, hostile, { platform: 'win32' })[0]));
    check('a path with a single quote stays one POSIX word', shellQuote("/tmp/o'neil", 'linux') === "'/tmp/o'\\''neil'");
    check('--option takes the number or the exact text, and passes anything else through for answerApproval to refuse',
        resolveOptionArg(hostile, '1') === '$(touch pwned)' && resolveOptionArg(hostile, ' 2 ') === hostile.options[1]
        && resolveOptionArg(pick, 'B') === 'B' && resolveOptionArg(pick, '3') === '3' && resolveOptionArg(pick, undefined) === undefined
        && resolveOptionArg(createApproval(project, { agent: 'C', question: 'n', options: ['2', '1'] }), '1') === '1');
    check('the page answers nothing: no script, form, fetch or POST, and a CSP that forbids them',
        !/<script|<form|fetch\(|POST|<button/i.test(html.replace(/&lt;script&gt;/g, '')) && html.includes("default-src 'none'"));

    // A ticket edited on disk fails its seal and is not shown as a question to answer.
    const file = path.join(approvalsDir(project), `${plain.id}.json`);
    const ticket = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...ticket, question: 'Delete everything?' }));
    const after = fs.readFileSync(writeApprovalsPage(project), 'utf8');
    check('a tampered ticket is left off the page', !after.includes('Delete everything?') && !after.includes(plain.id));
    check('writing the page leaves every ticket pending', JSON.parse(fs.readFileSync(path.join(approvalsDir(project), `${pick.id}.json`), 'utf8')).status === 'pending');

    fs.rmSync(path.join(picks, 'B.png'));
    check('an image gone since asking is reported, not linked', fs.readFileSync(writeApprovalsPage(project), 'utf8')
        .includes('Missing: docs/ai/design-picks/today page/B.png'));

    if (process.platform !== 'win32') {
        // open:true hands the page's file URL to the launcher lib/open-browser.mjs runs.
        const bin = path.join(temp, 'bin');
        const marker = path.join(temp, 'opened.txt');
        fs.mkdirSync(bin);
        for (const name of ['xdg-open', 'open']) {
            fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
        }
        const PATH = process.env.PATH;
        process.env.PATH = `${bin}${path.delimiter}${PATH}`;
        try { writeApprovalsPage(project, { open: true }); } finally { process.env.PATH = PATH; }
        for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 20));
        check('open:true opens the page in the browser', fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').startsWith('file://')
            && fs.readFileSync(marker, 'utf8').endsWith('pending.html'));
    }
    console.log(`\n${passed} passed, 0 failed`);
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
