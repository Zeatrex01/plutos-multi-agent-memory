// CodeBurn's machine-wide AI spend, run on request (the project's own ledger is lib/usage.mjs)
//
// This used to run `codeburn status` and scrape the two numbers out of its terminal output
// with a pair of regexes. That gave the tab exactly what `status` prints — today, and the
// current CALENDAR month to date — and nothing else, which is why the tab read as though it
// had no history: it shipped on the 1st of a month, so "this month" and "today" were the
// same figure while August sat at $3,008 one row away. Scraping a rendered, coloured,
// currency-formatted line was also brittle in three separate ways.
//
// `status --format menubar-json` fixes both problems at once. It returns JSON, and it always
// carries `history.daily` — every day CodeBurn holds in its durable rollup, independent of
// the period asked for. Verified against the CLI: summing that series reproduces its own
// `lifetime` totals to the cent (5351.42 / 49431 calls over 119 days). So one call is
// enough — every range below is aggregated here rather than re-invoking the CLI, which also
// keeps us off the `--period lifetime` path that takes ~30s against a ~5s call.
import childProcess from 'node:child_process';

let rawCache = null;
let lastFetch = null;
let updatedAt = null;
let refreshError = null;
let refresh = null;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds cache
// The old 8s budget was under the cold-start cost of `npx -y` and every overrun landed in
// the catch below as a zeroed "standby" card — indistinguishable, on screen, from having no
// data at all.
const CLI_TIMEOUT_MS = 25000;

// What the UI offers. `from` is resolved against the day the request is served, not the day
// the process started, so a dashboard left open overnight does not keep yesterday's window.
export const RANGES = ['today', '7d', '30d', 'month', 'all'];

function rangeStart(range, todayISO) {
    const today = new Date(todayISO + 'T00:00:00Z');
    const back = (days) => {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - days);
        return d.toISOString().slice(0, 10);
    };
    switch (range) {
        case 'today': return todayISO;
        case '7d': return back(6);      // inclusive of today
        case '30d': return back(29);
        case 'month': return todayISO.slice(0, 8) + '01';
        case 'all': return '';
        default: return '';
    }
}

function parseCli(raw) {
    const parsed = JSON.parse(raw);
    const daily = (parsed.history && Array.isArray(parsed.history.daily) ? parsed.history.daily : [])
        .filter(r => r && typeof r.date === 'string')
        .map(r => ({
            date: r.date,
            cost: Number(r.cost) || 0,
            calls: Number(r.calls) || 0,
            inputTokens: Number(r.inputTokens) || 0,
            outputTokens: Number(r.outputTokens) || 0
        }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
        daily,
        symbol: (parsed.currency && parsed.currency.symbol) || '$',
        sessions: parsed.current && Number(parsed.current.sessions) ? Number(parsed.current.sessions) : 0
    };
}

// Kill the owned process tree before its wrapper disappears. Killing cmd.exe alone can
// leave npx/CodeBurn running, with inherited pipes keeping the callback open indefinitely.
function stopCli(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        const killer = childProcess.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore', timeout: 5000
        });
        killer.on('error', () => { child.kill(); });
        killer.on('exit', code => { if (code) child.kill(); });
        killer.unref();
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
    }
}

function startRefresh() {
    const operation = { child: null, timer: null };
    refresh = operation;
    refreshError = null;
    const detach = () => {
        clearTimeout(operation.timer);
        process.removeListener('exit', onExit);
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
    };
    const onExit = () => {
        if (refresh !== operation) return;
        refresh = null;
        detach();
        stopCli(operation.child);
    };
    const onSignal = signal => {
        onExit();
        // Preserve another owner's signal handler; otherwise restore Node's normal exit.
        if (!process.listenerCount(signal)) process.kill(process.pid, signal);
    };
    const onInterrupt = () => onSignal('SIGINT');
    const onTerminate = () => onSignal('SIGTERM');
    const finish = (error, raw) => {
        if (refresh !== operation) return;
        detach();
        refresh = null;
        lastFetch = Date.now(); // Failed attempts also back off instead of retrying per request.
        if (error) refreshError = error;
        else {
            try {
                rawCache = parseCli(raw);
                updatedAt = new Date(lastFetch).toISOString();
            } catch { refreshError = 'CodeBurn returned invalid JSON.'; }
        }
    };
    process.on('exit', onExit);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    try {
        const args = ['status', '--format', 'menubar-json', '--period', 'today', '--no-optimize', '--no-timeline'];
        const opts = { encoding: 'utf8', windowsHide: true, detached: process.platform !== 'win32', maxBuffer: 32 * 1024 * 1024 };
        const callback = (error, raw) => finish(error ? 'CodeBurn request failed.' : null, raw);
        // `--no`: run CodeBurn only when it is installed. `-y` downloaded and ran the package from npm
        // whenever the page opened, without asking (2026-11-03), and the page waited on the download.
        operation.child = process.platform === 'win32'
            ? childProcess.execFile('cmd.exe', ['/d', '/s', '/c', `npx --no codeburn ${args.join(' ')}`], opts, callback)
            : childProcess.execFile('npx', ['--no', 'codeburn', ...args], opts, callback);
        // An explicit deadline settles even if a descendant holds the stdio pipes open.
        // execFile's built-in timeout would kill cmd before taskkill can identify its tree.
        operation.timer = setTimeout(() => {
            stopCli(operation.child);
            finish('CodeBurn request timed out.');
        }, CLI_TIMEOUT_MS);
        operation.timer.unref();
    } catch { finish('CodeBurn could not be started.'); }
}

