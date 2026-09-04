/*
 * NovaWatch smoke tests
 * ---------------------
 * Run with:  node smoke-tests.js
 * Exits non-zero on any failure, so it works as a pre-deploy gate or a CI step.
 *
 * WHY THIS EXISTS
 * The validation this project has relied on until now (syntax parsing, brace
 * balance, duplicate-symbol scans, handler resolution) proves the file loads
 * and is structurally intact. It cannot catch a logic regression: "marking an
 * episode watched silently stopped counting toward progress" parses perfectly.
 * These tests cover the small set of pure functions that the app's most
 * important guarantees actually rest on - what counts as released, what counts
 * as watched, what's next, and how a bare calendar date becomes a timestamp.
 *
 * HOW IT LOADS THE APP
 * scripts/app.js is a classic browser script (no module exports) that touches
 * document/window/localStorage at load. Rather than refactor 8,500 working
 * lines just to make them importable - a large, risky change for a test file -
 * this extracts the specific pure functions by source text and evaluates only
 * those in an isolated scope. That keeps the app itself completely untouched.
 *
 * IMPORTANT: this tests the real source, not a copy. If a function is renamed
 * or removed, extraction fails loudly rather than silently passing.
 */

const fs = require('fs');
const path = require('path');

/*
 * PLACEMENT: this file belongs at the REPO ROOT, next to package.json -
 * `npm test` resolves scripts relative to package.json, so putting it in a
 * subfolder would mean the test script couldn't find it without a path.
 *
 * app.js itself lives at scripts/app.js in the deployed layout, so that is
 * checked first. The bare ./app.js fallback covers running this beside a
 * flat copy of the file (e.g. a scratch folder) rather than inside the repo.
 */
const CANDIDATE_PATHS = [
    path.join(__dirname, 'scripts', 'app.js'),
    path.join(__dirname, 'app.js'),
];

const APP_PATH = CANDIDATE_PATHS.find(p => fs.existsSync(p));
if (!APP_PATH) {
    console.error('\x1b[31mFATAL: could not find app.js\x1b[0m');
    console.error('Looked in:\n  ' + CANDIDATE_PATHS.join('\n  '));
    console.error('Run this from the repo root, where package.json lives.');
    process.exit(1);
}
const src = fs.readFileSync(APP_PATH, 'utf8');

/* ---------- tiny assertion harness ---------- */
let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failures.push({ name, message: err.message });
    }
}

function eq(actual, expected, note) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`${note ? note + ': ' : ''}expected ${e}, got ${a}`);
    }
}

function truthy(value, note) {
    if (!value) throw new Error(`${note || 'expected truthy'}, got ${JSON.stringify(value)}`);
}

function falsy(value, note) {
    if (value) throw new Error(`${note || 'expected falsy'}, got ${JSON.stringify(value)}`);
}

/* ---------- extract the pure functions under test ---------- */
function extract(name) {
    // Matches `function name(` at column 0 through to the closing brace at
    // column 0 - app.js consistently declares top-level functions this way.
    const re = new RegExp(`^function ${name}\\s*\\([\\s\\S]*?^\\}`, 'm');
    const match = src.match(re);
    if (!match) {
        throw new Error(
            `Could not find function "${name}" in app.js. It was renamed or removed - ` +
            `update smoke-tests.js to match, don't just delete the test.`
        );
    }
    return match[0];
}

const NAMES = [
    'isReleased',
    'getAvailableEpisodes',
    'getNextUnwatchedEpisode',
    'getEarlierUnwatchedEpisodes',
    'getTVProgress',
    'isTVUpToDate',
    'isTVFinished',
    'getCurrentWatchStreak',
    'localDateStringToISO',
];

let api;
try {
    const bundle = NAMES.map(extract).join('\n\n');
    // eslint-disable-next-line no-new-func
    api = new Function(`${bundle}\nreturn { ${NAMES.join(', ')} };`)();
} catch (err) {
    console.error('\x1b[31mFATAL: could not load functions from app.js\x1b[0m');
    console.error(err.message);
    process.exit(1);
}

const {
    isReleased, getAvailableEpisodes, getNextUnwatchedEpisode,
    getEarlierUnwatchedEpisodes, getTVProgress, isTVUpToDate, isTVFinished,
    getCurrentWatchStreak, localDateStringToISO,
} = api;

/* ---------- fixtures ---------- */
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

const ep = (season, number, watched, releaseDate = PAST, extra = {}) =>
    ({ id: `s${season}e${number}`, season, number, watched, releaseDate, ...extra });

const show = (episodes, extra = {}) =>
    ({ id: 'show-1', type: 'tv', title: 'Test Show', episodes, ...extra });

/* ---------- isReleased: the guard everything else depends on ---------- */
check('isReleased: past date is released', () => truthy(isReleased(PAST)));
check('isReleased: future date is not released', () => falsy(isReleased(FUTURE)));
check('isReleased: garbage date is not released', () => falsy(isReleased('not-a-date')));
check('isReleased: a MISSING date counts as released (deliberate)', () => {
    // Not an oversight - TMDB genuinely lacks a release date for some
    // entries, and the safe failure mode is "let them mark it watched"
    // rather than locking it behind a countdown to a date that will never
    // arrive. If this ever flips to false, that is a real regression:
    // every dateless title in every library becomes permanently
    // unwatchable.
    truthy(isReleased(null));
    truthy(isReleased(undefined));
    truthy(isReleased(''));
});

/* ---------- getAvailableEpisodes: unaired must never leak in ---------- */
check('getAvailableEpisodes: excludes unaired', () => {
    const s = show([ep(1, 1, true), ep(1, 2, false, FUTURE)]);
    eq(getAvailableEpisodes(s).length, 1);
});
check('getAvailableEpisodes: empty show is safe', () => {
    eq(getAvailableEpisodes(show([])).length, 0);
});