// CodeBurn's figures over a chosen window. Reading never starts CodeBurn: it runs only when the
// owner asks (run: true, the AI costs page's button), because it is an outside tool and its
// numbers are the whole machine's, not one project's. Without a run the answer is the last one
// held, or standby.
export function getProjectSpend(projectName = '', range = 'month', from = '', { run = false } = {}) {
    const now = Date.now();
    if (run && !refresh && (lastFetch === null || now - lastFetch >= CACHE_TTL_MS)) {
        startRefresh();
    }
    return {
        ...shapeSpend(rawCache || { daily: [], symbol: '$', sessions: 0, standby: true }, projectName, range, from),
        pending: !!refresh,
        standby: !rawCache || rawCache.daily.length === 0,
        error: refreshError,
        stale: !!rawCache && (!!refresh || !!refreshError),
        updatedAt
    };
}

// Exported as the seam the tests use. Everything above it needs CodeBurn installed and a
// ~5s subprocess; everything from here down is pure arithmetic over a daily series, and the
// window arithmetic is the part that was actually wrong before — so it is the part worth
// pinning against a fixed series rather than against whatever this machine happens to have
// spent today.
export function shapeSpend(cache, projectName = '', range = 'month', from = '') {
    const daily = cache.daily;
    const standby = !!cache.standby || daily.length === 0;
    const sym = cache.symbol || '$';
    // Anchor "today" to the newest day CodeBurn actually holds rather than the wall clock:
    // on a day with no AI activity yet there is no row, and a window measured from a date
    // the series does not reach would read as empty rather than as "nothing spent today".
    const todayISO = daily.length ? daily[daily.length - 1].date : new Date().toISOString().slice(0, 10);

    // An explicit start date wins over the named range — this is the "since this date" case.
    // A malformed one falls back to the named range, and must report the range it actually
    // applied: answering "custom" for a window that is really the month is the kind of label
    // that sends someone hunting for a bug in the numbers instead of in their input.
    const customFrom = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : '';
    const namedRange = RANGES.includes(range) ? range : 'month';
    const start = customFrom || rangeStart(namedRange, todayISO);
    const inRange = start ? daily.filter(r => r.date >= start) : daily.slice();

    const total = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
    const monthRows = daily.filter(r => r.date >= todayISO.slice(0, 8) + '01');
    const todayRow = daily.find(r => r.date === todayISO);

    const todayCost = todayRow ? todayRow.cost : 0;
    const todayCalls = todayRow ? todayRow.calls : 0;
    const monthCost = total(monthRows, 'cost');
    const monthCalls = total(monthRows, 'calls');
    const rangeCost = total(inRange, 'cost');
    const rangeCalls = total(inRange, 'calls');

    const money = (n) => `${sym}${n.toFixed(2)}`;
    const calls = (n) => `${n.toLocaleString()} calls`;

    return {
        project: projectName,
        // The figures are everything CodeBurn tracked on this machine, not this project
        // alone: its daily rollup carries no per-project split, so claiming otherwise in the
        // UI copy would be a number that quietly means something else than it says.
        scope: 'machine',
        range: customFrom ? 'custom' : namedRange,
        rangeFrom: start || (daily.length ? daily[0].date : ''),
        rangeTo: todayISO,
        rangeCost,
        rangeCalls,
        rangeDays: inRange.length,
        rangeCostFormatted: money(rangeCost),
        rangeCallsFormatted: calls(rangeCalls),
        // Kept because the Overview tile (lib/report.mjs) renders these two directly.
        todayCost,
        todayCalls,
        monthCost,
        monthCalls,
        todayCostFormatted: money(todayCost),
        monthCostFormatted: money(monthCost),
        todayCallsFormatted: calls(todayCalls),
        monthCallsFormatted: calls(monthCalls),
        // Newest first: the table reads top-down as "what just happened".
        daily: inRange.slice().reverse().map(r => ({
            date: r.date,
            cost: r.cost,
            calls: r.calls,
            costFormatted: money(r.cost)
        })),
        historyFrom: daily.length ? daily[0].date : '',
        historyTo: todayISO,
        historyDays: daily.length,
        rawSummary: standby ? 'CodeBurn standby' : `${daily.length} days tracked, ${daily[0].date} to ${todayISO}`,
        updatedAt: new Date().toISOString()
    };
}

/** Ask CodeBurn now (the owner pressed the button), then answer like getProjectSpend. */
export function runProjectSpend(projectName = '', range = 'month', from = '') {
    return getProjectSpend(projectName, range, from, { run: true });
}