/* ---------- progress ---------- */
check('getTVProgress: counts only released episodes', () => {
    const s = show([ep(1, 1, true), ep(1, 2, false), ep(1, 3, false, FUTURE)]);
    const p = getTVProgress(s);
    eq(p.watched, 1, 'watched');
    eq(p.total, 2, 'total (unaired excluded)');
});
check('getTVProgress: an all-unaired show is 0/0, not NaN', () => {
    const p = getTVProgress(show([ep(1, 1, false, FUTURE)]));
    eq(p.total, 0);
    truthy(Number.isFinite(p.percentage), 'percentage must be a real number');
});
check('getTVProgress: fully watched is 100%', () => {
    const p = getTVProgress(show([ep(1, 1, true), ep(1, 2, true)]));
    eq(p.percentage, 100);
});

/* ---------- next-up ---------- */
check('getNextUnwatchedEpisode: returns first unwatched in order', () => {
    const s = show([ep(1, 1, true), ep(1, 2, false), ep(1, 3, false)]);
    eq(getNextUnwatchedEpisode(s).number, 2);
});
check('getNextUnwatchedEpisode: crosses season boundary correctly', () => {
    const s = show([ep(1, 1, true), ep(2, 1, false)]);
    eq(getNextUnwatchedEpisode(s).season, 2);
});
check('getNextUnwatchedEpisode: never returns an unaired episode', () => {
    const s = show([ep(1, 1, true), ep(1, 2, false, FUTURE)]);
    eq(getNextUnwatchedEpisode(s), null);
});
check('getNextUnwatchedEpisode: caught-up show returns null', () => {
    eq(getNextUnwatchedEpisode(show([ep(1, 1, true)])), null);
});

/* ---------- skip-ahead detection ---------- */
check('getEarlierUnwatchedEpisodes: finds gaps before the target', () => {
    const s = show([ep(1, 1, false), ep(1, 2, false), ep(1, 3, false)]);
    eq(getEarlierUnwatchedEpisodes(s, s.episodes[2]).length, 2);
});
check('getEarlierUnwatchedEpisodes: ignores already-watched earlier ones', () => {
    const s = show([ep(1, 1, true), ep(1, 2, false)]);
    eq(getEarlierUnwatchedEpisodes(s, s.episodes[1]).length, 0);
});
check('getEarlierUnwatchedEpisodes: never counts unaired as a gap', () => {
    const s = show([ep(1, 1, false, FUTURE), ep(1, 2, false)]);
    eq(getEarlierUnwatchedEpisodes(s, s.episodes[1]).length, 0);
});
check('getEarlierUnwatchedEpisodes: spans previous seasons', () => {
    const s = show([ep(1, 1, false), ep(2, 1, false)]);
    eq(getEarlierUnwatchedEpisodes(s, s.episodes[1]).length, 1);
});

/* ---------- library categorisation ---------- */
check('isTVUpToDate: caught up on a returning series', () => {
    truthy(isTVUpToDate(show([ep(1, 1, true)], { status: 'Returning Series' })));
});
check('isTVUpToDate: false when episodes remain', () => {
    falsy(isTVUpToDate(show([ep(1, 1, false)], { status: 'Returning Series' })));
});
check('isTVUpToDate: false for a stopped show', () => {
    falsy(isTVUpToDate(show([ep(1, 1, true)], { status: 'Returning Series', isStopped: true })));
});
check('isTVFinished: ended series fully watched', () => {
    truthy(isTVFinished(show([ep(1, 1, true)], { status: 'Ended' })));
});
check('isTVFinished: a returning series is never "finished"', () => {
    falsy(isTVFinished(show([ep(1, 1, true)], { status: 'Returning Series' })));
});
check('isTVFinished: a watched movie counts as finished', () => {
    truthy(isTVFinished({ type: 'movie', watched: true }));
});

/* ---------- streaks ---------- */
check('getCurrentWatchStreak: empty set is 0', () => {
    eq(getCurrentWatchStreak(new Set()), 0);
});
check('getCurrentWatchStreak: counts consecutive days up to today', () => {
    const day = (offset) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - offset);
        return d.toISOString().slice(0, 10);
    };
    eq(getCurrentWatchStreak(new Set([day(0), day(1), day(2)])), 3);
});
check('getCurrentWatchStreak: a stale streak is broken, not counted', () => {
    eq(getCurrentWatchStreak(new Set(['2020-01-01', '2020-01-02'])), 0);
});

/* ---------- watch-date conversion (timezone correctness) ---------- */
check('localDateStringToISO: round-trips to the same local calendar day', () => {
    // The whole point of anchoring to local midday rather than UTC midnight:
    // the calendar day must survive being read back locally, or streaks,
    // achievements and NovaWrapped all slice on the wrong day.
    const iso = localDateStringToISO('2026-03-15');
    const back = new Date(iso);
    eq(back.getFullYear(), 2026, 'year');
    eq(back.getMonth() + 1, 3, 'month');
    eq(back.getDate(), 15, 'day of month');
});
check('localDateStringToISO: falls back to now on malformed input', () => {
    truthy(!Number.isNaN(new Date(localDateStringToISO('nonsense')).getTime()));
});

/* ---------- report ---------- */
console.log('');
if (failures.length === 0) {
    console.log(`\x1b[32m✓ all ${passed} smoke tests passed\x1b[0m`);
    process.exit(0);
}
console.log(`\x1b[31m✗ ${failures.length} failed\x1b[0m, ${passed} passed\n`);
failures.forEach(f => console.log(`  \x1b[31m✗\x1b[0m ${f.name}\n      ${f.message}`));
process.exit(1);
