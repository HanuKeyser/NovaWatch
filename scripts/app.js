/* =========================================================
   FIREBASE CONFIG & INITIALIZATION
========================================================= */
const firebaseConfig = {
    apiKey: "AIzaSyCzUprsMVHt_-YHvLImvanTlTXsyQ9sqOU",
    authDomain: "novawatch-b3ccd.firebaseapp.com",
    projectId: "novawatch-b3ccd",
    storageBucket: "novawatch-b3ccd.firebasestorage.app",
    messagingSenderId: "836164657360",
    appId: "1:836164657360:web:b3de1169942816d0d27ed5",
    measurementId: "G-H6TMK6C7D0"
};

let db = null;
let auth = null;
let currentUser = null;

try {
    if (firebaseConfig.apiKey !== "YOUR_FIREBASE_API_KEY") {
        firebase.initializeApp(firebaseConfig);
        auth = firebase.auth();
        db = firebase.firestore();

        // Safely set persistence with fallback for restricted browsers/incognito mode
        auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((err) => {
            console.warn("Local persistence failed, attempting session persistence:", err);
            return auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(() => {
                console.warn("Session storage inaccessible. Falling back to in-memory persistence.");
                return auth.setPersistence(firebase.auth.Auth.Persistence.NONE);
            });
        });
    }
} catch (e) {
    console.warn("Firebase initialization failed.", e);
}

/* =========================================================
   APP STATE & CONFIG
========================================================= */
const TMDB_API_KEY = "c8dc4239290060d91afd45c40d8182b7";
// The single source of truth for the version shown in Settings > About
// (see the "Version" row wired up in DOMContentLoaded below) and in
// manifest.json. This is NovaWatch's first stable release - bump this
// and manifest.json's own "version" field together whenever a future
// release is cut. Displayed with a "v" prefix in Settings (see below) -
// full semver-style "1.0.0" rather than a bare major version, since that
// reads as the more polished, deliberate release number it's meant to be.
const APP_VERSION = "1.0.0";
// Derived from the page's actual current origin rather than hardcoded, so
// this can never silently mismatch whatever domain/subdomain variant the
// site is really being served from (e.g. bare novawatch.site vs
// www.novawatch.site - GitHub Pages' CNAME typically serves the bare
// apex domain). A mismatch here isn't cosmetic: history.pushState() throws
// a hard SecurityError if the URL you push doesn't share the document's
// exact current origin, and that exception happens BEFORE the code that
// actually shows the page overlay - so a wrong hardcoded domain here
// silently broke the NovaWrapped/Privacy & Terms buttons entirely, with
// no visible error unless you had the console open.
const NOVAWATCH_APP_URL = window.location.origin + "/";

let state = {
    library: [],
    // Each { id, name, itemIds, createdAt } - see the LISTS block further
    // down for the full CRUD. The automatic "Favourites" list isn't
    // stored here at all - it's computed on the fly from library items'
    // own isFavorite flag, not a real document, so there's nothing to
    // keep in sync when a favorite is toggled.
    lists: [],
    profiles: [
        {
            id: "profile-guest",
            name: "Guest",
            initials: "G",
            avatarId: null,
            unlockedAchievements: []
        }
    ],
    activeProfileId: "profile-guest",
    // ISO 3166-1 country code (e.g. "ZA") used for TMDB/JustWatch "where to
    // watch" lookups. null until detectDefaultRegion() runs on first sign-in
    // or an existing profile doc is loaded - see proceedToApp().
    region: null,
    // Placeholder until real subscription/billing infrastructure exists.
    // Hardcoded false for now - this is the single flag every premium-gated
    // feature (extra profiles, deeper Wrapped, premium achievements, avatar
    // upload once Blaze is in use) should check, so wiring up real payment
    // status later is a one-line change here rather than touching every
    // feature individually.
    isPremiumUser: false
};

/* =========================================================
   THEME (LIGHT / DARK / AUTO)
   Applied via a data-theme attribute on <html>, which the dark-mode CSS
   block keys off - see the inline head script for the same logic applied
   synchronously before first paint. Stored in localStorage rather than
   Firestore since it's a device-level display preference, not account
   data, and this way it costs nothing extra against the free Spark plan.
   'auto' is stored explicitly (not just "no saved value") so Settings can
   show it as the selected option, and so setupOSThemeListener() below
   knows to keep following the OS after an explicit Light/Dark choice has
   been made and then cleared back to Auto.
========================================================= */
let osThemeMediaQuery = null;

function setTheme(theme) {
    let effectiveTheme = theme;
    if (theme === 'auto') {
        effectiveTheme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
        setupOSThemeListener();
    }

    if (effectiveTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    try {
        localStorage.setItem('novawatch-theme', theme);
    } catch (e) { /* localStorage unavailable - theme just won't persist */ }

    const metaTheme = document.getElementById('metaThemeColor');
    if (metaTheme) metaTheme.setAttribute('content', effectiveTheme === 'dark' ? '#060606' : '#ececec');

    syncThemeToggleUI();
}

// Live-updates the site if the OS theme changes while Auto is active and
// the tab stays open - e.g. the phone switching to dark mode at sunset.
// Only registers once; re-checks localStorage on every OS change so it
// correctly stops acting the moment the user picks an explicit Light or
// Dark instead (rather than needing to be torn down and re-created).
function setupOSThemeListener() {
    if (osThemeMediaQuery || !window.matchMedia) return;
    osThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    osThemeMediaQuery.addEventListener('change', () => {
        let saved = null;
        try { saved = localStorage.getItem('novawatch-theme'); } catch (e) {}
        if (saved === 'auto') setTheme('auto');
    });
}

function getSavedThemeMode() {
    try {
        const saved = localStorage.getItem('novawatch-theme');
        return (saved === 'light' || saved === 'dark') ? saved : 'auto';
    } catch (e) {
        return 'auto';
    }
}

function syncThemeToggleUI() {
    const mode = getSavedThemeMode();
    const lightBtn = document.getElementById('themeToggleLightBtn');
    const darkBtn = document.getElementById('themeToggleDarkBtn');
    const autoBtn = document.getElementById('themeToggleAutoBtn');
    if (lightBtn) lightBtn.classList.toggle('active', mode === 'light');
    if (darkBtn) darkBtn.classList.toggle('active', mode === 'dark');
    if (autoBtn) autoBtn.classList.toggle('active', mode === 'auto');
}

/* =========================================================
   AVATAR PICKER
   A curated set of hosted images rather than a photo upload - letting
   someone upload their own image needs Cloud Storage, which Firebase
   removed from the free Spark plan (as of Feb 2026, it requires Blaze).
   This keeps the feature entirely on Firestore: just one small string
   field (profiles[0].avatarId) synced through the existing
   saveUserProfile(), no new storage/billing dependency of its own - these
   images are served from novawatch.site directly, same as the app icon.
========================================================= */
const AVATAR_OPTIONS = [
    { id: 'avatar-1', src: 'https://www.novawatch.site/images/Avatar_1.png' },
    { id: 'avatar-2', src: 'https://www.novawatch.site/images/Avatar_2.png' },
    { id: 'avatar-3', src: 'https://www.novawatch.site/images/Avatar_3.png' },
    { id: 'avatar-4', src: 'https://www.novawatch.site/images/Avatar_4.png' },
    { id: 'avatar-5', src: 'https://www.novawatch.site/images/Avatar_5.png' },
    { id: 'avatar-6', src: 'https://www.novawatch.site/images/Avatar_6.png' },
    { id: 'avatar-7', src: 'https://www.novawatch.site/images/Avatar_7.png' },
    { id: 'avatar-8', src: 'https://www.novawatch.site/images/Avatar_8.png' }
];

// Used to give each new profile a random starting look instead of
// everyone beginning with plain initials - still fully changeable via the
// picker afterward, this just picks where they start from.
function randomAvatarId() {
    return AVATAR_OPTIONS[Math.floor(Math.random() * AVATAR_OPTIONS.length)].id;
}

function getSelectedAvatar() {
    const id = state.profiles && state.profiles[0] ? state.profiles[0].avatarId : null;
    if (!id) return null;
    return AVATAR_OPTIONS.find(a => a.id === id) || null;
}

// Renders either the chosen curated avatar or the initials fallback into a
// .large-avatar element - shared by the Home hero avatar and the Settings
// sheet avatar, called from updateHomeUI() so both always stay in sync.
function renderAvatarInto(el, initial) {
    if (!el) return;
    const avatar = getSelectedAvatar();
    if (avatar) {
        el.style.background = '';
        el.innerHTML = `<img src="${avatar.src}" alt="Avatar" decoding="async" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">`;
    } else {
        el.style.background = '';
        el.textContent = initial;
    }
}

/* =========================================================
   CACHED IDENTITY SNAPSHOT
   Firebase Auth restores its own signed-in user fast on reload, but the
   richer profile data (the real chosen avatar, the username, a display
   name that differs from Auth's own) only ever arrives after an actual
   Firestore round trip - proceedToApp()'s initial fast render only has
   Auth's own displayName/email to work with, so until that round trip
   resolves, the real avatar shows as a plain initial letter and the
   username line doesn't show at all. This caches the last-known real
   values locally so the very next app open can paint them immediately -
   before Firebase Auth has even restored its session, let alone before
   Firestore responds - rather than a brief flash of the wrong avatar/no
   username. Purely a faster first paint: whatever's cached gets
   overwritten within moments by updateHomeUI() running on the real,
   authoritative data the same way it always has, so a stale cache can
   never linger meaningfully or show incorrect data for long.
========================================================= */
const IDENTITY_CACHE_KEY = "novawatch-cachedIdentity";

function cacheIdentitySnapshot(displayName, avatarId, username) {
    try {
        localStorage.setItem(IDENTITY_CACHE_KEY, JSON.stringify({ displayName, avatarId, username }));
    } catch (e) {
        // Non-fatal - worst case the next app open just doesn't have a
        // cache to restore from, same as today.
    }
}

function clearCachedIdentitySnapshot() {
    try {
        localStorage.removeItem(IDENTITY_CACHE_KEY);
    } catch (e) { /* non-fatal */ }
}

// Called as the very first thing on boot, before Firebase Auth or
// Firestore have had any chance to respond - a pure, optimistic "paint
// what we last knew" pass. Deliberately doesn't touch anything that
// depends on actually being signed in (the settings-entry-btn, tab
// content, etc.) - just the identity bits shown on Home and in
// Settings, which is exactly what would otherwise flash incorrectly.
function restoreCachedIdentitySnapshot() {
    let cached = null;
    try {
        const raw = localStorage.getItem(IDENTITY_CACHE_KEY);
        if (raw) cached = JSON.parse(raw);
    } catch (e) {
        return; // Nothing to restore.
    }
    if (!cached || !cached.displayName) return;

    const initial = cached.displayName.charAt(0).toUpperCase() || "G";
    const avatar = cached.avatarId ? AVATAR_OPTIONS.find(a => a.id === cached.avatarId) : null;
    const avatarHtml = avatar
        ? `<img src="${avatar.src}" alt="Avatar" decoding="async" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">`
        : null;

    const homeNameEl = document.getElementById("homeName");
    if (homeNameEl) homeNameEl.textContent = cached.displayName;

    const settingsNameEl = document.getElementById("settingsName");
    if (settingsNameEl) settingsNameEl.textContent = cached.displayName;

    [document.getElementById("largeAvatar"), document.getElementById("settingsAvatar")].forEach(el => {
        if (!el) return;
        if (avatarHtml) {
            el.innerHTML = avatarHtml;
        } else {
            el.textContent = initial;
        }
    });

    if (cached.username) {
        const settingsUsernameSub = document.getElementById("settingsUsernameSubtitle");
        if (settingsUsernameSub) {
            settingsUsernameSub.style.display = "";
            settingsUsernameSub.textContent = `@${cached.username}`;
        }
    }
}

function renderAvatarPickerGrid() {
    const grid = document.getElementById('avatarPickerGrid');
    if (!grid) return;
    const currentId = state.profiles && state.profiles[0] ? state.profiles[0].avatarId : null;
    grid.innerHTML = AVATAR_OPTIONS.map(avatar => `
        <button class="avatar-picker-option ${avatar.id === currentId ? 'selected' : ''}" onclick="selectAvatar('${avatar.id}')" aria-label="Select avatar">
            <img src="${avatar.src}" alt="Avatar" loading="lazy" decoding="async" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">
        </button>
    `).join('');
}

function openAvatarPicker() {
    const modal = document.getElementById('avatarPickerModal');
    renderAvatarPickerGrid();
    if (modal.classList.contains('open')) return;
    modal.classList.add('open');
    lockBodyScroll('avatarPickerModal');
}

function closeAvatarPicker() {
    document.getElementById('avatarPickerModal').classList.remove('open');
    unlockBodyScroll('avatarPickerModal');
}

function closeAvatarPickerOutside(event) {
    if (event.target.id === 'avatarPickerModal') closeAvatarPicker();
}

async function selectAvatar(avatarId) {
    if (!state.profiles || !state.profiles[0]) return;
    state.profiles[0].avatarId = avatarId;
    await saveUserProfile();
    updateHomeUI();
    renderAvatarPickerGrid();
    closeAvatarPicker();
}

/* =========================================================
   ACHIEVEMENTS
   Computed client-side from state.library every time refreshActivePage()
   runs (see checkAchievements()) rather than tracked as their own synced
   Firestore records - everything they need (watched flags, dates,
   rewatchCount) is data the app is already holding in memory, so this
   costs nothing extra against Firestore's free-tier read/write quota.
   Only the small unlockedAchievements ID array on the profile is written,
   so a milestone doesn't re-trigger its unlock toast on every reload.

   Premium achievements are pulled out for now (not shown, not checked) -
   kept in PREMIUM_ACHIEVEMENTS below rather than deleted, so they're a
   one-line change (append them back into ACHIEVEMENTS) once premium is
   actually ready to launch.
========================================================= */
const ACHIEVEMENTS = [
    { id: 'movies_10', tier: 'free', title: '10 Movies Watched', description: 'Watch 10 movies.', check: (s) => s.moviesWatched >= 10 },
    { id: 'shows_10', tier: 'free', title: '10 Shows Completed', description: 'Finish watching 10 TV shows.', check: (s) => s.showsCompleted >= 10 },
    { id: 'streak_7', tier: 'free', title: '7-Day Streak', description: 'Watch something 7 days in a row.', check: (s) => s.longestStreak >= 7 },
    { id: 'first_rewatch', tier: 'free', title: 'First Rewatch', description: 'Log your first rewatch.', check: (s) => s.totalRewatches >= 1 },
    { id: 'night_owl', tier: 'free', title: 'Night Owl', description: 'Watch something between midnight and 5am.', check: (s) => s.nightOwlWatch },
    { id: 'time_capsule', tier: 'free', title: 'Time Capsule', description: 'Watch something released 25 or more years ago.', check: (s) => s.timeCapsuleWatch },
    { id: 'opening_weekend', tier: 'free', title: 'Opening Weekend', description: 'Watch something within 3 days of its release.', check: (s) => s.openingWeekendWatch },
    { id: 'marathon_day', tier: 'free', title: 'Marathon Day', description: 'Watch 5 or more episodes of the same show in a single day.', check: (s) => s.marathonDay },
    { id: 'double_feature', tier: 'free', title: 'Double Feature', description: 'Watch a movie and a TV episode on the same day.', check: (s) => s.doubleFeatureDay },
    { id: 'the_collector', tier: 'free', title: 'The Collector', description: 'Have 100 or more titles in your library.', check: (s) => s.libraryCount >= 100 },
    { id: 'list_maker', tier: 'free', title: 'List Maker', description: 'Create 3 or more custom lists.', check: (s) => s.listCount >= 3 },
    { id: 'heart_eyes', tier: 'free', title: 'Heart Eyes', description: 'Favorite 10 or more titles.', check: (s) => s.favoriteCount >= 10 },
    { id: 'word_of_mouth', tier: 'free', title: 'Word of Mouth', description: 'Share a show, movie, episode, or list.', check: (s) => s.hasShared }
];

// Not currently active - see comment block above. Untouched otherwise so
// re-enabling later is just `ACHIEVEMENTS.push(...PREMIUM_ACHIEVEMENTS)`
// (or folding this list back into ACHIEVEMENTS directly) once
// state.isPremiumUser is backed by real subscription status.
const PREMIUM_ACHIEVEMENTS = [
    { id: 'movies_50', tier: 'premium', title: '50 Movies Watched', description: 'Watch 50 movies.', check: (s) => s.moviesWatched >= 50 },
    { id: 'movies_100', tier: 'premium', title: '100 Movies Watched', description: 'Watch 100 movies.', check: (s) => s.moviesWatched >= 100 },
    { id: 'movies_500', tier: 'premium', title: '500 Movies Watched', description: 'Watch 500 movies.', check: (s) => s.moviesWatched >= 500 },
    { id: 'shows_50', tier: 'premium', title: '50 Shows Completed', description: 'Finish watching 50 TV shows.', check: (s) => s.showsCompleted >= 50 },
    { id: 'shows_100', tier: 'premium', title: '100 Shows Completed', description: 'Finish watching 100 TV shows.', check: (s) => s.showsCompleted >= 100 },
    { id: 'streak_30', tier: 'premium', title: '30-Day Streak', description: 'Watch something 30 days in a row.', check: (s) => s.longestStreak >= 30 },
    { id: 'season_rewatch', tier: 'premium', title: 'Rewatched a Full Season', description: 'Rewatch every episode in a full season at least once.', check: (s) => s.rewatchedFullSeason },
    { id: 'cleared_watchlist', tier: 'premium', title: 'Cleared Your Watchlist', description: 'Watch everything currently in your library.', check: (s) => s.clearedWatchlist },
    { id: 'same_week_finish', tier: 'premium', title: 'Binge Finisher', description: 'Finish a show within a week of starting it.', check: (s) => s.sameWeekFinish }
];

// Whether a run of consecutive watch-days is still "live" right now -
// distinct from computeAchievementStats()'s longestStreak, which is an
// all-time record that never resets even after the streak itself has
// long since broken. This is the Home tab's "Current Streak" stat
// instead - 0 the moment a day gets missed, same UTC-calendar-day
// slicing as watchedAt/lastWatchedAt use everywhere else (see
// setEpisodeWatched, computeAchievementStats' longestStreak) so this
// and the streak achievement always agree on where a day boundary
// falls.
function getCurrentWatchStreak(watchedDates) {
    if (!watchedDates || watchedDates.size === 0) return 0;

    const sortedDates = [...watchedDates].sort();
    const mostRecent = sortedDates[sortedDates.length - 1];
    const todayStr = new Date().toISOString().slice(0, 10);
    const dayGap = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

    // Nothing watched today or yesterday - the streak is broken, not
    // just "old".
    if (dayGap(mostRecent, todayStr) > 1) return 0;

    let streak = 1;
    for (let i = sortedDates.length - 1; i > 0; i--) {
        if (dayGap(sortedDates[i - 1], sortedDates[i]) === 1) {
            streak++;
        } else {
            break;
        }
    }
    return streak;
}

function computeAchievementStats() {
    let moviesWatched = 0;
    let showsCompleted = 0;
    let totalRewatches = 0;
    let rewatchedFullSeason = false;
    let sameWeekFinish = false;
    let clearedWatchlist = true;
    let anyItems = false;
    const watchedDates = new Set();

    // New stats below - each backing one of the newer, more specific
    // achievements rather than another "watch N more things" variant of
    // what already existed.
    let nightOwlWatch = false;
    let timeCapsuleWatch = false;
    let openingWeekendWatch = false;
    const movieWatchDates = new Set();
    const episodeWatchDates = new Set();
    // Keyed by "showId::date" - counts episodes of the SAME show watched
    // on the SAME day, for Marathon Day below. A day with 5 episodes
    // spread across 3 different shows shouldn't count the same as 5
    // episodes of one show back to back.
    const showDayEpisodeCounts = new Map();
    const now = new Date();

    state.library.forEach(item => {
        if (item.type === 'movie') {
            anyItems = true;
            if (item.watched) {
                moviesWatched++;
                totalRewatches += (item.rewatchCount || 0);
                if (item.lastWatchedAt) {
                    const d = item.lastWatchedAt.slice(0, 10);
                    watchedDates.add(d);
                    movieWatchDates.add(d);
                    if (new Date(item.lastWatchedAt).getHours() < 5) nightOwlWatch = true;
                    if (item.releaseDate) {
                        const ageYears = (now - new Date(item.releaseDate)) / (365.25 * 24 * 60 * 60 * 1000);
                        if (ageYears >= 25) timeCapsuleWatch = true;
                        const daysSinceRelease = (new Date(item.lastWatchedAt) - new Date(item.releaseDate)) / (24 * 60 * 60 * 1000);
                        if (daysSinceRelease >= 0 && daysSinceRelease <= 3) openingWeekendWatch = true;
                    }
                }
            } else {
                clearedWatchlist = false;
            }
        } else if (item.episodes && item.episodes.length > 0) {
            anyItems = true;
            const releasedEps = getAvailableEpisodes(item);
            const watchedEps = releasedEps.filter(ep => ep.watched);
            if (releasedEps.length > 0 && watchedEps.length === releasedEps.length) {
                showsCompleted++;
                const timestamps = watchedEps.filter(ep => ep.watchedAt).map(ep => new Date(ep.watchedAt).getTime());
                if (timestamps.length > 1 && (Math.max(...timestamps) - Math.min(...timestamps)) <= 7 * 24 * 60 * 60 * 1000) {
                    sameWeekFinish = true;
                }
            }
            if (watchedEps.length < releasedEps.length) clearedWatchlist = false;

            item.episodes.forEach(ep => {
                if (ep.watched) {
                    totalRewatches += (ep.rewatchCount || 0);
                    if (ep.watchedAt) {
                        const d = ep.watchedAt.slice(0, 10);
                        watchedDates.add(d);
                        episodeWatchDates.add(d);
                        if (new Date(ep.watchedAt).getHours() < 5) nightOwlWatch = true;
                        if (ep.releaseDate) {
                            const ageYears = (now - new Date(ep.releaseDate)) / (365.25 * 24 * 60 * 60 * 1000);
                            if (ageYears >= 25) timeCapsuleWatch = true;
                            const daysSinceRelease = (new Date(ep.watchedAt) - new Date(ep.releaseDate)) / (24 * 60 * 60 * 1000);
                            if (daysSinceRelease >= 0 && daysSinceRelease <= 3) openingWeekendWatch = true;
                        }
                        const key = `${item.id}::${d}`;
                        showDayEpisodeCounts.set(key, (showDayEpisodeCounts.get(key) || 0) + 1);
                    }
                }
            });

            const seasons = [...new Set(item.episodes.map(ep => ep.season))];
            seasons.forEach(s => {
                const seasonEps = item.episodes.filter(ep => ep.season === s);
                if (seasonEps.length > 0 && seasonEps.every(ep => (ep.rewatchCount || 0) > 0)) rewatchedFullSeason = true;
            });
        }
    });

    if (!anyItems) clearedWatchlist = false;

    // Longest streak = longest run of consecutive calendar days with at
    // least one watch/rewatch logged, from the set of distinct dates above.
    const sortedDates = [...watchedDates].sort();
    let longestStreak = 0, currentStreak = 0, prevDate = null;
    sortedDates.forEach(dateStr => {
        const d = new Date(dateStr + 'T00:00:00Z');
        currentStreak = (prevDate && Math.round((d - prevDate) / 86400000) === 1) ? currentStreak + 1 : 1;
        longestStreak = Math.max(longestStreak, currentStreak);
        prevDate = d;
    });

    const marathonDay = [...showDayEpisodeCounts.values()].some(count => count >= 5);
    const doubleFeatureDay = [...movieWatchDates].some(d => episodeWatchDates.has(d));
    const libraryCount = state.library.length;
    const listCount = state.lists.length;
    const favoriteCount = state.library.filter(i => i.isFavorite).length;

    return {
        moviesWatched, showsCompleted, totalRewatches, longestStreak, rewatchedFullSeason,
        clearedWatchlist, sameWeekFinish, nightOwlWatch, timeCapsuleWatch, openingWeekendWatch,
        marathonDay, doubleFeatureDay, libraryCount, listCount, favoriteCount,
        hasShared: !!state.hasSharedSomething
    };
}

// Called from refreshActivePage() after any watched/rewatch-changing
// action - but refreshActivePage() itself fires from ~24 different call
// sites across the app (far more than just watch-state changes), so this
// needed two guards to avoid re-scanning the whole library on every single
// UI update:
//   1. Once every currently-active achievement is already unlocked,
//      there's nothing left to check - skip immediately, no scan at all.
//   2. Otherwise, debounce the actual scan so a burst of refreshActivePage()
//      calls (e.g. several state updates in quick succession) collapses
//      into one computeAchievementStats() pass instead of running it once
//      per call, which was blocking the main thread often enough to read
//      as general app lag.
let achievementsCheckTimer = null;

function checkAchievements() {
    if (!state.profiles || !state.profiles[0]) return;
    clearTimeout(achievementsCheckTimer);
    achievementsCheckTimer = setTimeout(runAchievementsCheck, 400);
}

// Bidirectional: an achievement can be revoked, not just earned. If someone
// accidentally logs a rewatch (unlocking "First Rewatch") and then removes
// it, the achievement should stop being true, same as it never happened -
// achievements reflect current state, not a one-way ratchet.
function runAchievementsCheck() {
    if (!state.profiles || !state.profiles[0]) return;
    const profile = state.profiles[0];
    if (!profile.unlockedAchievements) profile.unlockedAchievements = [];
    const stats = computeAchievementStats();

    const newlyUnlocked = [];
    let changed = false;
    ACHIEVEMENTS.forEach(ach => {
        const isUnlocked = profile.unlockedAchievements.includes(ach.id);
        const meetsCondition = ach.check(stats);

        if (!isUnlocked && meetsCondition) {
            if (ach.tier === 'premium' && !state.isPremiumUser) return;
            profile.unlockedAchievements.push(ach.id);
            newlyUnlocked.push(ach);
            changed = true;
        } else if (isUnlocked && !meetsCondition) {
            // Revoked quietly, no toast - losing an achievement isn't a
            // moment worth interrupting someone for, unlike earning one.
            profile.unlockedAchievements = profile.unlockedAchievements.filter(id => id !== ach.id);
            changed = true;
        }
    });

    if (changed) {
        saveUserProfile();
        newlyUnlocked.forEach(ach => showToast(`Achievement Unlocked: ${ach.title}`, 'success'));
    }
    // Moved outside the `if (changed)` guard - the bug reported ("shows no
    // achievements until you open the Achievements screen") happened
    // precisely because this only ran when something changed THIS
    // specific check. On a normal app reload, achievements already
    // unlocked in an earlier session still meet their condition and
    // aren't newly unlocked OR revoked - nothing "changes" - so this
    // never ran at all, leaving the Settings row on whatever blank/zero
    // default was in the HTML until renderAchievementsList() (a totally
    // separate function, only called when the modal itself opens)
    // happened to populate it. Running this every time regardless of
    // `changed` is what makes it reflect the real current state on
    // first load, not just after something newly happens.
    updateAchievementsRowSub();
}

// Shared by runAchievementsCheck (background unlocks/revokes, modal not
// necessarily open) and renderAchievementsList (modal open) so both stay
// in sync from one place rather than duplicating this line.
function updateAchievementsRowSub() {
    const rowSub = document.getElementById('achievementsRowSub');
    if (!rowSub) return;
    const profile = state.profiles && state.profiles[0] ? state.profiles[0] : null;
    const count = profile && profile.unlockedAchievements ? profile.unlockedAchievements.length : 0;
    rowSub.textContent = `${count} unlocked`;
}

function renderAchievementsList() {
    const container = document.getElementById('achievementsList');
    if (!container) return;
    const profile = state.profiles && state.profiles[0] ? state.profiles[0] : null;
    const unlocked = profile && profile.unlockedAchievements ? profile.unlockedAchievements : [];

    container.innerHTML = ACHIEVEMENTS.map(ach => {
        const isUnlocked = unlocked.includes(ach.id);
        const isPremiumLocked = ach.tier === 'premium' && !state.isPremiumUser;
        return `
            <div class="analytics-card settings-card" style="padding: 14px; opacity: ${isUnlocked ? '1' : '0.55'};">
                <div class="settings-row" style="padding: 0;">
                    <div class="settings-row-icon" style="background: ${isUnlocked ? 'var(--glass-sheen), var(--orange-gradient)' : 'var(--surface-2)'}; color: ${isUnlocked ? 'white' : 'var(--text-muted)'};">
                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M8.21 13.89L7 23l5-3 5 3-1.21-9.12"/></svg>
                    </div>
                    <div class="settings-row-text">
                        <div class="settings-row-title">${escapeHTML(ach.title)}${isPremiumLocked ? ' <span style="color: var(--blue); font-size: 10.5px; font-weight: 800;">PREMIUM</span>' : ''}</div>
                        <div class="settings-row-sub">${escapeHTML(ach.description)}</div>
                    </div>
                    ${isUnlocked ? '<svg class="icon icon-small" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                </div>
            </div>
        `;
    }).join('');

    updateAchievementsRowSub();
}

function openAchievementsModal() {
    const modal = document.getElementById('achievementsModal');
    renderAchievementsList();
    if (modal.classList.contains('open')) return;
    modal.classList.add('open');
    lockBodyScroll('achievementsModal');
}

function closeAchievementsModal() {
    document.getElementById('achievementsModal').classList.remove('open');
    unlockBodyScroll('achievementsModal');
}

function closeAchievementsModalOutside(event) {
    if (event.target.id === 'achievementsModal') closeAchievementsModal();
}

/* =========================================================
   LIBRARY DISPLAY PREFERENCES (show/hide Finished & Stopped)
   Same device-level storage pattern as notification preferences and
   the theme setting - purely a display filter on the TV Library's
   category blocks (see renderTVLibrarySection), never touches the
   underlying watched/stopped data itself.
========================================================= */
const LIBRARY_VISIBILITY_KEY = "novawatch-libraryVisibility";
const DEFAULT_LIBRARY_VISIBILITY = { showFinished: true, showStopped: true, showUnwatched: true };

function getLibraryVisibilityPrefs() {
    try {
        const raw = localStorage.getItem(LIBRARY_VISIBILITY_KEY);
        if (!raw) return { ...DEFAULT_LIBRARY_VISIBILITY };
        return { ...DEFAULT_LIBRARY_VISIBILITY, ...JSON.parse(raw) };
    } catch (e) {
        return { ...DEFAULT_LIBRARY_VISIBILITY };
    }
}

function setLibraryVisibilityPref(key, value) {
    const prefs = getLibraryVisibilityPrefs();
    prefs[key] = value;
    try {
        localStorage.setItem(LIBRARY_VISIBILITY_KEY, JSON.stringify(prefs));
    } catch (e) {
        // Non-fatal - worst case the preference doesn't stick this session.
    }
    renderLibraryDisplayModal();
    // Re-render the TV Library immediately if it's the active page, so
    // toggling this actually shows/hides the category right away instead
    // of waiting for the next unrelated refresh.
    if (document.getElementById("libraryPage").classList.contains("active")) {
        renderTVLibrarySection();
    }
}

const LIBRARY_VISIBILITY_CATEGORIES = [
    { key: 'showFinished', title: 'Finished', sub: 'Shows that have ended or been cancelled.' },
    { key: 'showUnwatched', title: 'Unwatched', sub: 'Shows you haven\'t started watching yet.' },
    { key: 'showStopped', title: 'Stopped Watching', sub: 'Shows you\'ve chosen to stop watching.' }
];

function renderLibraryDisplayModal() {
    const container = document.getElementById('libraryDisplayList');
    if (!container) return;
    const prefs = getLibraryVisibilityPrefs();

    container.innerHTML = LIBRARY_VISIBILITY_CATEGORIES.map(cat => {
        const isOn = !!prefs[cat.key];
        // Same on/off pill classes as Notification Types and the
        // notification-permission button - see
        // .hero-pill-btn.pill-on/.pill-off in app.css.
        return `
            <div class="analytics-card settings-card" style="padding: 14px;">
                <div class="settings-row" style="padding: 0;">
                    <div class="settings-row-text">
                        <div class="settings-row-title">${escapeHTML(cat.title)}</div>
                        <div class="settings-row-sub">${escapeHTML(cat.sub)}</div>
                    </div>
                    <button class="hero-pill-btn ${isOn ? 'pill-on' : 'pill-off'}" onclick="setLibraryVisibilityPref('${cat.key}', ${!isOn})">${isOn ? 'On' : 'Off'}</button>
                </div>
            </div>
        `;
    }).join('');
}

function openLibraryDisplayModal() {
    const modal = document.getElementById('libraryDisplayModal');
    renderLibraryDisplayModal();
    if (modal.classList.contains('open')) return;
    modal.classList.add('open');
    lockBodyScroll('libraryDisplayModal');
}

function closeLibraryDisplayModal() {
    document.getElementById('libraryDisplayModal').classList.remove('open');
    unlockBodyScroll('libraryDisplayModal');
}

function closeLibraryDisplayModalOutside(event) {
    if (event.target.id === 'libraryDisplayModal') closeLibraryDisplayModal();
}

// True once the signed-in user's library has been fetched at least once
// this session - lets Home/Library tell "genuinely empty" apart from
// "still loading" and show a skeleton instead of a misleading empty
// state (e.g. "You're All Caught Up") while the initial fetch is in
// flight. Reset to false on sign-out.
let libraryLoaded = false;

let currentItem = null;
let currentEpisode = null;
let rewatchPopupEpId = null;
let selectedSeason = 1;
// Set right before a fresh modal open so the episode list scrolls straight
// to the next-up episode once, without re-scrolling on every later
// re-render (season switches, watched toggles, background TMDB refreshes).
let scrollToNextEpisodeOnRender = false;
let currentSearchType = 'tv';
let currentAuthMode = 'signin';
let currentLibraryView = 'tv';
let searchDebounceTimer = null;
let libSearchDebounceTimers = {};

/* =========================================================
   NOTIFICATIONS SYSTEM
   OneSignal is the only notification delivery mechanism in the app now -
   real push, delivered by OneSignal's own infrastructure, reaching a
   device even when the app/browser is fully closed. There is no
   separate client-side "while the tab is open" notification path
   anymore (there used to be one - it fired notifications locally via
   the Notification API while the app was open or recently
   backgrounded, entirely separate from OneSignal - removed in favor of
   OneSignal being the single source of truth for both delivery and
   scheduling, rather than two parallel systems that could disagree or
   double-notify).
========================================================= */
/* =========================================================
   ONESIGNAL (real push notifications, even when the app is fully closed)
   This only handles the DEVICE side (subscribing, and tying this device
   to the signed-in account via OneSignal's "external ID" so a server
   can target it). It does NOT decide what to send or when - that's a
   separate, small scheduled server-side job (not part of this client
   code, since a browser tab can't run on a schedule while closed - see
   the accompanying server script) that reads each account's library and
   timezone (synced via saveUserProfile) and calls OneSignal's REST API.

   Every function here checks isOneSignalConfigured() first. Until
   ONESIGNAL_APP_ID is set to a real value, subscribing simply does
   nothing - there is no fallback notification path anymore, so no
   notifications of any kind go out until this is configured.
========================================================= */
// Replace with the real App ID from OneSignal's dashboard (Settings ->
// Keys & IDs) once the account exists.
const ONESIGNAL_APP_ID = "754197a4-aa86-4c1a-bde1-f287f98547a5";

function isOneSignalConfigured() {
    return !!ONESIGNAL_APP_ID && ONESIGNAL_APP_ID !== "YOUR_ONESIGNAL_APP_ID";
}

// OneSignal's own queuing mechanism - the SDK script tag loads with
// `defer`, so window.OneSignal isn't guaranteed to exist yet wherever
// this is called from. Every OneSignal call in this app goes through
// this same queue rather than assuming window.OneSignal is ready.
function withOneSignal(callback) {
    if (!isOneSignalConfigured()) return;
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(callback);
}

function initOneSignal() {
    withOneSignal(async (OneSignal) => {
        await OneSignal.init({ appId: ONESIGNAL_APP_ID });

        // Keeps the "Stay in the loop" button (checkNotificationPermissionState)
        // in sync with OneSignal's own subscription state, since that's
        // the real source of truth for whether push can reach this
        // device once OneSignal is configured.
        OneSignal.User.PushSubscription.addEventListener("change", () => {
            checkNotificationPermissionState();
        });

        // If someone's already signed in by the time this finishes
        // initializing (e.g. a fast reload), tie this device to their
        // account right away rather than waiting for the next sign-in.
        if (auth && auth.currentUser) oneSignalLogin(auth.currentUser.uid);
    });
}

// Associates this device's push subscription with the signed-in
// person's Firebase uid (OneSignal's "external ID") - this is what lets
// the server-side push job target a specific NovaWatch account rather
// than just an anonymous device.
function oneSignalLogin(uid) {
    if (!uid) return;
    withOneSignal(async (OneSignal) => {
        try {
            await OneSignal.login(uid);
        } catch (e) {
            console.warn("OneSignal login failed:", e);
        }
    });
}

function oneSignalLogout() {
    withOneSignal(async (OneSignal) => {
        try {
            await OneSignal.logout();
        } catch (e) {
            console.warn("OneSignal logout failed:", e);
        }
    });
}

async function checkNotificationPermissionState() {
    const btn = document.getElementById("notificationBtn");
    if (!btn) return;

    // Same on/off pill classes as Notification Types and Library
    // Display - see .hero-pill-btn.pill-on/.pill-off/.pill-neutral in
    // app.css. "Unsupported" is neither on nor off (the device simply
    // can't), so it gets the neutral variant instead of the "off" one -
    // that darker-gray treatment should mean "you turned this off,"
    // not "this can't work here."
    btn.classList.remove("pill-on", "pill-off", "pill-neutral");

    if (!("Notification" in window)) {
        btn.textContent = "Unsupported";
        btn.classList.add("pill-neutral");
        btn.disabled = true;
        return;
    }

    // Once OneSignal is actually configured (see ONESIGNAL_APP_ID), its
    // own push-subscription state is the real source of truth - it's
    // what actually determines whether a real push can reach this
    // device, not just whether the browser's raw permission is granted.
    // Falls through to the plain Notification API check below until
    // then, or if this read fails for any reason.
    if (isOneSignalConfigured() && window.OneSignal && window.OneSignal.User) {
        try {
            if (window.OneSignal.User.PushSubscription.optedIn) {
                btn.textContent = "Enabled";
                btn.classList.add("pill-on");
                btn.disabled = true;
                return;
            }
        } catch (e) {
            // Fall through to the Notification API check below.
        }
    }

    if (Notification.permission === "granted") {
        btn.textContent = "Enabled";
        btn.classList.add("pill-on");
        btn.disabled = true;
    } else if (Notification.permission === "denied") {
        btn.textContent = "Blocked";
        btn.classList.add("pill-off");
        btn.disabled = true;
    } else {
        btn.textContent = "Enable";
        btn.disabled = false;
    }
}

// requestNotificationPermission() below drives both the browser's own
// permission prompt AND (once configured) OneSignal's push subscription -
// still needed even though this app no longer fires any notifications of
// its own locally. Actual notification delivery is entirely OneSignal's
// job now (see the ONESIGNAL block above and send-release-notifications.js) -
// nothing in this file calls the Notification API or
// registration.showNotification() directly anymore.
async function requestNotificationPermission() {
    if (!("Notification" in window)) {
        showErrorToast("Notifications not supported on this browser/device.");
        return;
    }
    try {
        if (isOneSignalConfigured() && window.OneSignal && window.OneSignal.Notifications) {
            // OneSignal's own requestPermission() drives the same native
            // browser prompt, then additionally registers the real push
            // subscription the server-side job needs to actually reach
            // this device - the plain Notification.requestPermission()
            // below only gets the prompt, nothing to deliver a closed-app
            // push through.
            await window.OneSignal.Notifications.requestPermission();
        } else {
            await Notification.requestPermission();
        }

        checkNotificationPermissionState();
        if (Notification.permission === "granted") {
            // No confirmation notification here on purpose - a notification
            // whose entire content is "you'll get notifications now" is
            // pure noise. The toast below is confirmation enough.
            showToast("Notifications enabled successfully!", "success");
        } else {
            showErrorToast("Notification permission denied.");
        }
    } catch (err) {
        console.error("Error requesting notification permission:", err);
        showErrorToast("Could not enable notifications.");
    }
}

/* =========================================================
   UTILITY HELPERS
========================================================= */
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Requests a smaller TMDB image size for small on-screen thumbnails than
// the size actually stored on the item (poster/backdrop URLs are stored
// at w500/w780 because that same stored value is also used in bigger
// contexts, like the details modal's hero image). A ~126px-wide library
// grid card or an 80px-wide Continue Watching poster doesn't need
// anywhere near that much source resolution - this is a real bandwidth
// and decode-time saving, multiplied across every poster/still on screen
// at once in Library/Continue Watching/Upcoming/episode lists. Falls
// back to the URL unchanged for anything that isn't a recognizable TMDB
// image URL (a custom-picked poster could in principle point elsewhere).
function tmdbThumb(url, size) {
    if (!url) return url;
    return url.replace(/\/t\/p\/(w\d+|original)\//, `/t/p/${size}/`);
}

// Toast notifications, and later the in-app notifications log built to
// replace them, were both removed entirely - success/confirmation
// messages stay silent for good reason (they usually accompany a
// visible state change of their own already), so this stays a no-op
// for those specifically. showToast(msg, "error") call sites were all
// converted to showErrorToast(msg) below instead - the one category
// that genuinely needs to be visible, since a silent failure with zero
// feedback is a real problem, not a cosmetic one.
function showToast(message, type = null) {}

let errorToastTimer = null;

// The single, deliberately-reintroduced case toasts still cover -
// see the ERROR TOAST block in index.html/app.css for the rest of the
// reasoning (why this, why not success messages too, why it's
// positioned where it is). A new error replaces whatever's currently
// showing and resets the timer, rather than queueing multiple - errors
// are rare enough now (this only ever fires for the ~39 real failure
// paths across the app, not everything) that a simple single-slot
// toast is enough; a queue would be complexity this doesn't need.
function showErrorToast(message) {
    const toast = document.getElementById("errorToast");
    if (!toast) return;
    const msgEl = document.getElementById("errorToastMessage");
    if (msgEl) msgEl.textContent = message;
    toast.classList.add("show");
    clearTimeout(errorToastTimer);
    errorToastTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 4500);
}

function hideErrorToast() {
    const toast = document.getElementById("errorToast");
    if (toast) toast.classList.remove("show");
    clearTimeout(errorToastTimer);
}

function clearSearch(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = "";
    input.parentElement.classList.remove("has-text");
    if (inputId === "onlineSearchInput") fetchForYou();
    if (inputId === "tvLibrarySearchInput") renderTVLibrarySection();
    if (inputId === "movieLibrarySearchInput") renderMovieLibrarySection();
    if (inputId === "upcomingTVSearchInput") renderUpcomingTVSection();
    if (inputId === "upcomingMovieSearchInput") renderUpcomingMovieSection();
    if (inputId === "regionSearchInput") filterRegionOptions("");
}

document.addEventListener("DOMContentLoaded", () => {
    // Absolute first thing, before theme sync or anything else - a pure
    // optimistic paint from whatever was cached last time, before
    // Firebase Auth has even had a chance to restore its own session,
    // let alone before Firestore responds. See CACHED IDENTITY SNAPSHOT
    // above for the full reasoning.
    restoreCachedIdentitySnapshot();

    // The inline head script already applied the right theme before first
    // paint (saved choice, or OS preference if none saved yet) - this just
    // keeps it live-following the OS afterward when no explicit Light/Dark
    // choice exists, and syncs the Settings toggle to match.
    if (getSavedThemeMode() === 'auto') setupOSThemeListener();
    syncThemeToggleUI();

    initOneSignal();

    const versionLabel = document.getElementById("appVersionLabel");
    if (versionLabel) versionLabel.textContent = `v${APP_VERSION}`;

    // Only two real search inputs left in the app now - Discover and the
    // region picker. Library, Upcoming, and the Full Library "View All"
    // view all had their own search boxes removed (each entry point
    // already disambiguates what you're looking at before you get
    // there, so a search field inside as well was redundant).
    const searchInputs = ['onlineSearchInput', 'regionSearchInput'];
    
    searchInputs.forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;

        input.addEventListener("input", (e) => {
            const val = e.target.value;
            if (val.trim().length > 0) {
                input.parentElement.classList.add("has-text");
            } else {
                input.parentElement.classList.remove("has-text");
            }
        });

        // Works around a still-current iOS Safari bug (WebKit #191204):
        // when the on-screen keyboard opens and the page has nothing
        // left to scroll (an empty search results list, a library with
        // only a few items, a short country list), iOS falls back to
        // scrolling the raw document instead of absorbing the keyboard's
        // own gesture internally - and while that fallback is active,
        // position:fixed elements briefly "unstick" and the text caret
        // gets computed against a desynced layout viewport, landing in
        // the wrong place. Not the same bug as the backdrop-filter-
        // related one already fixed on .search-box itself (that was a
        // compositing quirk, always reproducible); this one is content-
        // length dependent, which is exactly why it read as "not always"
        // wrong rather than consistently wrong. Giving the page guaranteed
        // extra scroll room only while a search field is actually
        // focused (see .keyboard-scroll-safety in app.css) means iOS
        // never needs that broken fallback in the first place, without
        // permanently changing how a short page's own scroll height
        // looks the rest of the time.
        input.addEventListener("focus", () => {
            document.body.classList.add("keyboard-scroll-safety");
        });
        input.addEventListener("blur", () => {
            document.body.classList.remove("keyboard-scroll-safety");
        });
    });

    // Enforces lowercase-only, [a-z0-9._] usernames live as the person
    // types, on both places a username is ever entered (signup's Join
    // form and the Choose Username screen) - see sanitizeUsernameInput().
    ['authUsername', 'chooseUsernameInput'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener("input", () => sanitizeUsernameInput(input));
    });

    // Live availability feedback for the Choose Username screen - see
    // wireUsernameAvailabilityCheck(). Registered after the sanitizer
    // above so it always reads the already-lowercased/filtered value.
    // Scoped to this screen only for now (not the Join form's username
    // field, which lacks a status slot of its own in its compact
    // two-column row) - the submit-time check there still applies.
    wireUsernameAvailabilityCheck('chooseUsernameInput', 'chooseUsernameStatus');

    // Filters the region picker's rows as you type - separate from the
    // has-text toggle above, which only handles the clear button's visibility.
    const regionSearchInput = document.getElementById("regionSearchInput");
    if (regionSearchInput) {
        regionSearchInput.addEventListener("input", (e) => {
            filterRegionOptions(e.target.value);
        });
    }

    initSearchPage();
    setAuthMode('signin');
    syncThemeToggleUI();
    checkNotificationPermissionState();
    populateRegionOptions();

    // The installed PWA's manifest uses launch_handler.client_mode:
    // "navigate-existing" (see manifest.json) - reusing the already-open
    // window instead of opening a new one when the app icon is tapped
    // again. That's good (no duplicate windows), but it means normal
    // page-load logic never re-runs in that case: auth state hasn't
    // changed, so onAuthStateChanged/proceedToApp - the thing that
    // otherwise puts the app on Home - never fires either, leaving
    // whichever tab was open before still showing. The Launch Handler
    // API's launchQueue exists specifically for this: its consumer
    // fires on every launch, including a reused-window one, so this is
    // what actually makes "opening NovaWatch always lands on Home" true
    // for an already-running installed app, not just a fresh load.
    if ("launchQueue" in window) {
        window.launchQueue.setConsumer(() => {
            showPage("home");
        });
    }

    // Catches the moment something crosses into "released" for anyone who
    // leaves the app open across it, without needing a network call -
    // isReleased() is now an exact timestamp check (see above), so this
    // re-renders whichever tab is open so Upcoming/Continue Watching/Home
    // actually reflect the change within this window instead of staying
    // stale until the next navigation or data sync happens to touch them.
    // Only a display refresh now - notification delivery is entirely
    // OneSignal's job (see the ONESIGNAL block above), not something this
    // client-side timer triggers anymore.
    setInterval(() => {
        refreshActivePage();
    }, 5 * 60 * 1000);

    // Automatic background TMDB sync: keeps every library item's metadata
    // current without the user ever having to refresh, remove, or re-add
    // anything. Runs periodically while the app is open, and again whenever
    // the user returns to a backgrounded tab if it's been a while.
    setInterval(() => {
        if (auth && auth.currentUser) {
            checkLibraryForUpdates();
        }
    }, AUTO_SYNC_INTERVAL_MS);

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;

        // Runs immediately on every return-to-foreground, regardless of
        // how long the tab was backgrounded - cheap and local-only (no
        // network), and mobile browsers throttle setInterval heavily once
        // a tab is backgrounded, so the 5-minute timer above can't be
        // trusted alone to keep Upcoming/Continue Watching/Home current
        // for something that released while this tab was out of view.
        refreshActivePage();

        if (!auth || !auth.currentUser) return;

        const last = getLastLibraryCheck();
        const staleEnough = !last || (now() - last) > AUTO_SYNC_INTERVAL_MS;
        if (staleEnough) {
            checkLibraryForUpdates();
        }
    });
});

/* =========================================================
   DATE HELPERS
========================================================= */
function now() {
    return new Date();
}

// Local time, not UTC - this is purely a warm "how the day is going" cue
// on Home, not tied to any tracked/stored data (unlike the UTC-based
// release-date logic below), so using the device's own clock is correct.
function getTimeOfDayGreeting() {
    const hour = new Date().getHours();
    if (hour < 5) return "Good Night";
    if (hour < 12) return "Good Morning";
    if (hour < 18) return "Good Afternoon";
    return "Good Evening";
}

// TMDB only ever gives us a calendar date (e.g. "2026-08-15"), never a real
// release time. We parse/store that as UTC midnight, so all date logic below
// reads it back out by its UTC calendar components rather than letting the
// browser reinterpret it in the viewer's local timezone (which used to shift
// the displayed day earlier/later depending on where the user is).
function getDateOnlyParts(value) {
    const d = new Date(value);
    // Local (not UTC) calendar day - this must match the reference frame
    // getLocalTodayParts() below uses, since daysUntil() compares the
    // two directly. Extracting the UTC day here while comparing against
    // a local "today" was a real bug: for any timezone ahead of UTC (a
    // release at, say, 2pm UTC is already the next calendar day in a
    // timezone like SAST or NZST), the countdown could be off by a full
    // day - the same category of "different reference frames silently
    // disagreeing" bug as formatDateWithReleaseTime() used to have.
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
}

function getLocalTodayParts() {
    const n = now();
    return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
}

// Whole calendar days between a stored release date and the viewer's local
// "today" - used for the countdown display ("Tomorrow", "In 3 days") only.
// Deliberately NOT what gates whether something is actually released (see
// isReleased() below, which does an exact timestamp check instead) - this
// is allowed to be an approximation since a friendly countdown doesn't
// need hour-level precision the way "is it actually out yet" does.
function daysUntil(date) {
    const r = getDateOnlyParts(date);
    const releaseLocalMidnight = new Date(r.y, r.m, r.d);
    const t = getLocalTodayParts();
    const todayLocalMidnight = new Date(t.y, t.m, t.d);
    return Math.round((releaseLocalMidnight.getTime() - todayLocalMidnight.getTime()) / 86400000);
}

// The actual release gate - true once the real release instant (00:00
// Pacific time on the release date, per getPacificMidnightUTC/
// tmdbDateToISO above) has passed for THIS viewer, in their own
// timezone. This used to just compare calendar days in the viewer's
// local time, which meant something could show as "released" as much as
// a full day before it had actually dropped anywhere for anyone east of
// Pacific time (or, less obviously, still show as unreleased for a
// while after it actually had for anyone west of it) - an exact instant
// comparison is correct for every timezone at once, not tied to
// whichever one happens to be closest to Pacific.
function isReleased(date) {
    if (!date) return true;
    return Date.now() >= new Date(date).getTime();
}

// TMDB gives date-only strings (e.g. "2026-08-14"), which JS would
// otherwise parse as UTC midnight - not when content actually becomes
// available. Generalized so it can anchor to any wall-clock time in any
// IANA timezone on a given date (see getPacificMidnightUTC/
// getBroadcastPrimetimeUTC below, which are just this called with
// specific arguments) - DST-aware via Intl's own timezone database
// rather than this hardcoding an offset or guessing at DST date ranges.
function getTimezoneAnchorUTC(dateStr, timeZone, hour, minute, fallbackOffsetHours) {
    const [year, month, day] = dateStr.split('-').map(Number);

    // Formatted at noon UTC on the target date (not the anchor time
    // itself) specifically to stay safely clear of the DST transition
    // instant, which lands in the very early morning local time - using
    // noon avoids ever landing exactly on that boundary and reading the
    // wrong side of it.
    const referenceInstant = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const offsetPart = new Intl.DateTimeFormat("en-US", {
        timeZone,
        timeZoneName: "longOffset"
    }).formatToParts(referenceInstant).find(p => p.type === "timeZoneName");

    // Falls back to a fixed standard-time (non-DST) offset if the browser
    // doesn't support "longOffset" (older WebKit) or the parse ever comes
    // back in an unexpected shape - wrong for roughly half the year (DST
    // season) but still a real anchor in the right timezone, not an
    // unrelated fixed UTC time.
    let offsetHours = fallbackOffsetHours;
    const match = offsetPart && offsetPart.value.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (match) {
        const sign = match[1] === "-" ? -1 : 1;
        offsetHours = sign * (parseInt(match[2], 10) + parseInt(match[3], 10) / 60);
    }

    // A wall-clock time in a timezone at UTC offset X corresponds to
    // (that time - X) in UTC - e.g. Pacific at UTC-8 means 00:00 PT =
    // 08:00 UTC; Eastern at UTC-4 means 20:00 ET = 00:00 UTC next day.
    return Date.UTC(year, month - 1, day, hour, minute, 0) - offsetHours * 3600000;
}

// DST-aware, since a broadcast station's schedule grid IS tied to real
// civil clock time).
// The real-world convention movies use: everything drops at once, at
// midnight in the civil America/Los_Angeles timezone - genuinely
// DST-aware (Netflix's own stated policy for streaming releases is
// "12:01 AM Pacific Time", meaning the actual civil Pacific clock, which
// shifts between PST/UTC-8 in winter and PDT/UTC-7 in summer, exactly
// like every other Pacific-time civil clock does).
function getPacificMidnightUTC(dateStr) {
    return getTimezoneAnchorUTC(dateStr, "America/Los_Angeles", 0, 0, -8);
}

// Anchors a movie's release date - always the streaming/midnight-Pacific
// convention, movies have no broadcast/cable concept. Also reused below
// (see getEpisodeReleaseDate) as the streaming-default anchor for TV
// episodes that aren't on a real broadcast/cable schedule.
function tmdbDateToISO(dateStr) {
    if (!dateStr) return null;
    return new Date(getPacificMidnightUTC(dateStr)).toISOString();
}

/* =========================================================
   TV EPISODE RELEASE TIMING
   Real per-episode release instants, timezone-correct for every viewer.
   TV episode timing was fully removed at one point (a long saga: real
   TVmaze-sourced airtimes -> repeated validation tightening as new edge
   cases kept surfacing -> pure TMDB-date+convention math -> a manual
   correction feature -> two abandoned admin-correction systems -> full
   removal). Brought back deliberately differently this time: rather
   than trying to force one computed formula to cover every show, this
   splits by what TVmaze itself says it actually knows -

     - A show TVmaze lists under a real `network` (broadcast/cable) has
       a genuinely reliable, network-announced local airtime - used
       as-is (see buildBroadcastTimingMap).
     - Everything else (a TVmaze `webChannel` entry, or no TVmaze match
       at all) falls back to the same midnight-Pacific streaming
       convention movies already use. TVmaze itself does NOT store a
       trustworthy per-episode time for global streaming shows (their
       own API returns a fixed noon-UTC placeholder for those) - so
       there's nothing worth reading from TVmaze for that case, and
       midnight Pacific is the latest time in the range real streaming
       platforms actually use (official Netflix/Disney+ policy; most
       others release earlier in the evening PT). That means this can
       under-promise (show "not released yet" for a few extra hours on
       an early-release platform) but never over-promise (claim
       something's out before it verifiably is, anywhere).

   Only the calendar DATE this produces is meant to be trusted per
   viewer timezone - not treated as a promise of the exact hour.
========================================================= */
const TVMAZE_API_BASE = "https://api.tvmaze.com";

// Resolves a show's TVmaze record (with its full embedded episode list),
// caching the result on the item itself (`tvmazeId`) so a show only ever
// gets searched for once. `undefined` = never attempted, `null` =
// attempted and not found (or TVmaze unreachable) - both simply mean
// this show stays on the streaming-midnight-Pacific default, same as
// every TV show did before this feature existed. Never a hard failure -
// a network error or a show TVmaze doesn't have is a normal outcome
// here, not something to surface to the user.
async function resolveTVmazeShow(item, showData, imdbId) {
    if (item.tvmazeId === null) return null;

    if (typeof item.tvmazeId === 'number') {
        try {
            const res = await fetch(`${TVMAZE_API_BASE}/shows/${item.tvmazeId}?embed=episodes`);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    try {
        let tvmazeShow = null;
        if (imdbId) {
            const res = await fetch(`${TVMAZE_API_BASE}/lookup/shows?imdb=${imdbId}`);
            if (res.ok) tvmazeShow = await res.json();
        }
        // Fallback is a best-effort name search - only reachable when
        // there's no IMDB id to do an exact lookup with. A loose name
        // match occasionally being wrong just means that one show keeps
        // the streaming-default date instead of a real broadcast one -
        // never worse than the "no TV timing at all" baseline this is
        // replacing.
        if (!tvmazeShow) {
            const res = await fetch(`${TVMAZE_API_BASE}/singlesearch/shows?q=${encodeURIComponent(showData.name || item.title)}`);
            if (res.ok) tvmazeShow = await res.json();
        }
        if (!tvmazeShow || !tvmazeShow.id) {
            item.tvmazeId = null;
            return null;
        }
        item.tvmazeId = tvmazeShow.id;
        const epRes = await fetch(`${TVMAZE_API_BASE}/shows/${tvmazeShow.id}?embed=episodes`);
        if (!epRes.ok) return null;
        return await epRes.json();
    } catch (e) {
        item.tvmazeId = null;
        return null;
    }
}

// A `season+episode -> real anchor instant` lookup, populated only when
// TVmaze has this show under a real broadcast/cable `network` (not a
// streaming `webChannel` - see the block comment above for why that
// half is deliberately never trusted for per-episode time). Empty map
// for any show that doesn't qualify, which getEpisodeReleaseDate below
// treats the same as "TVmaze doesn't have this show" - falls straight
// through to the streaming default.
function buildBroadcastTimingMap(tvmazeShow) {
    const map = new Map();
    if (!tvmazeShow || !tvmazeShow.network) return map;
    const episodes = tvmazeShow._embedded && tvmazeShow._embedded.episodes;
    if (!episodes) return map;
    const timeZone = tvmazeShow.network.country && tvmazeShow.network.country.timezone;
    if (!timeZone) return map;

    episodes.forEach(ep => {
        if (!ep.airdate) return;
        const timeStr = ep.airtime || (tvmazeShow.schedule && tvmazeShow.schedule.time) || '20:00';
        const parts = timeStr.split(':').map(Number);
        const hour = Number.isFinite(parts[0]) ? parts[0] : 20;
        const minute = Number.isFinite(parts[1]) ? parts[1] : 0;
        // -5 (US Eastern standard time) as the fallback offset if the
        // browser's Intl support falls through - matches getPacificMidnightUTC's
        // pattern of a safe fixed guess for the rare non-DST-aware path.
        const anchor = getTimezoneAnchorUTC(ep.airdate, timeZone, hour, minute, -5);
        map.set(`s${ep.season}e${ep.number}`, new Date(anchor).toISOString());
    });
    return map;
}

// The one place a TV episode's release date gets anchored. Real
// broadcast time when the show qualifies for one (see
// buildBroadcastTimingMap), otherwise the same streaming convention
// movies use, applied to TMDB's own per-episode air_date.
function getEpisodeReleaseDate(tmdbEp, seasonNumber, broadcastTimingMap) {
    const key = `s${seasonNumber}e${tmdbEp.episode_number}`;
    if (broadcastTimingMap && broadcastTimingMap.has(key)) {
        return { releaseDate: broadcastTimingMap.get(key), timingSource: 'broadcast' };
    }
    if (!tmdbEp.air_date) return { releaseDate: null, timingSource: null };
    return { releaseDate: tmdbDateToISO(tmdbEp.air_date), timingSource: 'streaming' };
}

// A season's episode fetch, retried once before giving up on it - a
// single transient failure (a network blip, a rate limit) on the very
// first load of a show could otherwise silently ship it with a season
// missing entirely, never retried, never surfaced as an error.
async function fetchTMDBSeason(tmdbId, seasonNumber) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`);
            const data = await r.json();
            if (data && data.episodes) return data;
        } catch (e) {
            // fall through and retry, or give up after the 2nd attempt
        }
    }
    return null;
}

// Builds one standardized episode object from a single TMDB episode.
// `broadcastTimingMap` is optional (omit/pass null for contexts that
// deliberately skip TVmaze - see the preview-fetch call site) - every
// episode still gets a streaming-default releaseDate either way, as
// long as TMDB itself has an air_date for it.
function buildEpisodeFields(seasonNumber, ep, broadcastTimingMap) {
    const timing = getEpisodeReleaseDate(ep, seasonNumber, broadcastTimingMap);
    return {
        id: `s${seasonNumber}e${ep.episode_number}`,
        season: seasonNumber,
        number: ep.episode_number,
        title: ep.name || `Episode ${ep.episode_number}`,
        overview: ep.overview || '',
        still: ep.still_path ? `https://image.tmdb.org/t/p/w780${ep.still_path}` : '',
        runtime: ep.runtime ? `${ep.runtime} min` : "45 min",
        releaseDate: timing.releaseDate,
        timingSource: timing.timingSource,
        watched: false,
        watchedAt: null
    };
}

// Turns a batch of already-fetched TMDB season payloads into the full,
// flat episode list for a show. `seasonsData` and `validSeasons` must be
// the same length and in the same order (index i of one corresponds to
// index i of the other) - every call site builds them that way via
// Promise.all over a validSeasons.map(...) list.
//
// existingEpisodes (optional) is the item's own already-stored episode
// list - a season whose fetch still failed even after
// fetchTMDBSeason()'s retry falls back to that season's EXISTING
// episodes, completely untouched, instead of being silently dropped (a
// real, confirmed bug this once caused: a single transient season
// failure wiping that season's watched history on the very next sync).
function buildEpisodesFromSeasons(validSeasons, seasonsData, existingEpisodes = null, broadcastTimingMap = null) {
    const episodes = [];
    validSeasons.forEach((season, i) => {
        const seasonData = seasonsData[i];
        if (seasonData && seasonData.episodes) {
            seasonData.episodes.forEach(ep => {
                episodes.push(buildEpisodeFields(seasonData.season_number, ep, broadcastTimingMap));
            });
        } else if (existingEpisodes && existingEpisodes.length > 0) {
            episodes.push(...existingEpisodes.filter(ep => ep.season === season.season_number));
        }
    });
    return episodes;
}

function getCountdown(date) {
    if (!date) return "TBA";
    // isReleased() is the precise gate (see above) - checked first so
    // this never says "Available now" a few hours early just because
    // daysUntil()'s calendar-day math alone would call it "today", nor
    // keeps counting down after the real release instant has actually
    // passed.
    if (isReleased(date)) return "Available now";

    const days = daysUntil(date);
    if (days <= 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days <= 7) return `In ${days} days`;
    if (days <= 13) return "Next week";
    const weeks = Math.round(days / 7);
    return `In ${weeks} weeks`;
}

// Plain calendar-day formatting of a release instant, in the viewer's own
// local timezone - the DATE is what's meant to be trusted (see the TV
// EPISODE RELEASE TIMING block near tmdbDateToISO), not necessarily the
// exact hour, so this deliberately never displays a time component even
// though the name is kept for the callers that already reference it.
function formatDateWithReleaseTime(dateStr) {
    if (!dateStr) return 'TBA';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'TBA';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Same plain local-calendar-day formatting, for a non-release timestamp
// (e.g. when something was watched) - separate name from the above
// purely so each call site reads clearly for what it's formatting.
function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* =========================================================
   LAST-CHECKED TRACKING (for the Upcoming tab's refresh control)
========================================================= */
const LAST_LIBRARY_CHECK_KEY = "novawatch_lastLibraryCheck";

// How often the app automatically re-checks TMDB for every library item.
const AUTO_SYNC_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

function getLastLibraryCheck() {
    try {
        const raw = localStorage.getItem(LAST_LIBRARY_CHECK_KEY);
        return raw ? new Date(raw) : null;
    } catch (e) {
        return null;
    }
}

function setLastLibraryCheck(date) {
    try {
        localStorage.setItem(LAST_LIBRARY_CHECK_KEY, date.toISOString());
    } catch (e) {
        // Non-fatal.
    }
}

/* =========================================================
   FIREBASE CLOUD SYNC & AUTHENTICATION
========================================================= */
// Returns true only if the write actually reached Firestore - callers that
// show a "Saved"/"Updated" toast should check this rather than assuming
// success just because saveItem() didn't throw past them. Previously this
// swallowed every failure (offline, permission error, etc.) into a
// console.error only, so callers like the poster/backdrop picker were
// showing a success toast even when nothing was actually saved.
async function saveItem(item) {
    try {
        if (!auth || !auth.currentUser || !db || !item || !item.id) {
            return false;
        }

        // Belt-and-suspenders: a shared/searched item opened before being
        // explicitly added ("preview") should never reach Firestore, no
        // matter which caller passes it in. Every call site is already
        // supposed to check isCurrentItemInLibrary() first, but guarding
        // it here too means a future caller forgetting that check can't
        // silently write a placeholder doc into someone's library.
        if (item.isPreview || item.id.startsWith('preview-')) {
            console.warn(`Refused to save preview item "${item.id}" - it isn't in the library yet.`);
            return false;
        }

        await db.collection("users")
            .doc(auth.currentUser.uid)
            .collection("library")
            .doc(item.id)
            .set(item, { merge: true });
        return true;
    } catch (err) {
        console.error(`Firestore save item ${item.id} FAILED`, err);
        return false;
    }
}

async function saveUserProfile() {
    try {
        if (!auth || !auth.currentUser || !db) return false;
        const payload = {
            profiles: state.profiles,
            activeProfileId: state.activeProfileId,
            region: state.region,
            // The server-side push job has no browser to infer "today"
            // from the way daysUntil()/getLocalTodayParts() do here - it
            // needs each account's real IANA timezone to compute their
            // own local "today" correctly (the whole point of the TV
            // timing work is that this differs by viewer). Cheap to
            // compute, no permission needed, so this is refreshed on
            // every save rather than asked for once and left to go stale
            // if someone moves/travels.
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };
        // Only ever written once state.username is actually known - a
        // blind `username: state.username || null` here would overwrite
        // (i.e. wipe) an already-reserved username on any call site that
        // runs before the profile's been loaded into state yet.
        if (state.username) payload.username = state.username;
        await db.collection("users")
            .doc(auth.currentUser.uid)
            .set(payload, { merge: true });
        return true;
    } catch (err) {
        console.error("Firestore user profile save FAILED", err);
        return false;
    }
}

/* =========================================================
   USERNAMES
   Every account gets a unique, reserved username - either chosen at
   signup (the Join form's username field, see handleSignUp) or, for
   Google sign-in and any pre-existing account from before this was
   required, via the blocking #chooseUsernameScreen (see
   showChooseUsernameScreen/submitChosenUsername below).

   Reservation is a top-level `usernames/{lowercased-username}` doc
   (`{uid, username}`) - a separate collection rather than a field on
   `users/{uid}`, so checking/claiming a name never needs to know who
   already owns it. Stored lowercased for a case-insensitive uniqueness
   check (so "Alex" and "alex" can't both be taken); the doc itself keeps
   the original casing the person typed for display.

   isUsernameAvailable() is a plain read - fast, good enough for instant
   UI feedback, but NOT what actually prevents two people claiming the
   same name at once (a plain read-then-write has a race window).
   claimUsername() is the real enforcement: a Firestore transaction that
   re-reads the doc and only writes if it's still free (or already owned
   by this same uid, so re-running it for an already-claimed name is a
   harmless no-op). Every caller must be ready for claimUsername() to
   throw and handle the conflict - see handleSignUp/submitChosenUsername.
========================================================= */
const USERNAME_REGEX = /^[a-z0-9._]{3,20}$/;

function isValidUsernameFormat(username) {
    return USERNAME_REGEX.test(username);
}

// Lowercases and strips any character outside [a-z0-9._] as the person
// types, on any input using the "username-input" marker class - so
// usernames are enforced as lowercase-only live, not just rejected with
// an error after the fact. See the DOMContentLoaded wiring below.
function sanitizeUsernameInput(input) {
    const cleaned = input.value.toLowerCase().replace(/[^a-z0-9._]/g, "");
    if (cleaned !== input.value) input.value = cleaned;
}

async function isUsernameAvailable(username) {
    if (!db) return true; // Best-effort if Firestore isn't configured.
    const doc = await db.collection("usernames").doc(username.toLowerCase()).get();
    return !doc.exists;
}

async function claimUsername(uid, username) {
    const ref = db.collection("usernames").doc(username.toLowerCase());
    await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (doc.exists && doc.data().uid !== uid) {
            throw new Error("USERNAME_TAKEN");
        }
        tx.set(ref, { uid: uid, username: username });
    });
}

// Debounced "is this available?" feedback while typing a username -
// previously availability was only ever discovered at submit time,
// after already finishing the rest of the form. Purely informational:
// the actual enforcement is still claimUsername()'s transaction at
// submit, since availability can change again in the gap between
// typing and submitting - this is a convenience, not a guarantee.
let usernameCheckTimer = null;
let usernameCheckToken = 0;

function wireUsernameAvailabilityCheck(inputId, statusId) {
    const input = document.getElementById(inputId);
    const statusEl = document.getElementById(statusId);
    if (!input || !statusEl) return;

    input.addEventListener("input", () => {
        const value = input.value.trim();
        clearTimeout(usernameCheckTimer);

        if (!value || !isValidUsernameFormat(value)) {
            statusEl.textContent = "";
            statusEl.className = "username-check-status";
            return;
        }

        statusEl.textContent = "Checking availability...";
        statusEl.className = "username-check-status checking";

        const myToken = ++usernameCheckToken;
        usernameCheckTimer = setTimeout(async () => {
            const available = await isUsernameAvailable(value);
            // A newer check has since started (more typing happened), or
            // the field's live value has since changed some other way
            // (e.g. cleared and retyped) - either way this result is
            // stale and shouldn't overwrite whatever's more current.
            if (myToken !== usernameCheckToken) return;
            if (input.value.trim() !== value) return;

            statusEl.textContent = available ? "Username is available" : "Username is already taken";
            statusEl.className = `username-check-status ${available ? 'available' : 'taken'}`;
        }, 500);
    });
}

/* =========================================================
   CHOOSE USERNAME SCREEN
   A full-screen blocking overlay, same tier as #authScreen/#verifyScreen -
   shown whenever a signed-in account doesn't have a reserved username on
   file yet (triggered from proceedToApp's profile load below).
========================================================= */
function showChooseUsernameScreen(user) {
    const screen = document.getElementById("chooseUsernameScreen");
    if (!screen) return;
    screen.style.display = "flex";
    const input = document.getElementById("chooseUsernameInput");
    if (input) {
        // Pre-filled as a starting suggestion from their Google name/email
        // - still fully editable, and still has to pass the exact same
        // availability check as anything else typed in here. Lowercased
        // and filtered the same way sanitizeUsernameInput() enforces live
        // typing, so the suggestion itself is never something the person
        // couldn't have typed themselves.
        const suggestion = (user.displayName || (user.email ? user.email.split('@')[0] : ""))
            .toLowerCase()
            .replace(/[^a-z0-9._]/g, "")
            .slice(0, 20);
        input.value = suggestion;
        setTimeout(() => input.focus(), 50);
    }
}

function hideChooseUsernameScreen() {
    const screen = document.getElementById("chooseUsernameScreen");
    if (screen) screen.style.display = "none";
}

function clearChooseUsernameError() {
    const errEl = document.getElementById("chooseUsernameError");
    if (errEl) {
        errEl.textContent = "";
        errEl.classList.remove("show");
    }
    const input = document.getElementById("chooseUsernameInput");
    if (input) input.classList.remove("input-error");
}

function showChooseUsernameError(message) {
    const errEl = document.getElementById("chooseUsernameError");
    if (errEl) {
        errEl.textContent = message;
        errEl.classList.add("show");
    }
    const input = document.getElementById("chooseUsernameInput");
    if (input) input.classList.add("input-error");
}

function handleChooseUsernameKeydown(event) {
    if (event.key === "Enter") submitChosenUsername();
}

async function submitChosenUsername() {
    if (!auth || !auth.currentUser) return;

    const input = document.getElementById("chooseUsernameInput");
    const username = input ? input.value.trim() : "";

    if (!username) {
        showChooseUsernameError("Please enter a username.");
        return;
    }

    if (!isValidUsernameFormat(username)) {
        showChooseUsernameError("3-20 characters: lowercase letters, numbers, dots, and underscores only.");
        return;
    }

    const btn = document.getElementById("chooseUsernameBtn");
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Saving...";
    }

    try {
        const available = await isUsernameAvailable(username);
        if (!available) {
            showChooseUsernameError("That username is already taken.");
            return;
        }

        await claimUsername(auth.currentUser.uid, username);

        if (!state.profiles || state.profiles.length === 0) {
            state.profiles = [{ id: "profile-main", name: username, initials: username.charAt(0).toUpperCase(), avatarId: randomAvatarId() }];
        } else if (!state.profiles[0].name) {
            // Only default the display name to the username if one isn't
            // already set - an existing account (e.g. a pre-username
            // Google sign-in, which already has its Google name sitting
            // in profiles[0].name from proceedToApp) already has a real
            // display name, and claiming a username here shouldn't
            // clobber it with the handle instead.
            state.profiles[0].name = username;
            state.profiles[0].initials = username.charAt(0).toUpperCase();
        }
        // Defensive - proceedToApp already assigns one for a first-time
        // Google sign-in before this screen is ever shown, but this
        // covers any account that somehow reached here without one
        // (e.g. one created before that fix existed).
        if (state.profiles && state.profiles[0] && !state.profiles[0].avatarId) {
            state.profiles[0].avatarId = randomAvatarId();
        }
        state.username = username;
        await saveUserProfile();

        // Best-effort sync of the resolved display name (not necessarily
        // the username itself - see above) into Firebase Auth's own
        // displayName field. Not load-bearing: updateHomeUI() reads
        // state.profiles[0].name as the real source of truth now.
        auth.currentUser.updateProfile({ displayName: state.profiles[0].name }).catch(() => {});

        hideChooseUsernameScreen();
        updateHomeUI();
        showToast("Username saved!", "success");
    } catch (err) {
        // A transaction conflict (someone else claimed it a moment ago)
        // lands here same as any other failure - re-check-and-retry is
        // on the person, not automatic, since the name they wanted is
        // simply gone either way.
        console.error("Username claim FAILED", err);
        showChooseUsernameError("That username was just taken. Try another.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Continue";
        }
    }
}

async function handleGoogleSignIn() {
    if (!auth) {
        showAuthMessage("Cloud sync not configured yet.");
        return;
    }

    // Only gated in Join mode - a returning user signing back in via
    // Google shouldn't be blocked by a consent checkbox they already
    // agreed to the first time (see setAuthMode, which hides this same
    // row outside of Join mode). This can't perfectly distinguish a
    // brand-new Google account started from the Sign In tab, but Join
    // is the explicit, labeled path for creating an account.
    if (currentAuthMode === 'signup') {
        const termsCheckbox = document.getElementById("authTermsCheckbox");
        if (termsCheckbox && !termsCheckbox.checked) {
            showAuthMessage("Please agree to the Terms of Service & Privacy Notice to continue.");
            return;
        }
    }

    clearAuthMessage();

    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        await auth.signInWithPopup(provider);
        showToast("Signed in with Google!", "success");
    } catch (err) {
        console.error("Google Sign-In Error:", err);
        showAuthMessage(err.message || "Failed to sign in with Google.");
    }
}

/* =========================================================
   AUTH MODE (SIGN IN vs CREATE ACCOUNT)
========================================================= */
function setAuthMode(mode) {
    currentAuthMode = mode;

    const tabSignIn = document.getElementById("authTabSignIn");
    const tabSignUp = document.getElementById("authTabSignUp");
    if (tabSignIn) tabSignIn.classList.toggle("active", mode === 'signin');
    if (tabSignUp) tabSignUp.classList.toggle("active", mode === 'signup');

    // Username is only needed when creating a new account.
    const usernameInput = document.getElementById("authUsername");
    if (usernameInput) {
        usernameInput.style.display = mode === 'signup' ? '' : 'none';
    }

    // Same for the Terms/Privacy consent row - only relevant when actually
    // creating an account, not on a routine returning-user sign-in.
    const termsRow = document.getElementById("authTermsRow");
    if (termsRow) {
        termsRow.style.display = mode === 'signup' ? '' : 'none';
    }

    const actionBtn = document.getElementById("authSignInBtn");
    if (actionBtn) {
        actionBtn.textContent = mode === 'signup' ? 'Join' : 'Sign In';
        actionBtn.onclick = mode === 'signup' ? handleSignUp : handleSignIn;
    }

    // The password field is shared between both modes (toggled via the
    // same input) - autocomplete="new-password" vs "current-password"
    // is what tells a password manager whether to offer generating/
    // saving a new password or filling the existing one, so it has to
    // switch with the mode rather than being set once and forgotten.
    const passwordInput = document.getElementById("authPassword");
    if (passwordInput) {
        passwordInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    }

    clearPasswordError();
}

// Lets the mobile keyboard's Go/Done key (or a desktop Enter press) submit
// the form from any of its fields, the same as tapping the Sign In/Join
// button - there's no <form> element here to get native submit-on-Enter
// for free, and #authSignInBtn's onclick is already kept pointed at
// whichever handler is currently active by setAuthMode above, so this
// just triggers that same button rather than duplicating the mode logic.
// Enter advances to the next field instead of always submitting - Join
// mode chains username -> email -> password, Sign In chains email ->
// password; only the last field in whichever chain is active actually
// submits. Matches each field's enterkeyhint ("next"/"next"/"go" - see
// the HTML) so the on-screen keyboard's own action button does the same
// thing the physical Enter key does.
function handleAuthKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();

    const fieldOrder = currentAuthMode === 'signup'
        ? ['authUsername', 'authEmail', 'authPassword']
        : ['authEmail', 'authPassword'];
    const currentIndex = fieldOrder.indexOf(event.target.id);
    const nextField = currentIndex >= 0 ? fieldOrder[currentIndex + 1] : null;

    if (nextField) {
        const nextEl = document.getElementById(nextField);
        if (nextEl) {
            nextEl.focus();
            return;
        }
    }

    const btn = document.getElementById("authSignInBtn");
    if (btn && !btn.disabled) btn.click();
}

async function handleSignIn() {
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;

    if (!auth) {
        showAuthMessage("Cloud sync not configured yet.");
        return;
    }

    clearPasswordError();
    clearAuthMessage();

    if (!email) {
        showAuthMessage("Please enter your email address.");
        return;
    }

    if (!password) {
        showAuthMessage("Please enter your password.");
        return;
    }

    const signInBtn = document.getElementById("authSignInBtn");
    if (signInBtn) {
        signInBtn.disabled = true;
        signInBtn.textContent = "Signing In...";
    }

    try {
        await auth.signInWithEmailAndPassword(email, password);
        showToast("Welcome back!", "success");
    } catch (err) {
        console.error("Sign-In Error:", err);

        if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
            showPasswordError("Incorrect password. Please try again.");
        } else if (err.code === "auth/user-not-found") {
            showAuthMessage("No account found with that email address.");
        } else if (err.code === "auth/invalid-email") {
            showAuthMessage("Please enter a valid email address.");
        } else if (err.code === "auth/too-many-requests") {
            showAuthMessage("Too many attempts. Please try again later.");
        } else if (err.code === "auth/user-disabled") {
            showAuthMessage("This account has been disabled.");
        } else {
            showAuthMessage(err.message || "Unable to sign in.");
        }
    } finally {
        if (signInBtn) {
            signInBtn.disabled = false;
            signInBtn.textContent = "Sign In";
        }
    }
}

function showPasswordError(message) {
    const passwordInput = document.getElementById("authPassword");
    const passwordError = document.getElementById("authPasswordError");

    if (!passwordInput || !passwordError) return;

    passwordError.textContent = message;
    passwordError.classList.add("show");
    passwordInput.classList.add("input-error");
}

// General-purpose version of the same message slot, for anything in the
// auth flow that isn't specifically about the password field (a missing
// email, a failed account creation, a sign-in error) - showPasswordError
// above additionally reddens the password input's own border, which
// would be misleading for an error that has nothing to do with what's
// typed there. This is what most of the auth flow's error/success
// feedback runs through now - showToast() alone stopped being enough
// once toasts were removed, since it only logs silently and a sign-in
// error with zero immediate visible feedback is a real problem, not a
// cosmetic one. Shares its underlying implementation (showInlineMessage
// below) with any other confirmation/error slot elsewhere in the app
// that has the same need - see confirmDeleteAccount, for one.
function showInlineMessage(elementId, message, type = 'error') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('success', type === 'success');
    el.classList.add("show");
}

function clearInlineMessage(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = "";
    el.classList.remove("show", "success");
}

function showAuthMessage(message, type = 'error') {
    showInlineMessage("authPasswordError", message, type);
}

function clearAuthMessage() {
    clearInlineMessage("authPasswordError");
}

async function handleForgotPassword() {
    if (!auth) {
        showAuthMessage("Cloud sync not configured yet.");
        return;
    }

    const emailInput = document.getElementById("authEmail");
    const email = emailInput ? emailInput.value.trim() : "";

    clearAuthMessage();

    // Deliberately no window.prompt() fallback here - native browser
    // dialogs (prompt/alert/confirm) are unreliable and often silently do
    // nothing inside an installed standalone PWA on mobile, which is this
    // app's primary context. Asking in-app instead is the reliable path.
    if (!email) {
        showAuthMessage("Enter your email address above first.");
        if (emailInput) emailInput.focus();
        return;
    }

    try {
        await auth.sendPasswordResetEmail(email);
        // This action has no screen transition to confirm it worked the
        // way sign-in/sign-up do (see showAuthMessage's own comment) -
        // the person stays right here, so this needs to actually say so
        // rather than relying on the silent notifications log alone.
        showAuthMessage(`Password reset email sent to ${email}.`, 'success');
    } catch (err) {
        console.error("Password Reset Error:", err);

        if (err.code === "auth/user-not-found") {
            // Deliberately vague to avoid confirming which emails have accounts.
            showAuthMessage("If that email has an account, a reset link has been sent.", 'success');
        } else if (err.code === "auth/invalid-email") {
            showAuthMessage("Please enter a valid email address.");
        } else if (err.code === "auth/too-many-requests") {
            showAuthMessage("Too many attempts. Please try again later.");
        } else {
            showAuthMessage(err.message || "Couldn't send reset email right now.");
        }
    }
}

async function handleSignUp() {
    const username = document.getElementById("authUsername").value.trim();
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;

    if (!auth) {
        showAuthMessage("Cloud sync not configured yet.");
        return;
    }

    clearPasswordError();
    clearAuthMessage();

    // Username validation
    if (!username) {
        showAuthMessage("Please enter a username to register.");
        return;
    }

    if (!isValidUsernameFormat(username)) {
        showAuthMessage("Usernames must be 3-20 characters: lowercase letters, numbers, dots, and underscores only.");
        return;
    }

    if (!email) {
        showAuthMessage("Please enter your email address.");
        return;
    }

    // Password validation
    if (!password) {
        showAuthMessage("Please enter a password.");
        return;
    }

    // Password must be at least 6 characters
    if (password.length < 6) {
        showPasswordError("Password is too short. It must be at least 6 characters.");
        return;
    }

    const termsCheckbox = document.getElementById("authTermsCheckbox");
    if (termsCheckbox && !termsCheckbox.checked) {
        showAuthMessage("Please agree to the Terms of Service & Privacy Notice to continue.");
        return;
    }

    const signUpBtn = document.getElementById("authSignInBtn");
    if (signUpBtn) {
        signUpBtn.disabled = true;
        signUpBtn.textContent = "Joining...";
    }

    try {
        // Quick preflight check so an already-taken username is caught
        // before an auth account even exists, in the common (non-race)
        // case. This alone doesn't stop two people claiming the same
        // name at the exact same moment - the transaction below does.
        const available = await isUsernameAvailable(username);
        if (!available) {
            showAuthMessage("That username is already taken. Please choose another.");
            return;
        }

        const userCredential = await auth.createUserWithEmailAndPassword(
            email,
            password
        );

        // Reserve the username now that there's a uid to attach it to.
        // If someone else claimed it in the gap between the check above
        // and here, back the whole signup out - a half-created account
        // with no valid username isn't a state worth leaving behind.
        try {
            await claimUsername(userCredential.user.uid, username);
        } catch (claimErr) {
            console.error("Username claim FAILED", claimErr);
            try {
                await userCredential.user.delete();
            } catch (deleteErr) {
                console.error("Rollback after failed username claim also failed:", deleteErr);
            }
            showAuthMessage("That username was just taken by someone else. Please choose another.");
            return;
        }

        await userCredential.user.updateProfile({
            displayName: username
        });

        if (!state.profiles || state.profiles.length === 0) {
            state.profiles = [{
                id: "profile-main",
                name: username,
                initials: username.charAt(0).toUpperCase(),
                avatarId: randomAvatarId()
            }];
        } else {
            state.profiles[0].name = username;
            state.profiles[0].initials = username.charAt(0).toUpperCase();
            // state.profiles always already has a default guest profile
            // by this point (set up before sign-in), so this branch is
            // actually the one that runs for every real signup - the one
            // above is effectively dead code. Without this, a brand new
            // account's avatarId stayed null (the guest default),
            // getSelectedAvatar() had nothing to return, and
            // renderAvatarInto() fell back to showing initials instead
            // of one of the 8 curated avatars - not just on first paint,
            // permanently, since nothing else in the app ever assigns
            // one afterward on its own.
            if (!state.profiles[0].avatarId) {
                state.profiles[0].avatarId = randomAvatarId();
            }
        }
        state.username = username;

        await saveUserProfile();

        // Fire-and-forget: verification email shouldn't block account
        // creation from succeeding if sending it fails for some reason.
        userCredential.user.sendEmailVerification().catch((err) => {
            console.warn("Failed to send verification email:", err);
        });

        showToast("Account created! Check your inbox to verify your email.", "success");

    } catch (err) {
        console.error("Registration Error:", err);

        if (err.code === "auth/weak-password") {
            showPasswordError("Password is too short. It must be at least 6 characters.");
        } else if (err.code === "auth/email-already-in-use") {
            showAuthMessage("This email address is already registered.");
        } else if (err.code === "auth/invalid-email") {
            showAuthMessage("Please enter a valid email address.");
        } else {
            showAuthMessage(err.message || "Unable to create your account.");
        }
    } finally {
        if (signUpBtn) {
            signUpBtn.disabled = false;
            signUpBtn.textContent = "Join";
        }
    }
}

async function handleSignOut() {
    if (!auth) return;
    try {
        await auth.signOut();
        state.library = [];
        state.lists = [];
        hideChooseUsernameScreen();
        // Explicitly reset to Home on sign-out, not just relying on
        // proceedToApp's own showPage('home') on the NEXT sign-in - if
        // anything ever shows the auth screen without going through a
        // fresh proceedToApp call, the page DOM underneath would
        // otherwise still be sitting on whatever tab was active when
        // Sign Out was tapped, visible the moment the auth screen closes
        // again.
        showPage('home');
        refreshActivePage();
        showToast("Signed out successfully.", "success");
    } catch (err) {
        showErrorToast(err.message);
    }
}

/* =========================================================
   EMAIL VERIFICATION
   Password accounts are gated behind #verifyScreen (a full-screen overlay,
   same tier as #authScreen) until confirmed - verification is required
   right at account creation rather than being a banner discovered later
   inside the app. Google sign-in accounts skip this entirely since
   Google has already verified that address.
========================================================= */
function showVerifyScreen(user) {
    const authScreen = document.getElementById("authScreen");
    const mainApp = document.querySelector(".app");
    const verifyScreen = document.getElementById("verifyScreen");
    if (authScreen) authScreen.style.display = "none";
    if (mainApp) mainApp.style.display = "none";
    if (verifyScreen) {
        verifyScreen.style.display = "flex";
        const emailEl = document.getElementById("verifyEmailAddress");
        if (emailEl) emailEl.textContent = user.email;
    }
}

function hideVerifyScreen() {
    const verifyScreen = document.getElementById("verifyScreen");
    if (verifyScreen) verifyScreen.style.display = "none";
}

// Reloading the user only refreshes the cached emailVerified flag locally -
// it does not re-fire onAuthStateChanged - so a successful check has to
// hand off into proceedToApp itself rather than waiting on that listener.
// silent=true is used for the automatic check on tab-focus below, so
// coming back from the email link doesn't need a manual tap, but a
// still-unverified state doesn't nag with an error toast either.
async function checkVerificationStatus(silent = false) {
    if (!auth || !auth.currentUser) return;
    const btn = document.getElementById("verifyContinueBtn");
    if (btn && !silent) {
        btn.disabled = true;
        btn.textContent = "Checking...";
    }
    try {
        await auth.currentUser.reload();
        if (auth.currentUser.emailVerified) {
            hideVerifyScreen();
            const authScreen = document.getElementById("authScreen");
            const mainApp = document.querySelector(".app");
            await proceedToApp(auth.currentUser, authScreen, mainApp);
            showToast("Email verified - welcome to NovaWatch!", "success");
        } else if (!silent) {
            showErrorToast("Not verified yet - tap the link in your email first.");
        }
    } catch (err) {
        console.error("Failed to refresh verification status:", err);
        if (!silent) showErrorToast("Couldn't check verification status. Please try again.");
    } finally {
        if (btn && !silent) {
            btn.disabled = false;
            btn.textContent = "I've Verified, Continue";
        }
    }
}

// Coming back to the tab (e.g. after tapping the link in a mail app) is
// the most common way people actually verify - check automatically rather
// than making them remember to tap "Continue" themselves.
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const verifyScreen = document.getElementById("verifyScreen");
    if (verifyScreen && verifyScreen.style.display !== "none") {
        checkVerificationStatus(true);
    }
});

async function resendVerificationEmail() {
    if (!auth || !auth.currentUser) return;
    const btn = document.getElementById("resendVerifyBtn");
    if (btn) btn.disabled = true;
    try {
        await auth.currentUser.sendEmailVerification();
        showToast("Verification email sent - check your inbox.", "success");
    } catch (err) {
        console.error("Failed to resend verification email:", err);
        if (err.code === "auth/too-many-requests") {
            showErrorToast("Please wait a bit before requesting another email.");
        } else {
            showErrorToast("Couldn't send verification email. Please try again.");
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* =========================================================
   SELF-SERVICE ACCOUNT DELETION
   Deletes the person's Firestore library data and their Firebase Auth
   account itself - no manual/email-support step required. Firebase
   requires a *recent* sign-in for an operation this sensitive, so if the
   session is older than a few minutes this re-prompts for credentials
   (password re-entry for email/password accounts, a fresh Google popup
   for Google accounts) and retries once.
========================================================= */
async function reauthenticateCurrentUser(user) {
    const isGoogleAccount = user.providerData.some(p => p.providerId === 'google.com');
    try {
        if (isGoogleAccount) {
            const provider = new firebase.auth.GoogleAuthProvider();
            await user.reauthenticateWithPopup(provider);
        } else {
            const password = prompt("For your security, please re-enter your password to confirm account deletion:");
            if (!password) return false;
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
            await user.reauthenticateWithCredential(credential);
        }
        return true;
    } catch (err) {
        console.error("Reauthentication failed:", err);
        return false;
    }
}

// Firestore doesn't cascade-delete a subcollection when its parent
// document is deleted, so the library subcollection has to be cleared out
// document-by-document (batched, since a batch write tops out at 500 ops).
// Deletes every trace of the user's library data - both the live library
// and any archived watch history left behind by removeLibraryItem (see
// there) for shows that were removed but not permanently deleted. The
// Privacy Notice promises "all associated library data" goes with the
// account, so both collections have to go, not just the visible one.
async function deleteAllUserData(uid) {
    const BATCH_LIMIT = 400;

    async function deleteCollection(collectionName) {
        const snap = await db.collection("users").doc(uid).collection(collectionName).get();
        const docs = snap.docs;
        for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
            const batch = db.batch();
            docs.slice(i, i + BATCH_LIMIT).forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }
    }

    await deleteCollection("library");
    await deleteCollection("archivedShows");

    // Free up the reserved username so someone else can claim it -
    // otherwise a deleted account would permanently squat on the name.
    // Guarded to only delete a reservation that's actually this uid's
    // own, in case state.username is ever stale.
    if (state.username) {
        const usernameRef = db.collection("usernames").doc(state.username.toLowerCase());
        try {
            const usernameDoc = await usernameRef.get();
            if (usernameDoc.exists && usernameDoc.data().uid === uid) {
                await usernameRef.delete();
            }
        } catch (err) {
            console.warn("Couldn't release reserved username on account deletion:", err);
        }
    }

    await db.collection("users").doc(uid).delete().catch(() => {});
}

/* =========================================================
   BODY SCROLL LOCK (while any modal/sheet is open)
   A counter rather than a plain boolean, because modals can nest -
   the episode-details sheet opens on top of the show-details modal,
   and closing the inner one shouldn't unlock scroll while the outer
   one is still open. Saves/restores scroll position via body's
   top offset rather than plain `overflow: hidden`, since iOS Safari
   is notorious for letting background touch-scroll leak through a
   fixed-position overlay unless the body itself is also pinned.
========================================================= */
let bodyScrollLockCount = 0;
let savedScrollY = 0;
// Every modal that currently holds a lock, keyed by its element id. This is
// the actual fix for the recurring "scroll stops working" bug: previously
// each open function had to remember to check classList.contains('open')
// itself before calling lockBodyScroll(), and several places (found across
// two separate bug-fix passes) didn't - each such miss meant one unmatched
// extra lock that nothing would ever balance back out. Keying the lock by
// modal id here makes a duplicate lock call for the same modal a no-op
// automatically, regardless of whether the call site remembered to guard
// itself - so a future modal that forgets the check can't reintroduce this
// bug class.
let activeScrollLocks = new Set();

function lockBodyScroll(modalId) {
    if (modalId) {
        if (activeScrollLocks.has(modalId)) return;
        activeScrollLocks.add(modalId);
    }
    if (bodyScrollLockCount === 0) {
        savedScrollY = window.scrollY;
        document.body.style.position = "fixed";
        document.body.style.top = `-${savedScrollY}px`;
        document.body.style.width = "100%";
    }
    bodyScrollLockCount++;
}

function unlockBodyScroll(modalId) {
    if (modalId) {
        if (!activeScrollLocks.has(modalId)) return;
        activeScrollLocks.delete(modalId);
    }
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.width = "";
        window.scrollTo(0, savedScrollY);
    }
}

// Settings sheet - account actions (Sign Out / Delete Account) and
// preferences (notifications, streaming region), reached from the gear
// icon on Home's hero card rather than sitting permanently on Home.
function openSettingsSheet() {
    const modal = document.getElementById("settingsModal");
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    lockBodyScroll("settingsModal");
}

function closeSettingsSheet() {
    document.getElementById("settingsModal").classList.remove("open");
    unlockBodyScroll("settingsModal");
}

function closeSettingsOutside(event) {
    if (event.target.id === "settingsModal") closeSettingsSheet();
}

// NovaWrapped used to be its own separate page, kept apart specifically
// so navigating to/from it never unmounted the app or re-ran the sign-in
// flow. But it always needed the exact same signed-in session's Firestore
// data as everything else here - being separate meant loading a whole
// second copy of the Firebase SDK and re-initializing a second app
// instance just to read data this page already has in state.library.
// Migrated in as a plain modal instead: same "app never unmounts"
// property, none of the duplicate loading, and it's no longer possible
// for this to break the way the old iframe/pushState version did.
//
// Rewatches (rewatchCount on movies/episodes) are NOT counted toward
// Wrapped's totals here - only the original watch. This is the opposite
// of the Home tab's Viewing Analytics, which deliberately DOES count
// rewatches (see renderHomeTab's totalMinutes calculation) - don't
// "fix" this into consistency, the difference is intentional.
const NOVAWRAPPED_RELEASE_MS = Date.UTC(2027, 0, 1, 0, 0, 0, 0);
const NOVAWRAPPED_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const NOVAWRAPPED_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let novaWrappedAccountCreatedAt = null;
let currentNovaWrappedYear = null;

function openNovaWrappedModal() {
    // The "novawatch" account (the developer's own) can always preview
    // this regardless of the release gate below - everyone else still
    // sees it exactly on schedule.
    if (Date.now() < NOVAWRAPPED_RELEASE_MS && state.username !== "novawatch") {
        showErrorToast("Available 1 January 2027 @ 00:00 UTC");
        return;
    }
    const modal = document.getElementById("novaWrappedModal");
    renderNovaWrappedEntry();
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    lockBodyScroll("novaWrappedModal");
}

function closeNovaWrappedModal() {
    document.getElementById("novaWrappedModal").classList.remove("open");
    unlockBodyScroll("novaWrappedModal");
    // Only ever added while the slideshow itself was active (see
    // startWrappedSlideshow) - removing it unconditionally here is safe
    // either way, since removeEventListener on a listener that was never
    // added (closing from the year-picker landing screen, which never
    // attaches this) is simply a no-op, not an error.
    document.removeEventListener("keydown", handleWrappedKeydown);
}

function closeNovaWrappedModalOutside(event) {
    if (event.target.id === "novaWrappedModal") closeNovaWrappedModal();
}

// The release-date check now happens earlier, in openNovaWrappedModal()
// itself (as an error toast instead of ever opening the modal) - by the
// time this runs, we're already past the release date, so it goes
// straight to the real render.
function renderNovaWrappedEntry() {
    novaWrappedAccountCreatedAt = (auth && auth.currentUser && auth.currentUser.metadata && auth.currentUser.metadata.creationTime)
        ? new Date(auth.currentUser.metadata.creationTime)
        : null;
    renderNovaWrapped();
}

/* =========================================================
   STATS COMPUTATION
   Tracks Jan 1 - Dec 31 UTC for whichever year is selected. The first
   7 days after account creation are excluded from whichever year they
   fall in - new users tend to bulk-add a backlog of shows/movies
   they'd already watched long before joining, and counting that as
   real-time viewing would badly skew the recap.
========================================================= */
function getNovaWrappedYearBounds(year) {
    return {
        start: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
        end: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999))
    };
}

function getNovaWrappedEffectiveStart(year) {
    const { start } = getNovaWrappedYearBounds(year);
    if (!novaWrappedAccountCreatedAt) return start;
    const graceEnd = new Date(novaWrappedAccountCreatedAt.getTime() + NOVAWRAPPED_GRACE_PERIOD_MS);
    return graceEnd > start ? graceEnd : start;
}

function getNovaWrappedYearMinMax() {
    const max = new Date().getUTCFullYear();
    const min = novaWrappedAccountCreatedAt ? novaWrappedAccountCreatedAt.getUTCFullYear() : max;
    return { min, max };
}

function computeNovaWrappedStats(year) {
    const { end } = getNovaWrappedYearBounds(year);
    const effectiveStart = getNovaWrappedEffectiveStart(year);

    const inRange = (isoString) => {
        if (!isoString) return false;
        const d = new Date(isoString);
        return d >= effectiveStart && d <= end;
    };

    let totalMinutes = 0;
    let moviesCount = 0;
    let episodesCount = 0;
    let rewatchCount = 0;
    const showEpisodeCounts = new Map();
    const monthMinutes = new Array(12).fill(0);

    state.library.forEach(item => {
        if (item.type === 'movie') {
            if (item.watched && inRange(item.lastWatchedAt)) {
                const match = (item.runtime || "").match(/(\d+)/);
                const mins = match ? parseInt(match[1], 10) : 120;
                totalMinutes += mins;
                moviesCount++;
                monthMinutes[new Date(item.lastWatchedAt).getUTCMonth()] += mins;
            }
            // Rewatches are counted as their own separate fun fact (see
            // the Rewatches slide) even though - same as Total Watch
            // Time above - they're deliberately excluded from every
            // other total on this page, consistent with how the rest of
            // NovaWrapped already treats them.
            if (item.rewatchCount && inRange(item.lastWatchedAt)) rewatchCount += item.rewatchCount;
        } else if (item.episodes) {
            item.episodes.forEach(ep => {
                if (!ep.watched || !inRange(ep.watchedAt)) return;
                const match = (ep.runtime || "").match(/(\d+)/);
                const mins = match ? parseInt(match[1], 10) : 45;
                totalMinutes += mins;
                episodesCount++;
                monthMinutes[new Date(ep.watchedAt).getUTCMonth()] += mins;

                const existing = showEpisodeCounts.get(item.id);
                if (existing) {
                    existing.count++;
                } else {
                    showEpisodeCounts.set(item.id, { title: item.title, count: 1, poster: item.poster });
                }

                if (ep.rewatchCount) rewatchCount += ep.rewatchCount;
            });
        }
    });

    let topShow = null;
    showEpisodeCounts.forEach(show => {
        if (!topShow || show.count > topShow.count) topShow = show;
    });

    let busiestMonth = null;
    monthMinutes.forEach((mins, idx) => {
        if (mins > 0 && (!busiestMonth || mins > busiestMonth.minutes)) {
            busiestMonth = { label: NOVAWRAPPED_MONTH_NAMES[idx], minutes: mins };
        }
    });

    return {
        year,
        totalMinutes,
        days: Math.floor(totalMinutes / 1440),
        hours: Math.floor((totalMinutes % 1440) / 60),
        minutes: totalMinutes % 60,
        moviesCount,
        episodesCount,
        showsCount: showEpisodeCounts.size,
        topShow,
        busiestMonth,
        rewatchCount,
        // Rough, deliberately playful equivalents for the "hero" total -
        // whole numbers only, since "2.3 movie-nights" reads as a
        // miscalculation, not a fun fact. Assumes a 2-hour movie and an
        // 8-hour sleep/work day - approximate on purpose, this is meant
        // to give a sense of scale, not be a precise unit conversion.
        equivalentMovies: Math.floor(totalMinutes / 120),
        equivalentFullDays: Math.floor(totalMinutes / 1440),
        equivalentWorkWeeks: Math.round((totalMinutes / 60 / 40) * 10) / 10,
        hasData: totalMinutes > 0
    };
}

function renderNovaWrapped() {
    const { min, max } = getNovaWrappedYearMinMax();
    // Default to the most recently *completed* year (a proper "recap"),
    // falling back to the current year if the account is younger than
    // that - e.g. someone who joined partway through the current year.
    currentNovaWrappedYear = (max - 1 >= min) ? max - 1 : max;

    document.getElementById("novaWrappedRoot").innerHTML = `
        <div class="wrapped-hero">
            <div class="wrapped-hero-title">NovaWrapped</div>
            <div class="wrapped-hero-sub">Your year in watching, one story at a time.</div>
        </div>
        <div class="wrapped-year-nav">
            <button class="year-nav-btn" id="wrappedYearPrev" aria-label="Previous year">
                <svg class="icon" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div class="wrapped-year-label" id="wrappedYearLabel"></div>
            <button class="year-nav-btn" id="wrappedYearNext" aria-label="Next year">
                <svg class="icon" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>
            </button>
        </div>
        <div id="wrappedBody"></div>
    `;

    document.getElementById("wrappedYearPrev").addEventListener("click", () => changeNovaWrappedYear(-1));
    document.getElementById("wrappedYearNext").addEventListener("click", () => changeNovaWrappedYear(1));

    renderNovaWrappedYear();
}

function changeNovaWrappedYear(delta) {
    const { min, max } = getNovaWrappedYearMinMax();
    const next = currentNovaWrappedYear + delta;
    if (next < min || next > max) return;
    currentNovaWrappedYear = next;
    renderNovaWrappedYear();
}

// The year-picker landing screen - no longer the dashboard itself (see
// startWrappedSlideshow below for that). Just enough here to confirm
// there's something worth watching a recap of, and a way in.
function renderNovaWrappedYear() {
    const { min, max } = getNovaWrappedYearMinMax();
    document.getElementById("wrappedYearLabel").textContent = currentNovaWrappedYear;
    document.getElementById("wrappedYearPrev").disabled = currentNovaWrappedYear <= min;
    document.getElementById("wrappedYearNext").disabled = currentNovaWrappedYear >= max;

    const stats = computeNovaWrappedStats(currentNovaWrappedYear);
    const body = document.getElementById("wrappedBody");

    if (!stats.hasData) {
        const isCurrentYear = currentNovaWrappedYear === new Date().getUTCFullYear();
        body.innerHTML = `
            <div class="state-card">
                <div class="state-title">Nothing Tracked Yet</div>
                <p class="state-sub" style="margin-bottom: 0;">No watch activity recorded for ${currentNovaWrappedYear}${isCurrentYear ? " so far" : ""}.</p>
            </div>
        `;
        return;
    }

    body.innerHTML = `
        <button class="wrapped-start-btn" onclick="startWrappedSlideshow()">
            View My ${currentNovaWrappedYear} Wrapped
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        </button>
    `;
}

/* =========================================================
   WRAPPED SLIDESHOW
   A full-screen, story-style sequence (tap/swipe through, a progress
   bar per slide - the same interaction language as Instagram/Snapchat
   stories) instead of the scrolling stat-dashboard this used to be.
   Each slide is built only if there's actually something to say - a
   year with no rewatches simply doesn't get a rewatch slide, rather
   than showing a hollow "0 rewatches" - and the whole sequence is
   computed once upfront (buildWrappedSlides) rather than per-navigation,
   since the underlying stats never change mid-slideshow.
========================================================= */
let wrappedSlides = [];
let wrappedSlideIndex = 0;

function buildWrappedSlides(stats) {
    const slides = [];

    slides.push({
        bg: 'wrapped-bg-intro',
        html: `
            <div class="wrapped-slide-content">
                <div class="wrapped-slide-eyebrow">${stats.year} Wrapped</div>
                <div class="wrapped-slide-headline">Let's look back<br>at your year.</div>
                <div class="wrapped-slide-tap-hint">Tap to continue</div>
            </div>
        `
    });

    slides.push({
        bg: 'wrapped-bg-time',
        html: `
            <div class="wrapped-slide-content">
                <div class="wrapped-slide-eyebrow">You spent</div>
                <div class="wrapped-slide-number">${stats.days}<span class="wrapped-slide-unit">d</span> ${stats.hours}<span class="wrapped-slide-unit">h</span></div>
                <div class="wrapped-slide-headline">watching in ${stats.year}.</div>
                ${stats.equivalentFullDays > 0 ? `<div class="wrapped-slide-footnote">That's ${stats.equivalentFullDays} full ${stats.equivalentFullDays === 1 ? 'day' : 'days'} straight.</div>` : ''}
            </div>
        `
    });

    if (stats.moviesCount > 0) {
        slides.push({
            bg: 'wrapped-bg-movies',
            html: `
                <div class="wrapped-slide-content">
                    <div class="wrapped-slide-eyebrow">On the big screen</div>
                    <div class="wrapped-slide-number">${stats.moviesCount}</div>
                    <div class="wrapped-slide-headline">${stats.moviesCount === 1 ? 'movie' : 'movies'} watched.</div>
                    ${stats.equivalentMovies > stats.moviesCount ? `<div class="wrapped-slide-footnote">Your total watch time alone was worth ${stats.equivalentMovies} movies.</div>` : ''}
                </div>
            `
        });
    }

    if (stats.episodesCount > 0) {
        slides.push({
            bg: 'wrapped-bg-tv',
            html: `
                <div class="wrapped-slide-content">
                    <div class="wrapped-slide-eyebrow">Binged and watched</div>
                    <div class="wrapped-slide-number">${stats.episodesCount}</div>
                    <div class="wrapped-slide-headline">episodes across ${stats.showsCount} ${stats.showsCount === 1 ? 'show' : 'shows'}.</div>
                </div>
            `
        });
    }

    if (stats.topShow) {
        slides.push({
            bg: 'wrapped-bg-spotlight',
            poster: stats.topShow.poster,
            html: `
                <div class="wrapped-slide-content">
                    <div class="wrapped-slide-eyebrow">Your most-watched show</div>
                    <div class="wrapped-slide-headline wrapped-slide-headline-big">${escapeHTML(stats.topShow.title)}</div>
                    <div class="wrapped-slide-footnote">${stats.topShow.count} ${stats.topShow.count === 1 ? 'episode' : 'episodes'} watched</div>
                </div>
            `
        });
    }

    if (stats.busiestMonth) {
        slides.push({
            bg: 'wrapped-bg-month',
            html: `
                <div class="wrapped-slide-content">
                    <div class="wrapped-slide-eyebrow">Your biggest month was</div>
                    <div class="wrapped-slide-headline wrapped-slide-headline-big">${stats.busiestMonth.label}</div>
                    <div class="wrapped-slide-footnote">${Math.round(stats.busiestMonth.minutes / 60)} hours watched that month</div>
                </div>
            `
        });
    }

    if (stats.rewatchCount > 0) {
        slides.push({
            bg: 'wrapped-bg-rewatch',
            html: `
                <div class="wrapped-slide-content">
                    <div class="wrapped-slide-eyebrow">Some favorites earned a</div>
                    <div class="wrapped-slide-number">${stats.rewatchCount}</div>
                    <div class="wrapped-slide-headline">${stats.rewatchCount === 1 ? 'rewatch' : 'rewatches'} this year.</div>
                </div>
            `
        });
    }

    slides.push({
        bg: 'wrapped-bg-recap',
        isFinal: true,
        html: `
            <div class="wrapped-slide-content">
                <div class="wrapped-slide-eyebrow">${stats.year} Wrapped</div>
                <div class="wrapped-recap-grid">
                    <div class="wrapped-recap-stat"><div class="wrapped-recap-value">${stats.days}d ${stats.hours}h</div><div class="wrapped-recap-label">Watch Time</div></div>
                    <div class="wrapped-recap-stat"><div class="wrapped-recap-value">${stats.moviesCount}</div><div class="wrapped-recap-label">Movies</div></div>
                    <div class="wrapped-recap-stat"><div class="wrapped-recap-value">${stats.episodesCount}</div><div class="wrapped-recap-label">Episodes</div></div>
                    <div class="wrapped-recap-stat"><div class="wrapped-recap-value">${stats.showsCount}</div><div class="wrapped-recap-label">Shows</div></div>
                </div>
                ${stats.topShow ? `<div class="wrapped-recap-topshow">Most watched: <strong>${escapeHTML(stats.topShow.title)}</strong></div>` : ''}
            </div>
        `
    });

    return slides;
}

function startWrappedSlideshow() {
    const stats = computeNovaWrappedStats(currentNovaWrappedYear);
    wrappedSlides = buildWrappedSlides(stats);
    wrappedSlideIndex = 0;

    const root = document.getElementById("novaWrappedRoot");
    root.innerHTML = `
        <div class="wrapped-progress-row" id="wrappedProgressRow"></div>
        <div class="wrapped-slide-stage" id="wrappedSlideStage">
            <div class="wrapped-tap-zone wrapped-tap-zone-left" onclick="wrappedGoBack()"></div>
            <div class="wrapped-tap-zone wrapped-tap-zone-right" onclick="wrappedGoNext()"></div>
        </div>
        <!-- Visible, tappable arrows alongside the tap zones above, not
             instead of them - a full-bleed invisible tap zone is the
             established convention for story-style formats (Instagram/
             Snapchat), but it's discoverable only if you already know
             that convention exists. A visible control means someone
             seeing this for the first time doesn't have to guess where
             the screen is tappable at all. stopPropagation so tapping
             the arrow doesn't also fire the tap zone underneath it. -->
        <button class="wrapped-nav-arrow wrapped-nav-arrow-left" id="wrappedArrowPrev" onclick="event.stopPropagation(); wrappedGoBack()" aria-label="Previous">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <button class="wrapped-nav-arrow wrapped-nav-arrow-right" id="wrappedArrowNext" onclick="event.stopPropagation(); wrappedGoNext()" aria-label="Next">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        <div class="wrapped-slide-counter" id="wrappedSlideCounter"></div>
    `;
    // Each segment is tappable too, not just fillable - jumps straight
    // to that slide instead of only ever being able to step one at a
    // time, the same "tap the progress dots to jump" pattern most
    // story-style formats with a visible progress row already support.
    document.getElementById("wrappedProgressRow").innerHTML =
        wrappedSlides.map((_, i) => `<div class="wrapped-progress-seg" id="wrappedSeg${i}" onclick="jumpToWrappedSlide(${i})"></div>`).join('');

    initWrappedSwipeGesture();
    document.addEventListener("keydown", handleWrappedKeydown);

    renderWrappedSlideAt(0);
}

function renderWrappedSlideAt(index) {
    const stage = document.getElementById("wrappedSlideStage");
    const slide = wrappedSlides[index];
    if (!stage || !slide) return;

    wrappedSlides.forEach((_, i) => {
        const seg = document.getElementById(`wrappedSeg${i}`);
        if (!seg) return;
        seg.classList.toggle('filled', i < index);
        seg.classList.toggle('active', i === index);
    });

    const counter = document.getElementById("wrappedSlideCounter");
    if (counter) counter.textContent = `${index + 1} / ${wrappedSlides.length}`;

    // The Next arrow visually disables on the last slide rather than
    // just silently doing nothing when tapped there (wrappedGoNext()
    // already no-ops past the end) - a visible, tappable-looking button
    // that does nothing is a worse experience than one that's clearly
    // not available right now. Previous never disables, even on the
    // first slide - going back there exits to the year picker screen
    // instead (see wrappedGoBack()), which is a real, valid action.
    const nextArrow = document.getElementById("wrappedArrowNext");
    if (nextArrow) nextArrow.disabled = index >= wrappedSlides.length - 1;

    const existing = stage.querySelector('.wrapped-slide-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.className = `wrapped-slide-panel ${slide.bg}`;
    if (slide.poster) {
        panel.style.setProperty('--wrapped-poster-url', `url('${slide.poster}')`);
        panel.classList.add('has-poster');
    }
    panel.innerHTML = slide.html + (slide.isFinal ? `
        <div class="wrapped-recap-actions">
            <button class="confirm-btn primary" onclick="event.stopPropagation(); shareNovaWrapped()">Share</button>
            <button class="confirm-btn cancel" onclick="event.stopPropagation(); closeNovaWrappedModal()">Done</button>
        </div>
    ` : '');
    stage.insertBefore(panel, stage.firstChild);
}

// Jumps straight to a specific slide via its progress segment (see
// startWrappedSlideshow) - same rendering path a normal next/back step
// already uses, just landing on an arbitrary index instead of an
// adjacent one.
function jumpToWrappedSlide(index) {
    if (index < 0 || index >= wrappedSlides.length || index === wrappedSlideIndex) return;
    wrappedSlideIndex = index;
    renderWrappedSlideAt(wrappedSlideIndex);
}

function wrappedGoNext() {
    if (wrappedSlideIndex >= wrappedSlides.length - 1) return;
    wrappedSlideIndex++;
    renderWrappedSlideAt(wrappedSlideIndex);
}

// At the very first slide, "back" exits to the year-picker screen
// instead of doing nothing - there's nowhere further back within the
// slideshow itself.
function wrappedGoBack() {
    if (wrappedSlideIndex <= 0) {
        renderNovaWrapped();
        return;
    }
    wrappedSlideIndex--;
    renderWrappedSlideAt(wrappedSlideIndex);
}

// Swipe left/right, not just tap zones - a story format like this one
// is conventionally navigated by swipe on a touch device (the same
// Instagram/Snapchat-style interaction language the tap zones already
// borrow from), so relying on tap alone left out the gesture people are
// actually most likely to reach for first. Runs once when the
// slideshow starts (see startWrappedSlideshow) rather than being
// re-attached on every single slide change - the listeners live on the
// stage itself, not any one slide's own DOM, so they don't need to be.
// A horizontal swipe is distinguished from a vertical one (scroll/
// dismiss) by checking which axis moved further, so an accidental
// diagonal drag doesn't misfire as a slide change.
function initWrappedSwipeGesture() {
    const stage = document.getElementById("wrappedSlideStage");
    if (!stage) return;
    let startX = 0, startY = 0, tracking = false;

    stage.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, { passive: true });

    stage.addEventListener("touchend", (e) => {
        if (!tracking) return;
        tracking = false;
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const dx = endX - startX;
        const dy = endY - startY;
        // Under ~40px isn't a deliberate swipe - closer to a tap that
        // moved slightly, which the tap zones underneath already handle
        // on their own.
        if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
        if (dx < 0) wrappedGoNext(); else wrappedGoBack();
    }, { passive: true });
}

// Left/right arrow keys, for anyone on a desktop browser rather than a
// touchscreen - tap zones and swipe both assume touch/click input, which
// a keyboard has neither of. Escape closes the slideshow entirely, the
// keyboard equivalent of the header's own close button. Attached once
// when the slideshow starts, removed when it ends (see
// startWrappedSlideshow/closeNovaWrappedModal) rather than left
// listening app-wide the whole time this modal isn't even open.
function handleWrappedKeydown(e) {
    if (e.key === "ArrowRight") wrappedGoNext();
    else if (e.key === "ArrowLeft") wrappedGoBack();
    else if (e.key === "Escape") closeNovaWrappedModal();
}

async function shareNovaWrapped() {
    const stats = computeNovaWrappedStats(currentNovaWrappedYear);
    const shareData = {
        title: `My ${currentNovaWrappedYear} NovaWrapped`,
        text: `My ${currentNovaWrappedYear} NovaWrapped: ${stats.days}d ${stats.hours}h watched, ${stats.moviesCount} movies, ${stats.episodesCount} episodes across ${stats.showsCount} shows.`,
        url: NOVAWATCH_APP_URL
    };

    if (navigator.share) {
        try {
            await navigator.share(shareData);
        } catch (err) {
            if (err.name !== 'AbortError') console.error("Share failed:", err);
        }
        return;
    }

    if (navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
            showToast("Copied to clipboard!", "success");
        } catch (err) {
            console.error("Clipboard write failed:", err);
            showErrorToast("Unable to share.");
        }
        return;
    }

    showErrorToast("Sharing isn't supported on this device.");
}


// Loads a same-origin sub-page inside the full-screen iframe overlay and
// reflects it in the address bar via pushState, so the URL is still
// shareable/bookmarkable and the browser back button works normally -
// see the popstate listener below for the other half of that.
function openPageOverlay(path) {
    const modal = document.getElementById("pageOverlayModal");
    document.getElementById("pageOverlayFrame").src = path;
    // Guarded on its own: if this ever throws (e.g. some other origin
    // edge case), the overlay should still open - a working page with a
    // URL bar that didn't update is a far smaller problem than the whole
    // button silently doing nothing, which is exactly what happened when
    // this wasn't guarded and NOVAWATCH_APP_URL didn't match the actual
    // origin (see its definition above).
    try {
        history.pushState({ novawatchOverlay: path }, "", `${NOVAWATCH_APP_URL}${path}`);
    } catch (err) {
        console.error("pushState failed while opening page overlay:", err);
    }
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    lockBodyScroll("pageOverlayModal");
}

// fromPopstate is true when this is called in response to the browser's
// back button (history already moved) - in that case there's nothing
// left to pop, so calling history.back() again would skip an extra entry.
function closePageOverlay(fromPopstate = false) {
    document.getElementById("pageOverlayModal").classList.remove("open");
    document.getElementById("pageOverlayFrame").src = "about:blank";
    unlockBodyScroll("pageOverlayModal");
    if (!fromPopstate) {
        history.back();
    }
}

window.addEventListener("popstate", (event) => {
    const overlayModal = document.getElementById("pageOverlayModal");
    const isOpen = overlayModal.classList.contains("open");

    if (event.state && event.state.novawatchOverlay) {
        // Forward/re-entered a pushed overlay state (e.g. the forward
        // button) - reopen without pushing a new entry, since this one's
        // already in the history stack.
        if (!isOpen) {
            document.getElementById("pageOverlayFrame").src = event.state.novawatchOverlay;
            overlayModal.classList.add("open");
            lockBodyScroll("pageOverlayModal");
        }
    } else if (isOpen) {
        closePageOverlay(true);
    }
});

// Opens the themed confirmation dialog instead of a native browser
// confirm() - the actual deletion only runs from confirmDeleteAccount()
// below, once the person taps "Delete" inside it.
function handleDeleteAccount() {
    if (!auth || !auth.currentUser) return;
    const modal = document.getElementById("deleteAccountModal");
    if (modal.classList.contains("open")) return;
    clearInlineMessage("deleteAccountError");
    modal.classList.add("open");
    lockBodyScroll("deleteAccountModal");
}

function closeDeleteAccountModal() {
    document.getElementById("deleteAccountModal").classList.remove("open");
    unlockBodyScroll("deleteAccountModal");
}

function closeDeleteAccountModalOutside(event) {
    if (event.target.id === "deleteAccountModal") closeDeleteAccountModal();
}

async function confirmDeleteAccount() {
    if (!auth || !auth.currentUser) return;

    const user = auth.currentUser;
    const btn = document.getElementById("confirmDeleteBtn");
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Deleting...";
    }
    clearInlineMessage("deleteAccountError");

    async function attemptDelete() {
        await deleteAllUserData(user.uid);
        await user.delete();
    }

    try {
        await attemptDelete();
        closeDeleteAccountModal();
        showToast("Your account has been deleted.", "success");
    } catch (err) {
        if (err.code === "auth/requires-recent-login") {
            const reauthed = await reauthenticateCurrentUser(user);
            if (!reauthed) {
                // The modal stays open here (reauthentication was
                // cancelled, not the deletion itself failing) - needs to
                // actually say so, since nothing else about the screen
                // changes to indicate it.
                showInlineMessage("deleteAccountError", "Account deletion cancelled - please try again.");
            } else {
                try {
                    await attemptDelete();
                    closeDeleteAccountModal();
                    showToast("Your account has been deleted.", "success");
                } catch (err2) {
                    console.error("Account deletion failed after reauthentication:", err2);
                    showInlineMessage("deleteAccountError", "Couldn't delete your account. Please try again.");
                }
            }
        } else {
            console.error("Account deletion failed:", err);
            showInlineMessage("deleteAccountError", "Couldn't delete your account. Please try again.");
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Delete";
        }
    }
}

// Only touches the DOM if the newly-generated HTML actually differs from
// what's already there. A periodic background sync calling a render
// function every few minutes (see refreshActivePage below) was rebuilding
// every poster/thumbnail <img> from scratch each time it ran, EVEN WHEN
// NOTHING had actually changed - which is what was causing posters to
// visibly flash app-wide every sync cycle: destroying and recreating an
// image element forces a fresh load/paint cycle even when the browser
// serves the identical image instantly from its own cache. Used by every
// render function that can be re-triggered by something other than a
// direct user action (a sync, a periodic refresh), not just the ones
// wired to a button tap.
function setInnerHTMLIfChanged(el, html) {
    if (!el) return false;
    if (el.innerHTML !== html) {
        el.innerHTML = html;
        return true;
    }
    return false;
}

// A targeted alternative to the whole-container replacement above,
// specifically for poster grids (createCard's own output, which
// already tags each card with data-id="<item id>") - setInnerHTMLIfChanged
// is all-or-nothing: if a SINGLE card's content changes anywhere in the
// container (a progress bar updating for one show among a dozen),
// string comparison sees the whole block as different and replaces the
// entire container, destroying and recreating every <img> in it - which
// is what was actually causing posters to visibly flicker/"reload" on
// every library update, tab switch, or modal open, even for cards
// whose own data never changed at all. This instead updates only the
// specific cards whose own rendered HTML actually changed, and leaves
// every other card's existing DOM node - including its already-decoded
// image - completely untouched.
function syncCardGrid(container, items, cardHtmlFn) {
    if (!container) return;

    const newIds = new Set(items.map(item => item.id));
    Array.from(container.children).forEach(child => {
        if (!newIds.has(child.dataset.id)) child.remove();
    });

    let previousNode = null;
    items.forEach(item => {
        const html = cardHtmlFn(item).trim();
        let node = container.querySelector(`[data-id="${CSS.escape(item.id)}"]`);

        if (!node || node.outerHTML !== html) {
            const temp = document.createElement('div');
            temp.innerHTML = html;
            const freshNode = temp.firstElementChild;
            if (node) {
                node.replaceWith(freshNode);
            } else {
                container.appendChild(freshNode);
            }
            node = freshNode;
        }

        // Keeps items in the right order without moving nodes that are
        // already correctly positioned - only touches the DOM when an
        // item has actually moved, same "don't disturb what's already
        // right" principle as the replacement logic above.
        if (previousNode ? previousNode.nextElementSibling !== node : container.firstElementChild !== node) {
            if (previousNode) previousNode.after(node);
            else container.prepend(node);
        }
        previousNode = node;
    });
}

function refreshActivePage() {
    if (document.getElementById("libraryPage").classList.contains("active")) renderLibraryHome();

    // Independent of which tab is "active" underneath - the Full Library
    // modal is its own overlay, not tied to .page.active the way the
    // preview above is, so a library change (a new watch, a remove)
    // needs to refresh it too whenever it happens to be open, regardless
    // of which tab is showing behind it.
    if (document.getElementById("fullLibraryModal").classList.contains("open")) {
        if (currentLibraryView === 'tv') renderTVLibrarySection();
        if (currentLibraryView === 'movies') renderMovieLibrarySection();
    }

    // Same idea for the Add to List picker - a list created from
    // within it (via + Create New List) needs to appear in its own
    // checklist right away, not just the next time it's reopened.
    if (document.getElementById("listPickerModal").classList.contains("open")) {
        renderListPickerContent();
    }

    // And the List Detail view - a list can be edited/deleted from
    // another device while it's open here.
    if (document.getElementById("listDetailModal").classList.contains("open")) {
        renderListDetailContent();
    }

    // And Reorder Lists - a list created/deleted/renamed elsewhere
    // should be reflected immediately if this happens to be open too.
    if (document.getElementById("reorderListsModal").classList.contains("open")) {
        renderReorderListsContent();
    }

    if (document.getElementById("homePage").classList.contains("active")) renderHomeTab();
    if (document.getElementById("upcomingPage").classList.contains("active")) {
        if (currentUpcomingView === 'tv') renderUpcomingTVSection();
        if (currentUpcomingView === 'movies') renderUpcomingMovieSection();
    }
    updateHomeUI();
    checkAchievements();
}

/* =========================================================
   AUTOMATIC TV SHOW, MOVIE & EPISODE UPDATES & RELEASE ALERTS
========================================================= */
// Guards against overlapping passes (e.g. the periodic timer firing while a
// manual refresh, or the post-sign-in check, is still in flight).
let isSyncingLibrary = false;

// Tracks which items currently have a TMDB refresh in flight (keyed by
// item.id), each holding the in-progress promise. Prevents redundant
// duplicate network calls when the periodic background sync and an
// on-open modal refresh happen to land on the same item at the same time.
const itemRefreshesInFlight = new Map();

function refreshItemFromTMDB(item) {
    if (!item.tmdbId) return Promise.resolve({ changed: false, failed: false });

    if (itemRefreshesInFlight.has(item.id)) {
        return itemRefreshesInFlight.get(item.id);
    }

    const promise = refreshItemFromTMDBInternal(item).finally(() => {
        itemRefreshesInFlight.delete(item.id);
    });

    itemRefreshesInFlight.set(item.id, promise);
    return promise;
}

// Comprehensive background sync: refreshes EVERY TMDB-sourced field on every
// library item (title, year, poster, backdrop, description, status, rating,
// season/episode counts, next-air date, full episode list, streaming
// providers/cinema status) while always preserving user-specific data
// (watched flags, favourites, stop/finished state, lastWatchedAt, etc).
// Only items whose TMDB data actually changed are written back to Firebase
// (saveItem uses merge:true), so unaffected library entries cost nothing.
async function checkLibraryForUpdates() {
    if (!state.library || state.library.length === 0) return;
    if (isSyncingLibrary) return;
    isSyncingLibrary = true;
    let updated = false;

    try {
        for (let item of state.library) {
            if (!item.tmdbId) continue;
            const result = await refreshItemFromTMDB(item);
            if (result.changed) updated = true;
        }

        if (updated) {
            refreshActivePage();
        }

        setLastLibraryCheck(now());
    } finally {
        isSyncingLibrary = false;
    }
}

// Refreshes a single library item's TMDB-sourced fields (and watch
// availability) in place, preserving user-specific data (watched flags,
// stop/finished state, lastWatchedAt, etc). Returns true if anything
// actually changed (and was saved), false otherwise. Shared by the
// periodic background sync above and by the details modal below, which
// calls this the moment it opens so info is never stale even if the last
// background pass hasn't run recently.
async function refreshItemFromTMDBInternal(item) {
    if (!item.tmdbId) return { changed: false, failed: false };
    let changed = false;
    let failed = false;

    try {
                if (item.type === 'movie') {
                    const res = await fetch(`https://api.themoviedb.org/3/movie/${item.tmdbId}?api_key=${TMDB_API_KEY}`);
                    const movieData = await res.json();
                    if (!movieData || !movieData.id) return { changed: false, failed: false };

                    const newTitle = movieData.title || item.title;
                    const newYear = movieData.release_date ? movieData.release_date.substring(0, 4) : item.year;
                    // A custom poster/backdrop (picked via long-press) is never
                    // overwritten by this background refresh - only TMDB's own
                    // "primary" image gets auto-updated.
                    const newPoster = item.customPoster ? item.poster : (movieData.poster_path ? `https://image.tmdb.org/t/p/w500${movieData.poster_path}` : item.poster);
                    const newBackdrop = item.customBackdrop ? item.backdrop : (movieData.backdrop_path ? `https://image.tmdb.org/t/p/w780${movieData.backdrop_path}` : item.backdrop);
                    const newDescription = movieData.overview || item.description;
                    const newRuntime = movieData.runtime ? `${movieData.runtime} min` : item.runtime;
                    const newReleaseDate = movieData.release_date ? tmdbDateToISO(movieData.release_date) : item.releaseDate;
                    const newStatus = movieData.status || item.status || '';
                    const newRating = (typeof movieData.vote_average === 'number' && movieData.vote_average > 0)
                        ? movieData.vote_average.toFixed(1)
                        : (item.rating || '');
                    const newCollectionName = movieData.belongs_to_collection ? movieData.belongs_to_collection.name : (item.collectionName || null);

                    if (
                        item.title !== newTitle ||
                        item.year !== newYear ||
                        item.poster !== newPoster ||
                        item.backdrop !== newBackdrop ||
                        item.description !== newDescription ||
                        item.runtime !== newRuntime ||
                        item.releaseDate !== newReleaseDate ||
                        item.status !== newStatus ||
                        item.rating !== newRating ||
                        (item.collectionName || null) !== newCollectionName
                    ) {
                        item.title = newTitle;
                        item.year = newYear;
                        item.poster = newPoster;
                        item.backdrop = newBackdrop;
                        item.description = newDescription;
                        item.runtime = newRuntime;
                        item.releaseDate = newReleaseDate;
                        item.status = newStatus;
                        item.rating = newRating;
                        item.collectionName = newCollectionName;

                        await saveItem(item);
                        changed = true;
                    }
                } else {
                    // TV Shows: refresh show-level metadata AND the full episode/season list.
                    // external_ids appended so resolveTVmazeShow() below has an
                    // IMDB id for an exact TVmaze lookup, without a second round-trip.
                    const res = await fetch(`https://api.themoviedb.org/3/tv/${item.tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);
                    const showData = await res.json();
                    if (!showData || !showData.seasons) return { changed: false, failed: false };
                    const validSeasons = showData.seasons.filter(s => s.season_number > 0);
                    const seasonsData = await Promise.all(validSeasons.map(season => fetchTMDBSeason(item.tmdbId, season.season_number)));

                    // Real per-episode timing (see the TV EPISODE RELEASE TIMING
                    // block near tmdbDateToISO) - resolved every sync so a show
                    // that only just got picked up by a network TVmaze tracks
                    // (or one whose schedule changed) picks that up here, not
                    // just at add time. resolveTVmazeShow() mutates item.tvmazeId
                    // as a caching side effect - captured before/after so that
                    // first-time resolution gets saved even on a sync where
                    // nothing else about the show happened to change (otherwise
                    // it'd never persist and every sync would re-search TVmaze
                    // from scratch, forever).
                    const prevTvmazeId = item.tvmazeId;
                    const tvmazeShow = await resolveTVmazeShow(item, showData, showData.external_ids && showData.external_ids.imdb_id);
                    const broadcastTimingMap = buildBroadcastTimingMap(tvmazeShow);
                    const tvmazeIdChanged = item.tvmazeId !== prevTvmazeId;

                    // BUG FIX (shared logic - see buildEpisodesFromSeasons()):
                    // a season whose fetch still failed even after
                    // fetchTMDBSeason()'s retry falls back to that season's
                    // EXISTING episodes, completely untouched, instead of being
                    // silently dropped. This is the actual cause of a
                    // previously-watched season disappearing on its own: without
                    // the fallback, newEpisodes wholesale-replaces item.episodes
                    // further down as long as ANY season succeeded, so one
                    // transient failure for one season out of several used to be
                    // enough to permanently wipe that season's episodes - watched
                    // history included - with no error shown anywhere.
                    const newEpisodes = buildEpisodesFromSeasons(validSeasons, seasonsData, item.episodes, broadcastTimingMap);

                    // Merge against the existing episode list: keep each episode's
                    // watched flag (and the date it was watched on - see
                    // setEpisodeWatched), but pick up any TMDB/TVmaze edit (renamed
                    // episode, fixed synopsis/still/air date/runtime/release timing).
                    // This runs on every periodic background sync, so skipping the
                    // watchedAt carryover here would quietly erase every
                    // per-episode watch date shortly after it was first set.
                    // Deliberately NOT sending a "new episode" notification from
                    // here - a new entry in TMDB's season data can (and usually
                    // does) mean an episode TMDB knows about well before it's
                    // actually released, not an episode that just dropped. The
                    // server-side push job (see send-release-notifications.js) is
                    // what actually gates real, on-the-day release notifications
                    // now that episodes carry a real releaseDate again.
                    let episodesChanged = false;
                    if (item.episodes && item.episodes.length > 0) {
                        const epMap = new Map();
                        item.episodes.forEach(ep => epMap.set(ep.id, ep));

                        newEpisodes.forEach(newEp => {
                            if (epMap.has(newEp.id)) {
                                const existing = epMap.get(newEp.id);
                                newEp.watched = existing.watched;
                                newEp.watchedAt = existing.watchedAt || null;
                                newEp.rewatchCount = existing.rewatchCount || 0;
                                newEp.rewatchedAt = existing.rewatchedAt || null;
                                if (
                                    existing.title !== newEp.title ||
                                    existing.overview !== newEp.overview ||
                                    existing.still !== newEp.still ||
                                    existing.runtime !== newEp.runtime ||
                                    existing.releaseDate !== newEp.releaseDate
                                ) {
                                    episodesChanged = true;
                                }
                            } else {
                                episodesChanged = true;
                            }
                        });

                        if (newEpisodes.length !== item.episodes.length) episodesChanged = true;
                    } else if (newEpisodes.length > 0) {
                        episodesChanged = true;
                    }

                    // Show-level metadata — refreshed the same way movies are above,
                    // plus TV-specific fields (status, season/episode counts, next air date).
                    const newTitle = showData.name || item.title;
                    const newYear = showData.first_air_date ? showData.first_air_date.substring(0, 4) : item.year;
                    // Same custom-image guard as the movie branch above.
                    const newPoster = item.customPoster ? item.poster : (showData.poster_path ? `https://image.tmdb.org/t/p/w500${showData.poster_path}` : item.poster);
                    const newBackdrop = item.customBackdrop ? item.backdrop : (showData.backdrop_path ? `https://image.tmdb.org/t/p/w780${showData.backdrop_path}` : item.backdrop);
                    const newDescription = showData.overview || item.description;
                    const newReleaseDate = showData.first_air_date ? tmdbDateToISO(showData.first_air_date) : item.releaseDate;
                    const newStatus = showData.status || item.status || '';
                    const newRating = (typeof showData.vote_average === 'number' && showData.vote_average > 0)
                        ? showData.vote_average.toFixed(1)
                        : (item.rating || '');
                    const newSeasonCount = (typeof showData.number_of_seasons === 'number') ? showData.number_of_seasons : item.numberOfSeasons;
                    const newEpisodeCount = (typeof showData.number_of_episodes === 'number') ? showData.number_of_episodes : item.numberOfEpisodes;

                    const metadataChanged = (
                        item.title !== newTitle ||
                        item.year !== newYear ||
                        item.poster !== newPoster ||
                        item.backdrop !== newBackdrop ||
                        item.description !== newDescription ||
                        item.releaseDate !== newReleaseDate ||
                        item.status !== newStatus ||
                        item.rating !== newRating ||
                        item.numberOfSeasons !== newSeasonCount ||
                        item.numberOfEpisodes !== newEpisodeCount
                    );

                    if (episodesChanged || metadataChanged || tvmazeIdChanged) {
                        if (newEpisodes.length > 0) item.episodes = newEpisodes;
                        item.title = newTitle;
                        item.year = newYear;
                        item.poster = newPoster;
                        item.backdrop = newBackdrop;
                        item.description = newDescription;
                        item.releaseDate = newReleaseDate;
                        item.status = newStatus;
                        item.rating = newRating;
                        item.numberOfSeasons = newSeasonCount;
                        item.numberOfEpisodes = newEpisodeCount;
                        // item.tvmazeId was already set in place by resolveTVmazeShow().

                        await saveItem(item);
                        changed = true;
                    }
                }
            } catch (err) {
                console.error(`Failed to check updates for item ${item.title}:`, err);
                failed = true;
            }

            try {
                const availability = await fetchWatchAvailability(item.tmdbId, item.type);
                const providersChanged = JSON.stringify(item.watchProviders || []) !== JSON.stringify(availability.providers);
                const cinemaChanged = !!item.inCinemas !== !!availability.inCinemas;
                const linkChanged = (item.watchLink || '') !== (availability.link || '');
                const ratingChanged = (item.contentRating || '') !== (availability.contentRating || '');

                if (providersChanged || cinemaChanged || linkChanged || ratingChanged) {
                    item.watchProviders = availability.providers;
                    item.inCinemas = availability.inCinemas;
                    item.watchLink = availability.link;
                    item.contentRating = availability.contentRating;
                    await saveItem(item);
                    changed = true;
                }
            } catch (availErr) {
                console.error(`Failed to refresh availability for ${item.title}:`, availErr);
            }

    return { changed, failed };
}

/* =========================================================
   WATCH ON (STREAMING AVAILABILITY & CINEMA STATUS)

   Where-to-watch data is region-specific - the same title can have a
   completely different set of providers (or none at all) depending on
   the country TMDB/JustWatch are asked about. This used to be a single
   hardcoded priority list (ZA, then US, then GB) applied to every user
   regardless of where they actually are, which meant anyone outside
   those three countries could silently see another country's catalog.

   That priority-list approach had a second, worse problem even after
   being made per-user: when TMDB has no data at all for someone's own
   region, falling through to the next region in the list doesn't mean
   "no info" - it means showing that OTHER country's providers (or, for
   cinema release dates, literally whichever country happened to be
   first in TMDB's response) as if it were the user's own. That's
   exactly the bug reported: streaming services that aren't actually
   available in the person's own country. getUserRegion() below is
   deliberately a single lookup, not a priority chain - if there's
   nothing for the user's own region, the honest result is nothing
   shown, not another country's answer.

   Each signed-in user has their own state.region (an ISO 3166-1
   country code), auto-detected once - via the browser's real
   Geolocation API when available/granted, reverse-geocoded to a
   country through a free client-side lookup, falling back to a
   locale-string guess when geolocation isn't available, is denied, or
   the reverse-geocode lookup fails for any reason - and editable any
   time from the "Streaming region" control on Home. See
   detectDefaultRegion(), selectRegion(), and the region-detection
   calls inside proceedToApp().
========================================================= */

// The full ISO 3166-1 list of populated countries/territories (sovereign
// states plus commonly-recognized territories with their own streaming
// catalogs, e.g. Hong Kong, Puerto Rico, Taiwan) - not everyone here will
// have TMDB/JustWatch provider data for every title, but that's now
// handled honestly: getUserRegion() only ever shows a region's own real
// data or nothing at all, never another country's data standing in for it
// (see the comment block above), so there's no harm in listing a region
// even where coverage is thin.
const SUPPORTED_REGIONS = [
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AS', 'AT', 'AU',
    'AW', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BM',
    'BN', 'BO', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG',
    'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CY',
    'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'ER', 'ES',
    'ET', 'FI', 'FJ', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG',
    'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GT', 'GU', 'GW', 'GY',
    'HK', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IQ', 'IR',
    'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
    'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS',
    'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
    'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW',
    'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
    'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
    'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA',
    'SB', 'SC', 'SD', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR',
    'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TG', 'TH', 'TJ', 'TL',
    'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY',
    'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WS', 'XK', 'YE', 'YT',
    'ZA', 'ZM', 'ZW'
];

const REGION_NAMES = {
    AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan',
    AG: 'Antigua and Barbuda', AI: 'Anguilla', AL: 'Albania', AM: 'Armenia',
    AO: 'Angola', AR: 'Argentina', AS: 'American Samoa', AT: 'Austria',
    AU: 'Australia', AW: 'Aruba', AZ: 'Azerbaijan',
    BA: 'Bosnia and Herzegovina', BB: 'Barbados', BD: 'Bangladesh',
    BE: 'Belgium', BF: 'Burkina Faso', BG: 'Bulgaria', BH: 'Bahrain',
    BI: 'Burundi', BJ: 'Benin', BM: 'Bermuda', BN: 'Brunei', BO: 'Bolivia',
    BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan', BW: 'Botswana', BY: 'Belarus',
    BZ: 'Belize', CA: 'Canada', CD: 'DR Congo',
    CF: 'Central African Republic', CG: 'Congo', CH: 'Switzerland',
    CI: 'Ivory Coast', CK: 'Cook Islands', CL: 'Chile', CM: 'Cameroon',
    CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba',
    CV: 'Cape Verde', CW: 'Curacao', CY: 'Cyprus', CZ: 'Czech Republic',
    DE: 'Germany', DJ: 'Djibouti', DK: 'Denmark', DM: 'Dominica',
    DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador', EE: 'Estonia',
    EG: 'Egypt', ER: 'Eritrea', ES: 'Spain', ET: 'Ethiopia', FI: 'Finland',
    FJ: 'Fiji', FM: 'Micronesia', FO: 'Faroe Islands', FR: 'France',
    GA: 'Gabon', GB: 'United Kingdom', GD: 'Grenada', GE: 'Georgia',
    GF: 'French Guiana', GG: 'Guernsey', GH: 'Ghana', GI: 'Gibraltar',
    GL: 'Greenland', GM: 'Gambia', GN: 'Guinea', GP: 'Guadeloupe',
    GQ: 'Equatorial Guinea', GR: 'Greece', GT: 'Guatemala', GU: 'Guam',
    GW: 'Guinea-Bissau', GY: 'Guyana', HK: 'Hong Kong', HN: 'Honduras',
    HR: 'Croatia', HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia',
    IE: 'Ireland', IL: 'Israel', IM: 'Isle of Man', IN: 'India', IQ: 'Iraq',
    IR: 'Iran', IS: 'Iceland', IT: 'Italy', JE: 'Jersey', JM: 'Jamaica',
    JO: 'Jordan', JP: 'Japan', KE: 'Kenya', KG: 'Kyrgyzstan', KH: 'Cambodia',
    KI: 'Kiribati', KM: 'Comoros', KN: 'Saint Kitts and Nevis',
    KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait', KY: 'Cayman Islands',
    KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon', LC: 'Saint Lucia',
    LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia', LS: 'Lesotho',
    LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya',
    MA: 'Morocco', MC: 'Monaco', MD: 'Moldova', ME: 'Montenegro',
    MF: 'Saint Martin', MG: 'Madagascar', MH: 'Marshall Islands',
    MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia',
    MO: 'Macau', MP: 'Northern Mariana Islands', MQ: 'Martinique',
    MR: 'Mauritania', MS: 'Montserrat', MT: 'Malta', MU: 'Mauritius',
    MV: 'Maldives', MW: 'Malawi', MX: 'Mexico', MY: 'Malaysia',
    MZ: 'Mozambique', NA: 'Namibia', NC: 'New Caledonia', NE: 'Niger',
    NF: 'Norfolk Island', NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands',
    NO: 'Norway', NP: 'Nepal', NR: 'Nauru', NU: 'Niue', NZ: 'New Zealand',
    OM: 'Oman', PA: 'Panama', PE: 'Peru', PF: 'French Polynesia',
    PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland',
    PM: 'Saint Pierre and Miquelon', PR: 'Puerto Rico', PS: 'Palestine',
    PT: 'Portugal', PW: 'Palau', PY: 'Paraguay', QA: 'Qatar', RE: 'Reunion',
    RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda',
    SA: 'Saudi Arabia', SB: 'Solomon Islands', SC: 'Seychelles', SD: 'Sudan',
    SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia',
    SL: 'Sierra Leone', SM: 'San Marino', SN: 'Senegal', SO: 'Somalia',
    SR: 'Suriname', SS: 'South Sudan', ST: 'Sao Tome and Principe',
    SV: 'El Salvador', SX: 'Sint Maarten', SY: 'Syria', SZ: 'Eswatini',
    TC: 'Turks and Caicos Islands', TD: 'Chad', TG: 'Togo', TH: 'Thailand',
    TJ: 'Tajikistan', TL: 'Timor-Leste', TM: 'Turkmenistan', TN: 'Tunisia',
    TO: 'Tonga', TR: 'Turkey', TT: 'Trinidad and Tobago', TV: 'Tuvalu',
    TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda',
    US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VA: 'Vatican City',
    VC: 'Saint Vincent and the Grenadines', VE: 'Venezuela',
    VG: 'British Virgin Islands', VI: 'U.S. Virgin Islands', VN: 'Vietnam',
    VU: 'Vanuatu', WS: 'Samoa', XK: 'Kosovo', YE: 'Yemen', YT: 'Mayotte',
    ZA: 'South Africa', ZM: 'Zambia', ZW: 'Zimbabwe'
};

// Ultimate fallback when the browser's locale can't be read at all (very
// old/locked-down browsers) rather than a completely unlocalized default.
const FALLBACK_REGION = 'ZA';

// Best-effort guess from the browser's own locale (e.g. "en-ZA" -> "ZA").
// This is the FALLBACK path now (see detectDefaultRegion below) - only
// reached when real device geolocation isn't available, was denied, or
// its reverse-geocode lookup failed. Still only ever a starting point -
// it can easily be wrong (a device left on "en-US" while physically in
// another country is common) - which is exactly why the result is
// stored as an editable, persisted preference rather than re-detected
// and silently overridden every session.
function detectDefaultRegionFromLocale() {
    try {
        const locales = (navigator.languages && navigator.languages.length)
            ? navigator.languages
            : [navigator.language].filter(Boolean);

        for (const locale of locales) {
            const parts = String(locale).split('-');
            if (parts.length > 1) {
                const region = parts[1].toUpperCase();
                if (SUPPORTED_REGIONS.includes(region)) return region;
            }
        }
    } catch (e) {
        // Ignore - fall through to the static default below.
    }
    return FALLBACK_REGION;
}

// The real, device-location-based detection path. Uses the browser's own
// Geolocation API (a permission prompt, same as any site asking for
// location) rather than just guessing from locale - genuinely knows
// where the device physically is rather than what language it's set to,
// which is exactly the case (a device left on the wrong locale) the
// locale guess above couldn't handle. Country-level accuracy is all
// that's needed here, so a coarse/network-based fix is fine - no reason
// to request high-accuracy GPS for this.
//
// Reverse-geocoded to a country via BigDataCloud's free client-side
// reverse-geocode endpoint (no API key, designed for exactly this
// client-only "coordinates -> country" use case). Every failure mode -
// no Geolocation API support, the person denies the permission prompt,
// a timeout, the reverse-geocode call itself failing, or the returned
// country not being one NovaWatch's region list supports - falls back
// to the locale guess rather than ever blocking sign-in on this.
function detectDefaultRegionViaGeolocation() {
    return new Promise((resolve) => {
        if (!("geolocation" in navigator)) {
            resolve(detectDefaultRegionFromLocale());
            return;
        }

        navigator.geolocation.getCurrentPosition(
            async (position) => {
                try {
                    const { latitude, longitude } = position.coords;
                    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
                    const data = await res.json();
                    const code = data && data.countryCode ? String(data.countryCode).toUpperCase() : null;
                    resolve((code && SUPPORTED_REGIONS.includes(code)) ? code : detectDefaultRegionFromLocale());
                } catch (e) {
                    resolve(detectDefaultRegionFromLocale());
                }
            },
            () => {
                // Permission denied, position unavailable, or timed out -
                // never block sign-in on this, just fall back.
                resolve(detectDefaultRegionFromLocale());
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 3600000 }
        );
    });
}

// The single entry point every call site uses - tries real device
// geolocation first, falls back to the locale guess for anything that
// doesn't pan out. Async because the geolocation path is (the prompt
// and reverse-geocode lookup both take a moment); every call site is
// already inside an async context, so this is just one more `await`.
async function detectDefaultRegion() {
    return await detectDefaultRegionViaGeolocation();
}

// The single region every TMDB "watch/providers" and cinema-release lookup
// uses. Deliberately not a priority list - see the comment block above for
// why falling back to a different country's data was the actual bug.
function getUserRegion() {
    return (state.region || FALLBACK_REGION).toUpperCase();
}

// Builds the picker's row list once on DOMContentLoaded, same as the poster
// picker's grid - the option set itself never changes per-session, only
// which row is marked .selected (see syncRegionUI).
function populateRegionOptions() {
    const list = document.getElementById("regionOptionsList");
    if (!list) return;

    const sortedCodes = [...SUPPORTED_REGIONS].sort((a, b) =>
        REGION_NAMES[a].localeCompare(REGION_NAMES[b])
    );

    list.innerHTML = sortedCodes.map(code => `
        <div class="region-option-row" data-region-code="${code}" data-region-name="${REGION_NAMES[code]}" onclick="selectRegion('${code}')">
            <span>${REGION_NAMES[code]}</span>
            <svg class="icon icon-small region-option-check" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>
        </div>
    `).join('');
}

// All 231 rows already exist in the DOM from populateRegionOptions - typing
// a query just toggles which are visible rather than re-rendering the list.
function filterRegionOptions(query) {
    const normalized = query.trim().toLowerCase();
    document.querySelectorAll("#regionOptionsList .region-option-row").forEach(row => {
        const name = (row.dataset.regionName || "").toLowerCase();
        row.style.display = name.includes(normalized) ? "" : "none";
    });
}

// Keeps the pill button's label and the picker's checkmark in sync with
// state.region - called once proceedToApp() has resolved a value (detected,
// loaded, or defaulted).
function syncRegionUI() {
    if (!state.region) return;

    const pillBtn = document.getElementById("regionPillBtn");
    if (pillBtn) pillBtn.textContent = REGION_NAMES[state.region] || state.region;

    document.querySelectorAll("#regionOptionsList .region-option-row").forEach(row => {
        row.classList.toggle("selected", row.dataset.regionCode === state.region);
    });
}

function openRegionPicker() {
    // Always open to the full, unfiltered list rather than wherever a
    // previous search was left - avoids "why can't I see all countries"
    // confusion from a forgotten filter.
    const modal = document.getElementById("regionPickerModal");
    const searchInput = document.getElementById("regionSearchInput");
    if (searchInput) {
        searchInput.value = "";
        searchInput.parentElement.classList.remove("has-text");
    }
    filterRegionOptions("");
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    lockBodyScroll("regionPickerModal");
}

function closeRegionPicker() {
    document.getElementById("regionPickerModal").classList.remove("open");
    unlockBodyScroll("regionPickerModal");
}

function closeRegionPickerOutside(event) {
    if (event.target.id === "regionPickerModal") closeRegionPicker();
}

// Fired by tapping a row in the picker. A manual choice always wins over
// auto-detection from here on for this account.
async function selectRegion(newRegion) {
    if (!SUPPORTED_REGIONS.includes(newRegion)) return;
    const previousRegion = state.region;
    state.region = newRegion;
    syncRegionUI();
    closeRegionPicker();

    const saved = await saveUserProfile();
    if (!saved) {
        // Roll back so the UI doesn't keep showing a region that never
        // actually made it to Firestore - it'd revert on the next reload
        // anyway, so better to be upfront about it now.
        state.region = previousRegion;
        syncRegionUI();
        showErrorToast("Couldn't save region - check your connection and try again.");
        return;
    }

    showToast(`Streaming region set to ${REGION_NAMES[newRegion]}.`, "success");
    // Deliberately not force-refreshing every library item's stored watch
    // providers here - that's a TMDB call per item, which doesn't scale to
    // a large library. Existing items pick up the new region on their next
    // regular background sync (see checkLibraryForUpdates); new searches
    // and newly-added items use it immediately.
}

// Content rating (PG-13, TV-MA, etc.) is a separate per-region TMDB
// endpoint - not part of the base movie/show detail response, the same
// way watch/providers isn't. Tries the viewer's own region first (same
// getUserRegion() used everywhere else content is region-specific),
// falls back to US since that's the rating convention most universally
// recognized even outside the US, rather than showing nothing at all
// for a region TMDB doesn't have data for.
async function fetchContentRating(tmdbId, mediaType) {
    try {
        if (mediaType === 'movie') {
            const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?api_key=${TMDB_API_KEY}`);
            const data = await res.json();
            const entries = data.results || [];
            const regionEntry = entries.find(e => e.iso_3166_1 === getUserRegion()) || entries.find(e => e.iso_3166_1 === 'US') || null;
            const dates = regionEntry ? (regionEntry.release_dates || []) : [];
            const withCert = dates.find(d => d.certification && d.certification.trim() !== '');
            return withCert ? withCert.certification : '';
        } else {
            const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/content_ratings?api_key=${TMDB_API_KEY}`);
            const data = await res.json();
            const entries = data.results || [];
            const regionEntry = entries.find(e => e.iso_3166_1 === getUserRegion()) || entries.find(e => e.iso_3166_1 === 'US') || null;
            return (regionEntry && regionEntry.rating) ? regionEntry.rating : '';
        }
    } catch (err) {
        console.error('Error fetching content rating:', err);
        return '';
    }
}

async function fetchWatchAvailability(tmdbId, type) {
    const availability = { providers: [], inCinemas: false, link: '', contentRating: '' };
    if (!tmdbId) return availability;

    const mediaType = type === 'movie' ? 'movie' : 'tv';

    try {
        // Content rating fetched alongside (not after) the providers
        // request, so it doesn't add its own sequential delay on top of
        // an already-network-bound function.
        const [res, contentRating] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`),
            fetchContentRating(tmdbId, mediaType)
        ]);
        availability.contentRating = contentRating;
        const data = await res.json();
        if (!res.ok) {
            console.warn(`TMDB watch/providers request failed (${res.status}):`, data?.status_message || data);
        }
        const byRegion = data.results || {};

        // Only the user's own region - see the comment block above
        // getUserRegion() for why substituting a different country's data
        // here was the actual bug being fixed.
        const regionData = byRegion[getUserRegion()] || null;

        let hasDigitalAvailability = false;

        if (regionData) {
            availability.link = regionData.link || '';

            const streaming = [
                ...(regionData.flatrate || []),
                ...(regionData.free || []),
                ...(regionData.ads || [])
            ];
            const rentBuy = [...(regionData.rent || []), ...(regionData.buy || [])];
            hasDigitalAvailability = streaming.length > 0 || rentBuy.length > 0;

            // Prefer subscription/free sources for the main chips; fall back to rent/buy
            const source = streaming.length > 0 ? streaming : rentBuy;
            const seen = new Set();

            availability.providers = source
                .filter(p => {
                    if (seen.has(p.provider_id)) return false;
                    seen.add(p.provider_id);
                    return true;
                })
                .sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))
                .map(p => ({
                    id: p.provider_id,
                    name: p.provider_name,
                    logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : ''
                }));
        }

        if (mediaType === 'movie') {
            availability.inCinemas = await checkNowInCinemas(tmdbId, hasDigitalAvailability);
        }
    } catch (err) {
        console.error('Error fetching watch availability:', err);
    }

    return availability;
}

async function checkNowInCinemas(tmdbId, hasDigitalAvailability) {
    // If it's already available digitally (streaming/rent/buy), don't call it "in cinemas" anymore.
    if (hasDigitalAvailability) return false;

    try {
        const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?api_key=${TMDB_API_KEY}`);
        const data = await res.json();
        if (!res.ok) {
            console.warn(`TMDB release_dates request failed (${res.status}):`, data?.status_message || data);
        }
        const entries = data.results || [];

        // Only the user's own region - the old entries[0] fallback meant
        // "in cinemas" could be based on literally whichever country
        // happened to be first in TMDB's response, unrelated to the user.
        const regionEntry = entries.find(e => e.iso_3166_1 === getUserRegion()) || null;
        const dates = regionEntry ? regionEntry.release_dates : [];
        const nowTime = now().getTime();

        // TMDB release_dates "type": 1 Premiere, 2 Theatrical (limited), 3 Theatrical, 4 Digital, 5 Physical, 6 TV
        const hasTheatrical = dates.some(d => (d.type === 2 || d.type === 3) && new Date(d.release_date).getTime() <= nowTime);
        const hasDigitalRelease = dates.some(d => d.type === 4 && new Date(d.release_date).getTime() <= nowTime);

        return hasTheatrical && !hasDigitalRelease;
    } catch (err) {
        console.error('Error checking cinema release status:', err);
        return false;
    }
}

function renderWatchOnSection(item) {
    const section = document.getElementById("modalWatchOn");
    const providersContainer = document.getElementById("modalWatchProviders");
    const attribution = document.getElementById("modalWatchAttribution");
    if (!section || !providersContainer || !attribution) return;

    if (!item) {
        section.style.display = "none";
        return;
    }

    const providers = item.watchProviders || [];
    const inCinemas = !!item.inCinemas;

    if (providers.length === 0 && !inCinemas) {
        section.style.display = "none";
        providersContainer.innerHTML = "";
        attribution.style.display = "none";
        return;
    }

    let chipsHTML = "";

    if (inCinemas) {
        chipsHTML += `
            <div class="watch-provider-chip cinema-chip" title="Now in Cinemas">
                <div class="watch-provider-logo cinema-icon">
                    <svg class="icon icon-small" viewBox="0 0 24 24">
                        <path d="M3 8.5V19a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8.5H3z"/>
                        <path d="M3 8.5l1.5-4.5h3l-1 4.5"/>
                        <path d="M9.5 8.5l1-4.5h3l-1 4.5"/>
                        <path d="M16 8.5l1-4.5h3l1 4.5"/>
                    </svg>
                </div>
                <span class="watch-provider-name">Now in Cinemas</span>
            </div>
        `;
    }

    providers.forEach(p => {
        chipsHTML += `
            <div class="watch-provider-chip" title="${escapeHTML(p.name)}">
                ${p.logo
                    ? `<img class="watch-provider-logo" src="${p.logo}" alt="${escapeHTML(p.name)}" loading="lazy" decoding="async">`
                    : `<div class="watch-provider-logo watch-provider-fallback">${escapeHTML((p.name || '?').charAt(0))}</div>`
                }
                <span class="watch-provider-name">${escapeHTML(p.name)}</span>
            </div>
        `;
    });

    providersContainer.innerHTML = chipsHTML;
    section.style.display = "block";

    if (providers.length > 0) {
        attribution.style.display = "inline-block";
        if (item.watchLink) {
            attribution.href = item.watchLink;
            attribution.style.pointerEvents = "auto";
        } else {
            attribution.removeAttribute("href");
            attribution.style.pointerEvents = "none";
        }
    } else {
        attribution.style.display = "none";
    }
}

async function loadWatchAvailability(item) {
    if (!item || !item.tmdbId) return;

    const availability = await fetchWatchAvailability(item.tmdbId, item.type);
    item.watchProviders = availability.providers;
    item.inCinemas = availability.inCinemas;
    item.watchLink = availability.link;
    item.contentRating = availability.contentRating;

    // Only re-render if the modal is still showing this same item
    if (currentItem === item) {
        renderWatchOnSection(item);
        // Content rating lives in the modal's metadata line, not the
        // watch-on section renderWatchOnSection() covers - re-running the
        // full render is what actually surfaces it once it's arrived,
        // same "fill in behind the already-open modal" pattern episodes
        // already use.
        updateModalContent();
    }
}

// Defensive cleanup for a couple of data-integrity issues that leave
// broken-looking entries in the library:
//   1. A "preview" item (opened via search or a shared link, before ever
//      being added) that ended up persisted as its own doc alongside the
//      real entry - a duplicate, since it shares the same tmdbId as the
//      real item but a different doc id ("preview-tv-123" vs "tv-some-show").
//   2. A stub document missing fields the app's own add flow always fills
//      in (type, description, an episodes array for TV) - these render as
//      the generic placeholder icon and, when type is missing, even get
//      miscategorized into the wrong (TV vs Movie) library section. The
//      current add flow never produces a doc shaped like this, so seeing
//      one is a reliable sign it's leftover junk, never a real add.
// Both categories get stripped from what's shown and permanently deleted
// from Firestore so they don't keep coming back on future loads.
function dedupeAndCleanLibrary(rawLibrary, uid) {
    const seen = new Set();
    const cleaned = [];
    const staleIds = [];

    rawLibrary.forEach(item => {
        if (!item || !item.id) return;

        if (item.isPreview || item.id.startsWith('preview-')) {
            staleIds.push(item.id);
            return;
        }

        const isBrokenStub = !item.type
            || item.title === undefined
            || item.description === undefined
            || (item.type !== 'movie' && item.episodes === undefined)
            // Same idea, but for a doc that has these fields present, just
            // left empty rather than missing outright - no poster, no
            // season/episode data, and (for TV) no episodes at all. A show
            // genuinely still tracked by TMDB always has at least season
            // counts even before it premieres, so an entry with none of
            // that is stale junk, not a real "hasn't aired yet" title.
            || (item.type !== 'movie' && Array.isArray(item.episodes) && item.episodes.length === 0 && !item.numberOfSeasons && !item.poster)
            || (item.type === 'movie' && !item.poster && !item.backdrop && !item.runtime);

        if (isBrokenStub) {
            staleIds.push(item.id);
            return;
        }

        const key = `${item.type}-${item.tmdbId}`;
        if (item.tmdbId && seen.has(key)) {
            staleIds.push(item.id);
            return;
        }

        if (item.tmdbId) seen.add(key);
        cleaned.push(item);
    });

    // The Firestore cleanup below is a nice-to-have side effect, never part
    // of the critical path - anything that goes wrong here (a malformed
    // legacy doc id Firestore's .doc() rejects, a permission error, etc.)
    // must never stop the library itself from loading, so it's fully
    // isolated in its own try/catch rather than letting an exception
    // escape into the caller.
    try {
        // .doc() throws synchronously for ids that aren't valid single path
        // segments (empty, containing "/", etc.) - skip anything that could
        // trip that rather than letting one bad legacy id abort the batch.
        const deletableIds = staleIds.filter(id => typeof id === 'string' && id.length > 0 && !id.includes('/'));

        if (deletableIds.length > 0 && uid && db) {
            const batch = db.batch();
            deletableIds.forEach(id => {
                batch.delete(db.collection("users").doc(uid).collection("library").doc(id));
            });
            batch.commit().catch(err => console.error("Failed to clean up stale library entries:", err));
        }
    } catch (err) {
        console.error("Skipped stale library cleanup due to an error:", err);
    }

    return cleaned;
}

if (auth) {
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        const authScreen = document.getElementById("authScreen");
        const mainApp = document.querySelector(".app");

        if (user) {
            // Password accounts must confirm their email before the app
            // opens at all - verification happens as part of account
            // creation itself, not as a banner discovered later once
            // already inside. Google sign-in accounts are pre-verified
            // by Google, so they skip straight through.
            const isPasswordAccount = user.providerData.some(p => p.providerId === 'password');
            if (isPasswordAccount && !user.emailVerified) {
                showVerifyScreen(user);
                return;
            }

            hideVerifyScreen();
            oneSignalLogin(user.uid);
            await proceedToApp(user, authScreen, mainApp);
        } else {
            hideVerifyScreen();
            hideChooseUsernameScreen();
            oneSignalLogout();
            // A shared/public device shouldn't show whoever was signed in
            // before flashing briefly on the next person's first paint -
            // see restoreCachedIdentitySnapshot(), which is exactly what
            // this cache exists to feed.
            clearCachedIdentitySnapshot();

            // User is logged out: Show Auth Screen, Hide Main App
            authScreen.style.display = "flex";
            mainApp.style.display = "none";

            // Clear local state
            state.library = [];
            state.lists = [];
            libraryLoaded = false;
            document.getElementById("homeName").textContent = "Guest";
            const homeEmailSubtitleEl = document.getElementById("homeEmailSubtitle");
            if (homeEmailSubtitleEl) {
                homeEmailSubtitleEl.style.display = "";
                homeEmailSubtitleEl.textContent = "Please sign in";
            }
            const settingsNameEl = document.getElementById("settingsName");
            if (settingsNameEl) settingsNameEl.textContent = "Guest";
            const settingsEmailSubtitleEl = document.getElementById("settingsEmailSubtitle");
            if (settingsEmailSubtitleEl) {
                settingsEmailSubtitleEl.style.display = "";
                settingsEmailSubtitleEl.textContent = "Please sign in";
            }
        }
    });
}

// Everything involved in actually entering the app once a user is signed
// in AND verified (or on a provider that never needed verification) -
// factored out so both the normal auth listener above and a successful
// in-app verification check (checkVerificationStatus) land in the same
// place instead of duplicating this logic.
async function proceedToApp(user, authScreen, mainApp) {
            // Hide Auth Screen, Show Main App
            authScreen.style.display = "none";
            mainApp.style.display = "block";

            // Set UI Profile Details
            const displayName = user.displayName || user.email.split('@')[0];
            const initial = displayName.charAt(0).toUpperCase();
            
            document.getElementById("homeName").textContent = displayName;
            // Previously showed the raw account email here as a subtitle under
            // the username - hidden now so the email itself is never on
            // screen, only the username above it.
            const homeEmailSubtitleEl = document.getElementById("homeEmailSubtitle");
            if (homeEmailSubtitleEl) homeEmailSubtitleEl.style.display = "none";
            
            const largeAvatar = document.getElementById("largeAvatar");
            renderAvatarInto(largeAvatar, initial);

            const settingsNameEl = document.getElementById("settingsName");
            if (settingsNameEl) settingsNameEl.textContent = displayName;
            const settingsEmailSubtitleEl = document.getElementById("settingsEmailSubtitle");
            if (settingsEmailSubtitleEl) settingsEmailSubtitleEl.style.display = "none";
            const settingsAvatarEl = document.getElementById("settingsAvatar");
            renderAvatarInto(settingsAvatarEl, initial);

            // Always land on Home on load/refresh, regardless of whichever
            // tab the user was last on.
            libraryLoaded = false;
            showPage('home');
            updateNavIndicator(false);

            // Handle a shared show/movie link immediately, in parallel with
            // the personal library load below rather than after it - a
            // shared link only needs its own TMDB fetch to open, so there's
            // no reason to make the recipient wait on their whole library
            // syncing first (which can be the slower of the two).
            const openedSharedItem = openSharedItemFromURL();
            if (!openedSharedItem) openShortcutTabFromURL();

            try {
                // The profile doc and the library collection are independent
                // reads - fetching them in parallel rather than one after
                // the other roughly halves the wait before Home has real
                // data to show, instead of paying for two round trips
                // back to back.
                const profilePromise = (async () => {
                    const userDoc = await db.collection("users").doc(user.uid).get();
                    if (userDoc.exists) {
                        const userData = userDoc.data();
                        if (userData) {
                            state = { ...state, ...userData };
                        }
                        // Existing account from before the region field
                        // existed - detect once now and persist it, rather
                        // than falling back to the default priority list on
                        // every single lookup for the rest of this account's
                        // life.
                        if (!state.region) {
                            state.region = await detectDefaultRegion();
                            await saveUserProfile();
                        }
                    } else {
                        if (user.displayName && state.profiles && state.profiles[0]) {
                            state.profiles[0].name = user.displayName;
                            state.profiles[0].initials = initial;
                        }
                        // Same missing-avatarId gap as the email/password
                        // signup path (see handleSignUp) - without this, a
                        // first-time Google sign-in kept the guest default's
                        // null avatarId forever, falling back to initials
                        // instead of one of the 8 curated avatars.
                        if (state.profiles && state.profiles[0] && !state.profiles[0].avatarId) {
                            state.profiles[0].avatarId = randomAvatarId();
                        }
                        state.region = await detectDefaultRegion();
                        await saveUserProfile();
                    }
                    syncRegionUI();

                    // Every account needs a reserved, unique username.
                    // Google sign-in never asks for one up front (that
                    // only happens in the Join form's own username
                    // field), and accounts created before this was
                    // required won't have one on file either - gate on
                    // it here rather than silently keeping whatever
                    // display name Google/Firebase happened to supply.
                    if (!state.username) {
                        showChooseUsernameScreen(user);
                    }
                })();

                const libraryPromise = (async () => {
                    // Fetch Personal Library with error handling
                    let cloudLibrary = [];
                    try {
                        const librarySnapshot = await db.collection("users")
                            .doc(user.uid)
                            .collection("library")
                            .get();

                        librarySnapshot.forEach(doc => {
                            if (doc.exists) cloudLibrary.push(doc.data());
                        });
                    } catch (fetchErr) {
                        console.warn("Could not fetch library from server, trying cache:", fetchErr);
                        // Attempt to fetch from local firestore cache if offline
                        try {
                            const cachedSnapshot = await db.collection("users")
                                .doc(user.uid)
                                .collection("library")
                                .get({ source: 'cache' });
                            cachedSnapshot.forEach(doc => {
                                if (doc.exists) cloudLibrary.push(doc.data());
                            });
                        } catch (cacheErr) {
                            console.error("Cache fetch also failed:", cacheErr);
                        }
                    }
                    return cloudLibrary;
                })();

                const [, cloudLibrary] = await Promise.all([profilePromise, libraryPromise]);

                let dedupedLibrary = cloudLibrary;
                try {
                    dedupedLibrary = dedupeAndCleanLibrary(cloudLibrary, user.uid);
                } catch (dedupeErr) {
                    console.error("Library dedupe/cleanup failed, using library as-is:", dedupeErr);
                }
                state.library = dedupedLibrary;
               
                if (!state.profiles || state.profiles.length === 0) {
                    state.profiles = [{ id: "profile-main", name: displayName, initials: initial, avatarId: randomAvatarId() }];
                    saveUserProfile();
                }
                
                libraryLoaded = true;
                refreshActivePage();

                // If this session was opened via a shared show/movie link,
                // it was already handled above, in parallel with this fetch -
                // skip the generic welcome toast so it doesn't talk over it.
                if (!openedSharedItem) {
                    showToast("Welcome back!", "success");
                }

                // Trigger Background Updates & Notifications
                await checkLibraryForUpdates();

                // Listen for real-time changes
                db.collection("users")
                    .doc(user.uid)
                    .collection("library")
                    .onSnapshot((snapshot) => {
                        let updatedLibrary = [...state.library];

                        snapshot.docChanges().forEach((change) => {
                            const itemData = change.doc.data();
                            if (!itemData || !itemData.id) return;

                            // Never let a stray "preview" doc, or a broken
                            // stub missing fields the real add flow always
                            // sets, back into the live library - see
                            // dedupeAndCleanLibrary above.
                            const isBrokenStub = !itemData.type
                                || itemData.title === undefined
                                || itemData.description === undefined
                                || (itemData.type !== 'movie' && itemData.episodes === undefined)
                                || (itemData.type !== 'movie' && Array.isArray(itemData.episodes) && itemData.episodes.length === 0 && !itemData.numberOfSeasons && !itemData.poster)
                                || (itemData.type === 'movie' && !itemData.poster && !itemData.backdrop && !itemData.runtime);
                            if (itemData.isPreview || itemData.id.startsWith('preview-') || isBrokenStub) return;

                            const index = updatedLibrary.findIndex(i => i.id === itemData.id);

                            if (change.type === "added" || change.type === "modified") {
                                if (index !== -1) updatedLibrary[index] = itemData;
                                else updatedLibrary.push(itemData);
                            } else if (change.type === "removed") {
                                if (index !== -1) updatedLibrary.splice(index, 1);
                            }
                        });

                        state.library = updatedLibrary;
                        refreshActivePage();
                    });

                // Lists get their own, simpler listener - no dedup/cleanup
                // needed the way library items do (a list is just a name
                // and an array of ids, not a rich document that can end
                // up a broken partial stub), so this is a plain mirror of
                // the collection into state.lists.
                db.collection("users")
                    .doc(user.uid)
                    .collection("lists")
                    .onSnapshot((snapshot) => {
                        state.lists = snapshot.docs.map(d => d.data());
                        refreshActivePage();
                    });
            } catch (err) {
                console.error("Error fetching cloud data:", err);
                showErrorToast("Library sync failed.");
                // Stop showing the loading skeleton even though the fetch
                // failed - otherwise Home/Library would be stuck looking
                // like they're still loading forever instead of falling
                // back to their normal (if inaccurately "empty") state.
                libraryLoaded = true;
                refreshActivePage();
            }

            // A couple seconds after the app is actually visible, not the
            // instant it loads - competing with everything else settling in
            // (the library fetch above, the initial render) for attention
            // right at the moment someone opens the app is exactly how a
            // prompt like this starts feeling naggy rather than helpful.
            setTimeout(maybeShowAddToHomeScreenPrompt, 2500);
}
/* =========================================================
   TMDB SEARCH & DISCOVER
========================================================= */
function setSearchType(type) {
    currentSearchType = type;
    document.getElementById("searchTypeTV").classList.toggle("active", type === 'tv');
    document.getElementById("searchTypeMovie").classList.toggle("active", type === 'movie');

    const searchInput = document.getElementById("onlineSearchInput");
    const query = searchInput ? searchInput.value.trim() : "";

    if (query) {
        performTMDBSearch(query);
    } else {
        fetchForYou();
    }
}

function initSearchPage() {
    const searchInput = document.getElementById("onlineSearchInput");
    if (!searchInput) return;

    searchInput.addEventListener("input", (e) => {
        clearTimeout(searchDebounceTimer);
        const query = e.target.value.trim();

        if (!query) {
            fetchForYou();
            return;
        }

        searchDebounceTimer = setTimeout(() => {
            performTMDBSearch(query);
        }, 200);
    });

    const tvLibInput = document.getElementById("tvLibrarySearchInput");
    if (tvLibInput) {
        tvLibInput.addEventListener("input", () => {
            debounceLibraryFilter("tvLib", () => renderTVLibrarySection());
        });
    }

    const movieLibInput = document.getElementById("movieLibrarySearchInput");
    if (movieLibInput) {
        movieLibInput.addEventListener("input", () => {
            debounceLibraryFilter("movieLib", () => renderMovieLibrarySection());
        });
    }

    const upcomingTVInput = document.getElementById("upcomingTVSearchInput");
    if (upcomingTVInput) {
        upcomingTVInput.addEventListener("input", () => {
            debounceLibraryFilter("upcomingTV", () => renderUpcomingTVSection());
        });
    }

    const upcomingMovieInput = document.getElementById("upcomingMovieSearchInput");
    if (upcomingMovieInput) {
        upcomingMovieInput.addEventListener("input", () => {
            debounceLibraryFilter("upcomingMovie", () => renderUpcomingMovieSection());
        });
    }

    fetchForYou();
}

// Rebuilding a categorized poster grid on every single keystroke can feel
// janky with a larger library, so local (already-in-memory) filtering gets
// the same lightweight debounce treatment as the network-bound TMDB search.
function debounceLibraryFilter(key, renderFn) {
    clearTimeout(libSearchDebounceTimers[key]);
    libSearchDebounceTimers[key] = setTimeout(renderFn, 120);
}

// Picks the library items most worth seeding recommendations from: highest
// TMDB rating first (a proxy for "titles the person actually likes"), most
// recently added as the tiebreaker. Capped at 5 seeds to keep this to a
// handful of parallel requests rather than one per library item.
function getForYouSeeds(type) {
    return state.library
        .filter(item => item.type === type && item.tmdbId)
        .sort((a, b) => {
            const ratingA = parseFloat(a.rating) || 0;
            const ratingB = parseFloat(b.rating) || 0;
            if (ratingB !== ratingA) return ratingB - ratingA;
            return new Date(b.addedAt || 0) - new Date(a.addedAt || 0);
        })
        .slice(0, 5);
}

async function fetchTrending() {
    const listContainer = document.getElementById("searchResultsList");
    const heading = document.getElementById("searchResultsHeading");

    const mediaLabel = currentSearchType === 'movie' ? 'Movies' : 'TV Shows';
    if (heading) heading.textContent = `Trending ${mediaLabel}`;
    listContainer.innerHTML = skeletonRows();

    const endpoint = currentSearchType === 'movie' 
        ? `https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_API_KEY}`
        : `https://api.themoviedb.org/3/trending/tv/week?api_key=${TMDB_API_KEY}`;

    try {
        const response = await fetch(endpoint);
        const data = await response.json();

        if (!response.ok) {
            console.warn(`TMDB trending request failed (${response.status}):`, data?.status_message || data);
            listContainer.innerHTML = emptyState("Couldn't Load Trending", "There was a problem reaching TMDB. Check your connection and try again.");
            return;
        }

        renderSearchResults(data.results || []);
    } catch (error) {
        console.error("Error fetching trending media:", error);
        listContainer.innerHTML = emptyState("Unable to load trending items", "Please check your network connection.");
    }
}

// Discover's default (no search query) view. Seeds TMDB's per-title
// /recommendations endpoint from a handful of the person's own
// highest-rated/most-recent library items, merges and ranks the results by
// how many seeds recommended them (then by TMDB popularity), and drops
// anything already in the library. Falls back to plain Trending when the
// library has nothing of this type yet to seed from.
async function fetchForYou() {
    const listContainer = document.getElementById("searchResultsList");
    const heading = document.getElementById("searchResultsHeading");
    const mediaLabel = currentSearchType === 'movie' ? 'Movies' : 'TV Shows';

    const seeds = getForYouSeeds(currentSearchType);
    if (seeds.length === 0) {
        return fetchTrending();
    }

    if (heading) heading.textContent = `For You`;
    listContainer.innerHTML = skeletonRows();

    const endpointFor = (tmdbId) => currentSearchType === 'movie'
        ? `https://api.themoviedb.org/3/movie/${tmdbId}/recommendations?api_key=${TMDB_API_KEY}`
        : `https://api.themoviedb.org/3/tv/${tmdbId}/recommendations?api_key=${TMDB_API_KEY}`;

    try {
        const responses = await Promise.all(
            seeds.map(seed =>
                fetch(endpointFor(seed.tmdbId))
                    .then(res => res.ok ? res.json() : { results: [] })
                    .catch(() => ({ results: [] }))
            )
        );

        const libraryTmdbIds = new Set(state.library.map(item => item.tmdbId));
        const scored = new Map();

        for (const data of responses) {
            for (const item of (data.results || [])) {
                if (libraryTmdbIds.has(item.id)) continue;
                if (scored.has(item.id)) {
                    scored.get(item.id).hits += 1;
                } else {
                    scored.set(item.id, { item, hits: 1 });
                }
            }
        }

        const ranked = [...scored.values()]
            .sort((a, b) => {
                if (b.hits !== a.hits) return b.hits - a.hits;
                return (b.item.vote_average || 0) - (a.item.vote_average || 0);
            })
            .map(entry => entry.item)
            .slice(0, 20);

        if (ranked.length === 0) {
            listContainer.innerHTML = emptyState("Nothing New to Suggest Yet", `Add a few more ${mediaLabel.toLowerCase()} you like and check back for personalized picks.`);
            return;
        }

        renderSearchResults(ranked);
    } catch (error) {
        console.error("Error fetching For You recommendations:", error);
        listContainer.innerHTML = emptyState("Unable to Load Recommendations", "Please check your network connection.");
    }
}

async function performTMDBSearch(query) {
    const listContainer = document.getElementById("searchResultsList");
    const heading = document.getElementById("searchResultsHeading");

    if (heading) heading.textContent = `Results for "${query}"`;
    listContainer.innerHTML = skeletonRows();

    const endpoint = currentSearchType === 'movie'
        ? `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
        : `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(endpoint);
        const data = await response.json();

        if (!response.ok) {
            console.warn(`TMDB search request failed (${response.status}):`, data?.status_message || data);
            listContainer.innerHTML = emptyState("Couldn't Load Results", "There was a problem reaching TMDB. Check your connection and try again.");
            return;
        }

        if (!data.results || data.results.length === 0) {
            listContainer.innerHTML = emptyState("No Items Found", `No results matching "${escapeHTML(query)}".`);
            return;
        }

        renderSearchResults(data.results);
    } catch (error) {
        console.error("Error searching TMDB:", error);
        listContainer.innerHTML = emptyState("Search Error", "Couldn't reach TMDB. Check your connection and try again.");
    }
}

function renderSearchResults(results) {
    const listContainer = document.getElementById("searchResultsList");

    if (!results || results.length === 0) {
        listContainer.innerHTML = emptyState("No Items Available");
        return;
    }

    listContainer.innerHTML = results.map(item => {
        const isMovie = currentSearchType === 'movie';
        const title = isMovie ? item.title : item.name;
        const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : '';
        const airDate = isMovie ? item.release_date : item.first_air_date;
        const year = airDate ? airDate.substring(0, 4) : 'N/A';
        
        const slug = isMovie ? `movie-${item.id}` : "tv-" + (item.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const isAdded = state.library.some(s => s.id === slug || s.tmdbId === item.id);

        return `
            <div class="search-card" onclick="openSearchResultDetails(${item.id}, '${currentSearchType}')">
                ${posterUrl ? 
                    `<img src="${posterUrl}" class="search-card-poster" alt="${escapeHTML(title)}" draggable="false" loading="lazy" decoding="async" onerror="this.style.display='none'">` :
                    `<div class="search-card-poster" style="display:flex; align-items:center; justify-content:center; text-align:center; font-size:10px; color:var(--text-muted); padding:5px;">${escapeHTML(title)}</div>`
                }
                <div class="search-card-info">
                    <div class="search-card-title">${escapeHTML(title)}</div>
                    <div class="search-card-meta">
                        <span>${year}</span>
                        <span>•</span>
                        <span style="text-transform:uppercase;">${isMovie ? 'Movie' : 'TV'}</span>
                    </div>
                    <div class="search-card-overview">${escapeHTML(item.overview || 'No description available.')}</div>
                    
                    ${isAdded ? `
                        <button class="search-add-btn added" onclick="event.stopPropagation();" disabled aria-label="Already in library" title="Already in library">
                            <svg class="icon icon-small" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>
                        </button>
                    ` : `
                        <button class="search-add-btn" onclick="event.stopPropagation(); importMediaData(${item.id}, '${currentSearchType}', this)" aria-label="Add to library" title="Add to library">
                            <svg class="icon icon-small" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                        </button>
                    `}
                </div>
            </div>
        `;
    }).join("");
}

async function openSearchResultDetails(tmdbId, type) {
    const slug = type === 'movie' ? `movie-${tmdbId}` : null;
    let existingItem = state.library.find(s => s.tmdbId === tmdbId || (slug && s.id === slug));

    if (existingItem) {
        openDetails(existingItem.id);
        return;
    }

    try {
        if (type === 'movie') {
            const movieRes = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`);
            const movieData = await movieRes.json();

            // TMDB returns 200 with a {success:false, status_message:...}
            // body for things like an invalid/expired API key - res.ok alone
            // wouldn't catch that, so check the data shape itself too.
            if (!movieRes.ok || !movieData || !movieData.id) {
                throw new Error(`TMDB movie lookup failed: ${movieData?.status_message || movieRes.status}`);
            }

            currentItem = {
                id: `preview-movie-${movieData.id}`,
                tmdbId: movieData.id,
                type: 'movie',
                title: movieData.title,
                year: movieData.release_date ? movieData.release_date.substring(0, 4) : "N/A",
                poster: movieData.poster_path ? `https://image.tmdb.org/t/p/w500${movieData.poster_path}` : "",
                backdrop: movieData.backdrop_path ? `https://image.tmdb.org/t/p/w780${movieData.backdrop_path}` : "",
                description: movieData.overview || "No description available.",
                runtime: movieData.runtime ? `${movieData.runtime} min` : "120 min",
                releaseDate: movieData.release_date ? tmdbDateToISO(movieData.release_date) : new Date().toISOString(),
                status: movieData.status || '',
                rating: (typeof movieData.vote_average === 'number' && movieData.vote_average > 0) ? movieData.vote_average.toFixed(1) : '',
                collectionName: movieData.belongs_to_collection ? movieData.belongs_to_collection.name : null,
                isPreview: true,
                watched: false,
                lastWatchedAt: null
            };

            updateModalContent();
            const detailsModalMovie = document.getElementById("detailsModal");
            if (!detailsModalMovie.classList.contains("open")) {
                detailsModalMovie.classList.add("open");
                lockBodyScroll("detailsModal");
            }
            loadWatchAvailability(currentItem);
            return;
        }

        // TV: open the modal the moment the show's own info is back, then
        // fill episodes in behind it. Fetching every season is the slow
        // part (one request per season) and previously blocked the modal
        // from appearing at all until every single one had returned.
        const showRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`);
        const showData = await showRes.json();

        if (!showRes.ok || !showData || !showData.id) {
            throw new Error(`TMDB show lookup failed: ${showData?.status_message || showRes.status}`);
        }

        const previewId = `preview-tv-${showData.id}`;

        currentItem = {
            id: previewId,
            tmdbId: showData.id,
            type: 'tv',
            title: showData.name,
            year: showData.first_air_date ? showData.first_air_date.substring(0, 4) : "N/A",
            poster: showData.poster_path ? `https://image.tmdb.org/t/p/w500${showData.poster_path}` : "",
            backdrop: showData.backdrop_path ? `https://image.tmdb.org/t/p/w780${showData.backdrop_path}` : "",
            description: showData.overview || "No description available.",
            releaseDate: showData.first_air_date ? tmdbDateToISO(showData.first_air_date) : null,
            status: showData.status || '',
            rating: (typeof showData.vote_average === 'number' && showData.vote_average > 0) ? showData.vote_average.toFixed(1) : '',
            numberOfSeasons: (typeof showData.number_of_seasons === 'number') ? showData.number_of_seasons : null,
            numberOfEpisodes: (typeof showData.number_of_episodes === 'number') ? showData.number_of_episodes : null,
            isFinished: false,
            isStopped: false,
            isPreview: true,
            episodes: [],
            episodesLoading: true
        };

        selectedSeason = 1;
        updateModalContent();
        const detailsModalTV = document.getElementById("detailsModal");
        if (!detailsModalTV.classList.contains("open")) {
            detailsModalTV.classList.add("open");
            lockBodyScroll("detailsModal");
        }
        loadWatchAvailability(currentItem);

        let episodes = [];

        if (showData.seasons && showData.seasons.length > 0) {
            const validSeasons = showData.seasons.filter(s => s.season_number > 0);
            const seasonsData = await Promise.all(validSeasons.map(season => fetchTMDBSeason(tmdbId, season.season_number)));
            episodes = buildEpisodesFromSeasons(validSeasons, seasonsData);
        }

        // The person may have closed the modal or moved on to something
        // else while the season data was in flight - only apply it if
        // they're still looking at this same preview.
        if (currentItem && currentItem.id === previewId) {
            currentItem.episodes = episodes;
            currentItem.episodesLoading = false;
            scrollToNextEpisodeOnRender = true;
            updateModalContent();
        }

    } catch (err) {
        console.error("Error opening preview details:", err);
        showErrorToast(err?.message?.startsWith("TMDB") ? err.message : "Unable to load details.");
    }
}

async function importMediaData(id, type, buttonElement) {
    if (!auth || !auth.currentUser) {
        showErrorToast("Please sign in to add items to your library.");
        return;
    }

    if (buttonElement) {
        buttonElement.disabled = true;
    }

    try {
        if (type === 'movie') {
            const availabilityPromise = fetchWatchAvailability(id, 'movie');
            const movieRes = await fetch(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_API_KEY}`);
            const movieData = await movieRes.json();

            if (!movieRes.ok || !movieData || !movieData.id) {
                throw new Error(`TMDB movie lookup failed: ${movieData?.status_message || movieRes.status}`);
            }

            const slug = `movie-${movieData.id}`;
            if (state.library.some(s => s.id === slug || s.tmdbId === movieData.id)) {
                return;
            }

            const availability = await availabilityPromise;

            const newMovie = {
                id: slug,
                tmdbId: movieData.id,
                type: 'movie',
                ownerId: state.activeProfileId,
                title: movieData.title,
                year: movieData.release_date ? movieData.release_date.substring(0, 4) : "N/A",
                poster: movieData.poster_path ? `https://image.tmdb.org/t/p/w500${movieData.poster_path}` : "",
                backdrop: movieData.backdrop_path ? `https://image.tmdb.org/t/p/w780${movieData.backdrop_path}` : "",
                description: movieData.overview || "No description available.",
                runtime: movieData.runtime ? `${movieData.runtime} min` : "120 min",
                releaseDate: movieData.release_date ? tmdbDateToISO(movieData.release_date) : new Date().toISOString(),
                status: movieData.status || '',
                rating: (typeof movieData.vote_average === 'number' && movieData.vote_average > 0) ? movieData.vote_average.toFixed(1) : '',
                watched: false,
                lastWatchedAt: null,
                addedAt: new Date().toISOString(),
                watchProviders: availability.providers,
                inCinemas: availability.inCinemas,
                watchLink: availability.link,
                contentRating: availability.contentRating,
                collectionName: movieData.belongs_to_collection ? movieData.belongs_to_collection.name : null
            };

            state.library.push(newMovie);
            await saveItem(newMovie);

            if (buttonElement) {
                buttonElement.className = "search-add-btn added";
                buttonElement.innerHTML = `<svg class="icon icon-small" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>`;
            }
            // No "you'll be notified when it releases" confirmation
            // notification here on purpose - see the matching note on the
            // TV add flow below for why.

        } else {
            const availabilityPromise = fetchWatchAvailability(id, 'tv');
            // external_ids appended for the TVmaze lookup below (an exact
            // IMDB-id match beats the name-search fallback).
            const showRes = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);
            const showData = await showRes.json();

            if (!showRes.ok || !showData || !showData.id || !showData.name) {
                throw new Error(`TMDB show lookup failed: ${showData?.status_message || showRes.status}`);
            }

            const slug = "tv-" + showData.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            if (state.library.some(s => s.id === slug || s.tmdbId === showData.id)) {
                return;
            }

            // A previous removal may have archived this exact show's watch
            // history (see removeLibraryItem) under this same slug - check
            // for it now so a re-add can restore watched episodes instead
            // of starting the show over from scratch.
            let archivedShow = null;
            if (auth && auth.currentUser && db) {
                try {
                    const archivedDoc = await db.collection("users").doc(auth.currentUser.uid).collection("archivedShows").doc(slug).get();
                    if (archivedDoc.exists) archivedShow = archivedDoc.data();
                } catch (err) {
                    console.warn("Failed to check for archived watch history:", err);
                }
            }

            let episodes = [];
            // Stays undefined (not null) unless a TVmaze resolution is
            // actually attempted below - matches resolveTVmazeShow()'s own
            // undefined/null distinction, so a show added with no seasons
            // yet still gets a real attempt on its first background sync
            // rather than being permanently treated as "already tried".
            let tvmazeId;

            if (showData.seasons && showData.seasons.length > 0) {
                const validSeasons = showData.seasons.filter(s => s.season_number > 0);
                const seasonsData = await Promise.all(validSeasons.map(season => fetchTMDBSeason(id, season.season_number)));

                // Real per-episode timing, resolved once up front so the show
                // enters the library with accurate dates immediately instead
                // of waiting for the first background sync (see the TV
                // EPISODE RELEASE TIMING block near tmdbDateToISO).
                const timingContext = { title: showData.name };
                const tvmazeShow = await resolveTVmazeShow(timingContext, showData, showData.external_ids && showData.external_ids.imdb_id);
                tvmazeId = timingContext.tvmazeId;
                const broadcastTimingMap = buildBroadcastTimingMap(tvmazeShow);

                episodes = buildEpisodesFromSeasons(validSeasons, seasonsData, null, broadcastTimingMap);
            }

            // Carry watched flags (and the date each was watched on - see
            // setEpisodeWatched) over from the archived copy, matched by each
            // episode's stable "sXeY" id - the freshly-fetched list may
            // include newer episodes the archive never saw, which is fine,
            // they just stay unwatched like any other new episode.
            if (archivedShow && Array.isArray(archivedShow.episodes)) {
                const watchedMap = new Map(archivedShow.episodes.map(ep => [ep.id, { watched: ep.watched, watchedAt: ep.watchedAt || null, rewatchCount: ep.rewatchCount || 0, rewatchedAt: ep.rewatchedAt || null }]));
                episodes.forEach(ep => {
                    const archived = watchedMap.get(ep.id);
                    if (archived && archived.watched) {
                        ep.watched = true;
                        ep.watchedAt = archived.watchedAt;
                        ep.rewatchCount = archived.rewatchCount;
                        ep.rewatchedAt = archived.rewatchedAt;
                    }
                });
            }

            const availability = await availabilityPromise;

            const newShow = {
                id: slug,
                tmdbId: showData.id,
                type: 'tv',
                ownerId: state.activeProfileId,
                title: showData.name,
                year: showData.first_air_date ? showData.first_air_date.substring(0, 4) : "N/A",
                poster: showData.poster_path ? `https://image.tmdb.org/t/p/w500${showData.poster_path}` : "",
                backdrop: showData.backdrop_path ? `https://image.tmdb.org/t/p/w780${showData.backdrop_path}` : "",
                description: showData.overview || "No description available.",
                releaseDate: showData.first_air_date ? tmdbDateToISO(showData.first_air_date) : null,
                status: showData.status || '',
                rating: (typeof showData.vote_average === 'number' && showData.vote_average > 0) ? showData.vote_average.toFixed(1) : '',
                numberOfSeasons: (typeof showData.number_of_seasons === 'number') ? showData.number_of_seasons : null,
                numberOfEpisodes: (typeof showData.number_of_episodes === 'number') ? showData.number_of_episodes : null,
                isFinished: false,
                isStopped: archivedShow ? !!archivedShow.isStopped : false,
                addedAt: new Date().toISOString(),
                episodes: episodes,
                watchProviders: availability.providers,
                inCinemas: availability.inCinemas,
                watchLink: availability.link,
                contentRating: availability.contentRating
            };
            // Only set when a TVmaze resolution was actually attempted above -
            // an omitted key (rather than an explicit `undefined` value) is
            // what keeps this field out of the Firestore write entirely,
            // consistent with resolveTVmazeShow()'s own undefined/null
            // distinction (see its comment).
            if (typeof tvmazeId !== 'undefined') newShow.tvmazeId = tvmazeId;

            state.library.push(newShow);
            await saveItem(newShow);

            // The restore is complete now that the show is back in the
            // live library - clear the archive entry so it doesn't linger
            // as a stale duplicate of what's now the real item.
            if (archivedShow && auth && auth.currentUser && db) {
                try {
                    await db.collection("users").doc(auth.currentUser.uid).collection("archivedShows").doc(slug).delete();
                } catch (err) {
                    console.warn("Failed to clear archived watch history after restore:", err);
                }
            }

            if (buttonElement) {
                buttonElement.className = "search-add-btn added";
                buttonElement.innerHTML = `<svg class="icon icon-small" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>`;
            }
            if (archivedShow) {
                showToast(`Welcome back! Your watch history for "${showData.name}" was restored.`, "success");
            }
            // No "you'll be notified..." confirmation notification here on
            // purpose - a notification whose entire content is "you will get
            // a notification later" is just noise. The button's own added-
            // state (checkmark) and the toast above (restore case) already
            // confirm the add.
        }
    } catch (error) {
        console.error("Error adding media:", error);
        showErrorToast(error?.message?.startsWith("TMDB") ? error.message : "Failed to add item.");
        if (buttonElement) {
            buttonElement.disabled = false;
            buttonElement.textContent = "Add to Library";
        }
    }
}

/* =========================================================
   DATA HELPERS & SORTING
========================================================= */
function getItem(id) {
    return state.library.find(item => item.id === id);
}

// "Available" means "released" again now that TV episodes carry a real
// releaseDate (see the TV EPISODE RELEASE TIMING block near
// tmdbDateToISO). isReleased() already treats a missing/null date as
// released, so an episode NovaWatch couldn't get any timing data for at
// all still behaves the same safe way it did before this feature
// existed, rather than silently vanishing from "available" lists.
function getAvailableEpisodes(show) {
    if (!show.episodes) return [];
    return show.episodes.filter(ep => isReleased(ep.releaseDate));
}

// Only ever returns a released episode - an aired-but-unwatched one, not
// a future one still waiting on its release date. This is what "Next:
// SxEy", Continue Watching, and the up-next highlight in the episode
// list all key off, so none of them can ever offer to mark a future
// episode watched.
function getNextUnwatchedEpisode(show) {
    if (!show.episodes || show.episodes.length === 0) return null;
    const sortedEps = getAvailableEpisodes(show)
        .sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            return a.number - b.number;
        });
    return sortedEps.find(ep => !ep.watched) || null;
}

// Which season the details modal should land on when a show is opened, so
// it always reflects where the user actually is in the show rather than
// whichever season happened to be selected last (which might belong to a
// different show entirely, or just be stale).
function getCurrentSeasonForShow(show) {
    if (!show.episodes || show.episodes.length === 0) return 1;

    const availableSeasons = [...new Set(show.episodes.map(ep => ep.season))].sort((a, b) => a - b);
    if (availableSeasons.length === 0) return 1;

    // A released-but-unwatched episode is the clearest signal of "the
    // season you're on" — land right on it, same as a "continue watching" row would.
    const nextEp = getNextUnwatchedEpisode(show);
    if (nextEp) return nextEp.season;

    // Otherwise everything released has been watched (or nothing has aired
    // yet) — use the season of the most recently watched episode, so a
    // caught-up show reopens where you left off instead of jumping back to
    // Season 1.
    const watchedSeasons = show.episodes.filter(ep => ep.watched).map(ep => ep.season);
    if (watchedSeasons.length > 0) return Math.max(...watchedSeasons);

    return availableSeasons[0];
}

function getTVProgress(show) {
    if (show.type === 'movie') {
        return {
            total: 1,
            watched: show.watched ? 1 : 0,
            percentage: show.watched ? 100 : 0,
            nextEpisode: null
        };
    }

    const available = getAvailableEpisodes(show);
    const watched = available.filter(episode => episode.watched);
    const nextEpisode = available.find(episode => !episode.watched);

    return {
        total: available.length,
        watched: watched.length,
        percentage: available.length ? Math.round((watched.length / available.length) * 100) : 0,
        nextEpisode: nextEpisode
    };
}

// "Up to date" (all known episodes watched, but the show is still
// actively producing more) vs "finished" (all episodes watched, show
// has ended) - now driven by TMDB's own `status` field ("Returning
// Series" vs "Ended"/"Canceled"/etc.) instead of an "any upcoming
// episodes" date check. This is a genuinely more reliable signal than
// per-episode dates ever were here, not just a fallback made necessary
// by removing them - a show's production status doesn't depend on any
// per-title timing data being accurate at all.
function isTVUpToDate(show) {
    if (show.type === 'movie' || show.isStopped) return false;
    const progress = getTVProgress(show);
    return (
        progress.total > 0 &&
        progress.watched === progress.total &&
        show.status === 'Returning Series'
    );
}

function isTVFinished(show) {
    if (show.type === 'movie') return show.watched;
    if (show.isStopped) return false;
    const progress = getTVProgress(show);
    return (
        progress.total > 0 &&
        progress.watched === progress.total &&
        show.status !== 'Returning Series'
    );
}

// Sorts by each show's most recently released episode - real air-date
// based now that episodes carry a genuine releaseDate again (see the TV
// EPISODE RELEASE TIMING block near tmdbDateToISO). This used to be a
// "most recently watched" substitute back when TV episodes didn't carry
// a release date at all - that substitute is gone now that the real
// thing is available again. Descending (newest first, oldest last).
function getLatestAiredEpisodeDate(show) {
    if (!show.episodes || show.episodes.length === 0) return 0;
    const released = show.episodes.filter(ep => ep.releaseDate && isReleased(ep.releaseDate));
    if (released.length === 0) return 0;
    return Math.max(...released.map(ep => new Date(ep.releaseDate).getTime()));
}

function sortTVShowsByLatestAired(shows) {
    return shows.sort((a, b) => getLatestAiredEpisodeDate(b) - getLatestAiredEpisodeDate(a));
}

// Movie equivalent of the above - every Library category, TV or movie,
// sorts by the item's own release date, latest first, as one single
// consistent rule rather than each category picking its own dimension
// (this used to mix release-date-ish TV sorting with watch-date sorting
// for movies' own Watched category, and no sorting at all for movies'
// Unwatched/Coming Soon - inconsistent, not really "latest to oldest"
// as one coherent rule at all).
function sortMoviesByReleaseDate(movies) {
    return movies.sort((a, b) => new Date(b.releaseDate || 0) - new Date(a.releaseDate || 0));
}

// Different from sortTVShowsByLatestAired above - that one sorts by the
// show's own airing schedule (when TMDB says an episode released),
// which has nothing to do with when the viewer actually watched it.
// This sorts by the viewer's own activity instead - the Library
// preview's "most recently watched" ordering needs the latter, not the
// former, so it reflects what someone's actually been doing rather
// than what happened to air recently.
function getLastWatchedEpisodeTimestamp(show) {
    if (!show.episodes) return 0;
    const watchedTimes = show.episodes
        .filter(ep => ep.watched && ep.watchedAt)
        .map(ep => new Date(ep.watchedAt).getTime());
    return watchedTimes.length > 0 ? Math.max(...watchedTimes) : 0;
}

function sortTVShowsByLastWatched(shows) {
    return [...shows].sort((a, b) => getLastWatchedEpisodeTimestamp(b) - getLastWatchedEpisodeTimestamp(a));
}

function sortMoviesByWatchedDate(movies) {
    return movies.sort((a, b) => {
        const timeA = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : 0;
        const timeB = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : 0;
        return timeB - timeA;
    });
}

/* =========================================================
   TAB NAVIGATION
========================================================= */
function showPage(page, subType = null, focusSearch = false) {
    window.scrollTo(0, 0);

    document.querySelectorAll(".page").forEach(element => element.classList.remove("active"));

    const target = document.getElementById(`${page}Page`);
    if (target) {
        target.classList.add("active");
    }

    document.querySelectorAll(".nav-button").forEach(button => button.classList.remove("active"));

    const navId = `nav${page.charAt(0).toUpperCase()}${page.slice(1)}`;
    const nav = document.getElementById(navId);
    if (nav) {
        nav.classList.add("active");
    }

    updateNavIndicator();

    if (page === "library") renderLibraryHome();
    if (page === "discover") {
        if (subType) {
            setSearchType(subType);
        } else {
            const query = document.getElementById("onlineSearchInput").value.trim();
            if (!query) fetchForYou();
        }

        // Only auto-focus when the person actually tapped their way to
        // Discover (focusSearch=true from the nav button) — never on the
        // programmatic tab restore on load, which would pop the mobile
        // keyboard unexpectedly the moment the app opens.
        if (focusSearch) {
            const input = document.getElementById("onlineSearchInput");
            if (input) {
                setTimeout(() => input.focus(), 150);
            }
        }
    }
    if (page === "home") renderHomeTab();
    if (page === "upcoming") setUpcomingView(subType || currentUpcomingView);
}

// Slides the shared glass capsule under whichever nav button is active,
// measuring the button's actual box so it works regardless of tab count
// or viewport width. animate=false snaps instantly (first paint, resize).
function updateNavIndicator(animate = true) {
    const nav = document.querySelector(".bottom-nav");
    const indicator = document.getElementById("navIndicator");
    const activeBtn = nav ? nav.querySelector(".nav-button.active") : null;
    if (!nav || !indicator || !activeBtn) return;

    if (!animate) {
        indicator.style.transition = "none";
    }

    positionNavIndicatorAt(activeBtn);

    if (!animate) {
        // Force layout before restoring the transition so the snap doesn't
        // itself animate from whatever the width/transform previously were.
        indicator.getBoundingClientRect();
        indicator.style.transition = "";
    }
}

// Shared positioning math for the pill - targets whichever button element
// is passed in, rather than always reading .nav-button.active, so the
// drag-to-switch gesture below can live-preview the indicator sliding
// under the finger without changing which tab is actually active yet
// (that only happens once the gesture is released).
function positionNavIndicatorAt(btn) {
    const nav = document.querySelector(".bottom-nav");
    const indicator = document.getElementById("navIndicator");
    if (!nav || !indicator || !btn) return;

    const navRect = nav.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    indicator.style.width = `${btnRect.width}px`;
    indicator.style.transform = `translateX(${btnRect.left - navRect.left}px)`;
}

window.addEventListener("resize", () => updateNavIndicator(false));

// Lets a finger land anywhere on the bar and drag across to the desired
// tab - the pill tracks the raw finger position continuously, in real
// time (every pointermove, not just when crossing into a new button),
// so the motion is genuinely visible throughout the whole gesture rather
// than the pill sitting still and then jumping. It keeps a fixed width
// while dragging and only resizes/settles into the target button's exact
// bounds once released, with a slight spring overshoot. A plain tap (no
// meaningful horizontal movement) is left completely alone.
function initNavBarDragToSwitch() {
    const nav = document.querySelector(".bottom-nav");
    const indicator = document.getElementById("navIndicator");
    if (!nav || !indicator) return;

    // Raised from an earlier, twitchier 10px - a normal tap's natural
    // finger wobble (especially common on touchscreens) could cross a
    // threshold that low on its own, accidentally engaging drag mode for
    // what was meant as a simple tap on a nav button. 22px requires more
    // deliberate, intentional horizontal movement before switching into
    // drag behavior, closer to typical native mobile drag-initiation
    // thresholds.
    const DRAG_THRESHOLD = 22;
    let startX = 0, startY = 0, dragging = false, pointerId = null, dragWidth = 0;
    let suppressNextClick = false, suppressClickTimer = null;

    // Belt-and-suspenders: swallow whatever click event follows a drag,
    // whichever element the browser decides to target it at. Navigation
    // itself is driven directly by finishDrag() below via showPage(), not
    // by this click at all - this listener exists purely to stop a
    // second, possibly-conflicting native click (a real risk once
    // setPointerCapture is involved) from firing right after and
    // silently reverting the tab that was just switched to. The timer
    // guarantees this flag can never get stuck true forever (e.g. if the
    // browser never actually fires a click at all after preventDefault on
    // pointerup) and end up silently eating some later, unrelated tap.
    nav.addEventListener("click", (e) => {
        if (suppressNextClick) {
            e.preventDefault();
            e.stopPropagation();
            suppressNextClick = false;
            clearTimeout(suppressClickTimer);
        }
    }, true);

    nav.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        startX = e.clientX;
        startY = e.clientY;
        dragging = false;
        pointerId = e.pointerId;
    });

    nav.addEventListener("pointermove", (e) => {
        if (e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!dragging) {
            // Require the movement to actually be horizontal - an
            // accidental vertical wobble on a tap shouldn't hijack it.
            if (Math.abs(dx) < DRAG_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
            dragging = true;
            nav.setPointerCapture(pointerId);
            // Zero transition lag during the drag itself - the pill has
            // to track the finger in real time for the motion to actually
            // read as continuous dragging rather than snapping between
            // rest points. The spring settle transition is restored in
            // finishDrag() below, once, for the release animation only.
            indicator.style.transition = "none";
            indicator.classList.add("dragging");
            dragWidth = indicator.getBoundingClientRect().width;
        }

        // This is the ONLY thing pointermove does now - purely visual,
        // no hit-testing. Which button counts as the target is decided
        // exactly once, synchronously, at release (see finishDrag) - not
        // guessed at here. An earlier version tried to track the
        // hovered button during the drag itself via a throttled
        // elementFromPoint() check, but that check could lag behind the
        // real finger position by up to a frame, or - for a fast flick -
        // never get a chance to run at all before release. Both were
        // real bugs: the pill would visually reach a tab but release
        // would revert to the start, or land on the wrong one.
        const navRect = nav.getBoundingClientRect();
        const rawX = e.clientX - navRect.left - (dragWidth / 2);
        const clampedX = Math.max(0, Math.min(rawX, navRect.width - dragWidth));
        indicator.style.width = `${dragWidth}px`;
        indicator.style.transform = `translateX(${clampedX}px)`;
    });

    function finishDrag(e) {
        if (pointerId === null || e.pointerId !== pointerId) return;

        if (dragging) {
            indicator.classList.remove("dragging");
            // Restore the default CSS transition (the spring/bounce
            // easing defined on .nav-indicator itself) now that the raw
            // 1:1 tracking is done - this is what animates the pill's
            // final settle, for both the success path below and the
            // released-outside-the-bar fallback.
            indicator.style.transition = "";

            // Nearest-button snapping, not a strict "is the release point
            // literally inside a button's own box" hit-test. The previous
            // version used document.elementFromPoint(), which only counts
            // as a hit when the finger is precisely over a .nav-button
            // element - releasing in the small gaps BETWEEN buttons (easy
            // to do with a thumb, especially mid-swipe, since there's a
            // real gap plus the bar's own padding around each button) fell
            // through to "outside any button" and reverted, even though
            // the release was clearly closer to one tab than any other.
            // This is what "doesn't switch unless you're fully on the
            // tab" actually was. Picking whichever button's horizontal
            // center the release point is nearest to - as long as the
            // release is still within the bar's own bounds at all -
            // matches how native tab bars feel: close enough commits, it
            // isn't all-or-nothing pixel precision.
            const navRect = nav.getBoundingClientRect();
            const withinBar = e.clientX >= navRect.left && e.clientX <= navRect.right
                && e.clientY >= navRect.top && e.clientY <= navRect.bottom;

            let releaseButton = null;
            if (withinBar) {
                let closestDist = Infinity;
                nav.querySelectorAll(".nav-button").forEach((btn) => {
                    const r = btn.getBoundingClientRect();
                    const dist = Math.abs(e.clientX - (r.left + r.width / 2));
                    if (dist < closestDist) {
                        closestDist = dist;
                        releaseButton = btn;
                    }
                });
            }

            if (releaseButton) {
                e.preventDefault();
                suppressNextClick = true;
                clearTimeout(suppressClickTimer);
                suppressClickTimer = setTimeout(() => { suppressNextClick = false; }, 400);
                // Calls showPage() directly rather than
                // releaseButton.click() - after setPointerCapture, the
                // browser's own native click synthesis isn't guaranteed
                // to target the same element this resolved to, and that
                // mismatch was an earlier cause of navigation
                // intermittently reverting right after it committed.
                const targetPage = releaseButton.id.replace(/^nav/, "").toLowerCase();
                showPage(targetPage);
            } else {
                // Released outside the bar entirely - snap back to
                // wherever the actually-active tab is, undoing the live
                // preview.
                updateNavIndicator(true);
            }
        }

        dragging = false;
        pointerId = null;
    }

    nav.addEventListener("pointerup", finishDrag);
    nav.addEventListener("pointercancel", finishDrag);
}

document.addEventListener("DOMContentLoaded", initNavBarDragToSwitch);

// Switches between the TV Shows / Movies sub-views inside the Library
// tab, toggling the segmented control and showing/hiding each sub-view's
// container rather than re-rendering the whole page.
function setLibraryView(view) {
    currentLibraryView = view;

    // Guarded, not assumed to exist - the segmented toggle these used to
    // belong to was removed (each section's own "View All" already
    // disambiguates TV vs Movies before the modal ever opens, so there
    // was nothing left to switch between once inside it), but this
    // function's actual job - showing the right subview and rendering
    // it - still needs to work exactly the same regardless.
    const tabTV = document.getElementById("libraryTabTV");
    const tabMovies = document.getElementById("libraryTabMovies");
    if (tabTV) tabTV.classList.toggle("active", view === 'tv');
    if (tabMovies) tabMovies.classList.toggle("active", view === 'movies');

    document.getElementById("libraryViewTV").style.display = view === 'tv' ? 'block' : 'none';
    document.getElementById("libraryViewMovies").style.display = view === 'movies' ? 'block' : 'none';

    if (view === 'tv') renderTVLibrarySection();
    if (view === 'movies') renderMovieLibrarySection();
}

// 'tv' or 'movies' - which segmented-toggle tab the modal opens showing,
// matching whichever "View All" button was actually tapped rather than
// always defaulting to TV regardless of which section someone came from.
function openFullLibraryModal(startView) {
    const modal = document.getElementById("fullLibraryModal");
    if (modal.classList.contains("open")) return;
    setLibraryView(startView || currentLibraryView);
    modal.classList.add("open");
    lockBodyScroll("fullLibraryModal");
}

function closeFullLibraryModal() {
    document.getElementById("fullLibraryModal").classList.remove("open");
    unlockBodyScroll("fullLibraryModal");
}

function closeFullLibraryModalOutside(event) {
    if (event.target.id === "fullLibraryModal") closeFullLibraryModal();
}

/* =========================================================
   HOME TAB RENDER
========================================================= */
function renderHomeTab() {
    updateHomeUI();

    // Only counts shows/movies that have actually been watched - these
    // two used to just count everything sitting in the library
    // (added-but-unwatched included), which inflated the tiles above
    // what "Viewing Analytics" should mean. Episodes below was already
    // correct (filtered to watchedEps) - these two are now consistent
    // with it.
    const totalShows = state.library.filter(i => i.type !== 'movie' && i.episodes && i.episodes.some(ep => ep.watched)).length;
    const totalMovies = state.library.filter(i => i.type === 'movie' && i.watched).length;
    
    let totalWatchedEpisodes = 0;
    let totalMinutes = 0;
    let totalRewatches = 0;
    const watchedDates = new Set();

    state.library.forEach(item => {
        if (item.type === 'movie') {
            if (item.watched) {
                const match = (item.runtime || "").match(/(\d+)/);
                const mins = match ? parseInt(match[1], 10) : 120;
                const rewatches = item.rewatchCount || 0;
                // The original watch plus every logged rewatch each count
                // their own pass at the runtime toward total watch time -
                // rewatch time folds into this total rather than getting
                // its own separate stat.
                totalMinutes += mins * (1 + rewatches);
                totalRewatches += rewatches;
                if (item.lastWatchedAt) watchedDates.add(item.lastWatchedAt.slice(0, 10));
            }
        } else if (item.episodes) {
            let watchedEps = item.episodes.filter(ep => ep.watched);
            totalWatchedEpisodes += watchedEps.length;
            
            watchedEps.forEach(ep => {
                const match = (ep.runtime || "").match(/(\d+)/);
                const mins = match ? parseInt(match[1], 10) : 45;
                const rewatches = ep.rewatchCount || 0;
                totalMinutes += mins * (1 + rewatches);
                totalRewatches += rewatches;
                if (ep.watchedAt) watchedDates.add(ep.watchedAt.slice(0, 10));
            });
        }
    });

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    
    document.getElementById("totalWatchTime").textContent = `${days} days, ${hours} hours, ${minutes} minutes`;

    const streakDays = getCurrentWatchStreak(watchedDates);
    document.getElementById("currentStreak").textContent = streakDays > 0
        ? `${streakDays} Day${streakDays === 1 ? '' : 's'} Streak`
        : "No Active Streak";
    document.getElementById("currentStreakBadge").classList.toggle("inactive", streakDays === 0);

    document.getElementById("dashboardStats").innerHTML = `
        <div class="stat">
            <svg class="icon stat-icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>
            <div class="stat-value">${totalShows}</div>
            <div class="stat-label">TV Shows</div>
        </div>
        <div class="stat">
            <svg class="icon stat-icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M2 7l4-4h3l-4 4H2z"/><path d="M11 7l4-4h3l-4 4h-3z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>
            <div class="stat-value">${totalMovies}</div>
            <div class="stat-label">Movies</div>
        </div>
        <div class="stat">
            <svg class="icon stat-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <div class="stat-value">${totalWatchedEpisodes}</div>
            <div class="stat-label">Episodes</div>
        </div>
        <div class="stat">
            <svg class="icon stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            <div class="stat-value">${totalRewatches}</div>
            <div class="stat-label">Rewatches</div>
        </div>
    `;

    renderContinueWatching();
}

function renderTVLibrarySection(containerId = "tvLibraryCategories", inputId = "tvLibrarySearchInput") {
    const container = document.getElementById(containerId);
    const searchInput = document.getElementById(inputId);
    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";

    let items = state.library.filter(i => i.type === 'tv' || !i.type);

    if (query) {
        items = items.filter(item => item.title.toLowerCase().includes(query));
    }

    // Same "still loading, not actually empty" guard as renderContinueWatching.
    if (!items.length && !libraryLoaded) {
        setInnerHTMLIfChanged(container, skeletonRows());
        return;
    }

    if (!items.length) {
        // Query-aware: if a search actually filtered everything out, say
        // that - "your library is empty" is simply false when there ARE
        // shows in the library and the search just didn't match any of
        // them. This branch used to always claim the whole library was
        // empty regardless of why the filtered list came up empty.
        if (query) {
            setInnerHTMLIfChanged(container, emptyState("No TV Shows Matching", "No TV shows match your search query."));
        } else {
            setInnerHTMLIfChanged(container, emptyState("No TV Shows Found", "Your TV show library is empty.", { label: "Search", onclick: "showPage('discover', 'tv')" }));
        }
        return;
    }

    const inProgress = sortTVShowsByLatestAired(items.filter(item => {
        if (item.isStopped) return false;
        const p = getTVProgress(item);
        return p.watched > 0 && p.watched < p.total;
    }));

    const upToDate = sortTVShowsByLatestAired(items.filter(item => !item.isStopped && isTVUpToDate(item)));
    const finished = sortTVShowsByLatestAired(items.filter(item => !item.isStopped && isTVFinished(item)));
    const unwatched = sortTVShowsByLatestAired(items.filter(item => {
        if (item.isStopped) return false;
        const p = getTVProgress(item);
        return p.total > 0 && p.watched === 0;
    }));
    // Shows with no episodes at all yet.
    const comingSoon = sortTVShowsByLatestAired(items.filter(item => {
        if (item.isStopped) return false;
        const p = getTVProgress(item);
        return p.total === 0;
    }));
    const stopped = sortTVShowsByLatestAired(items.filter(item => item.isStopped));

    const visPrefs = getLibraryVisibilityPrefs();

    const categories = [];
    if (inProgress.length > 0) categories.push({ title: "In Progress", items: inProgress });
    if (upToDate.length > 0) categories.push({ title: "Up to Date", items: upToDate });
    if (finished.length > 0 && visPrefs.showFinished) categories.push({ title: "Finished", items: finished });
    if (unwatched.length > 0 && visPrefs.showUnwatched) categories.push({ title: "Unwatched", items: unwatched });
    if (comingSoon.length > 0) categories.push({ title: "Coming Soon", items: comingSoon });
    if (stopped.length > 0 && visPrefs.showStopped) categories.push({ title: "Stopped Watching", items: stopped });

    if (categories.length === 0) {
        setInnerHTMLIfChanged(container, emptyState("No TV Shows Matching", "No TV shows match your search query."));
        return;
    }

    renderCategorizedLibrary(container, categories);
}

function renderMovieLibrarySection(containerId = "movieLibraryCategories", inputId = "movieLibrarySearchInput") {
    const container = document.getElementById(containerId);
    const searchInput = document.getElementById(inputId);
    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";

    let items = state.library.filter(i => i.type === 'movie');

    if (query) {
        items = items.filter(item => item.title.toLowerCase().includes(query));
    }

    // Same "still loading, not actually empty" guard as renderContinueWatching.
    if (!items.length && !libraryLoaded) {
        setInnerHTMLIfChanged(container, skeletonRows());
        return;
    }

    if (!items.length) {
        // Same query-aware fix as renderTVLibrarySection - "your library
        // is empty" is false when the library has movies and the search
        // just didn't match any of them.
        if (query) {
            setInnerHTMLIfChanged(container, emptyState("No Movies Matching", "No movies match your search query."));
        } else {
            setInnerHTMLIfChanged(container, emptyState("No Movies Found", "Your movie library is empty.", { label: "Search", onclick: "showPage('discover', 'movie')" }));
        }
        return;
    }

    const unwatched = sortMoviesByReleaseDate(items.filter(item => !item.watched && isReleased(item.releaseDate)));
    const comingSoon = sortMoviesByReleaseDate(items.filter(item => !item.watched && !isReleased(item.releaseDate)));
    const watched = sortMoviesByReleaseDate(items.filter(item => item.watched));

    const categories = [];
    if (unwatched.length > 0) categories.push({ title: "Unwatched", items: unwatched });
    if (comingSoon.length > 0) categories.push({ title: "Coming Soon", items: comingSoon });
    if (watched.length > 0) categories.push({ title: "Watched", items: watched });

    if (categories.length === 0) {
        setInnerHTMLIfChanged(container, emptyState("No Movies Matching", "No movies match your search query."));
        return;
    }

    renderCategorizedLibrary(container, categories);
}

/* =========================================================
   LIBRARY HOME (Lists row + TV/Movie previews)
   What the Library tab itself shows now - the segmented TV/Movies view
   that used to live directly on this tab moved into #fullLibraryModal
   (see openFullLibraryModal), reachable via either section's "View
   All". This is the tab's own content: a horizontally-scrolling Lists
   row, then a curated 9-item preview each for TV and Movies that
   updates automatically based on watch activity - nothing here is
   manually arranged by the person using it.
========================================================= */
// Priority 1: shows genuinely in progress (watched some, not all,
// released episodes) - not Home's broader Continue Watching definition,
// which also includes shows never even started; this is specifically
// "shows watched episodes but hasn't finished the series", sorted by
// the viewer's own most recent activity. Priority 2, filling any
// remaining slots up to 9: shows fully caught up with everything
// currently out, also by most recent activity - so a barely-used
// library still shows something sensible rather than a mostly-empty
// preview.
function pickLibraryPreviewShows() {
    const tvItems = state.library.filter(i => (i.type === 'tv' || !i.type) && !i.isStopped);

    const inProgress = sortTVShowsByLastWatched(tvItems.filter(item => {
        const p = getTVProgress(item);
        return p.watched > 0 && p.watched < p.total;
    }));

    const upToDate = sortTVShowsByLastWatched(tvItems.filter(item => isTVUpToDate(item)));

    const combined = [...inProgress];
    upToDate.forEach(show => {
        if (combined.length < 9 && !combined.includes(show)) combined.push(show);
    });

    return combined.slice(0, 9);
}

// Same idea as the TV preview, adapted for movies not having partial
// progress the way a show does - a movie is either watched or it
// isn't, so "in progress" doesn't apply. Priority 1: watched movies,
// most recently watched first (sortMoviesByWatchedDate already does
// exactly this). Priority 2, filling remaining slots: released but
// unwatched movies, newest addition first, so a library with little
// watch history yet still shows a full preview rather than a sparse
// one.
function pickLibraryPreviewMovies() {
    const movieItems = state.library.filter(i => i.type === 'movie');

    const watched = sortMoviesByWatchedDate(movieItems.filter(item => item.watched));

    const unwatched = movieItems
        .filter(item => !item.watched && isReleased(item.releaseDate))
        .sort((a, b) => {
            const dateA = a.addedAt ? new Date(a.addedAt).getTime() : 0;
            const dateB = b.addedAt ? new Date(b.addedAt).getTime() : 0;
            return dateB - dateA;
        });

    const combined = [...watched];
    unwatched.forEach(movie => {
        if (combined.length < 9 && !combined.includes(movie)) combined.push(movie);
    });

    return combined.slice(0, 9);
}

// One list card - a 2x2 mini-collage of up to the first 4 items' own
// posters (any empty slots left blank/neutral rather than forcing a
// placeholder icon into every gap, since a brand new list or a not-yet-
// favorited Favourites list legitimately has zero items to show yet),
// name and item count in a gradient scrim over the bottom, the same
// image+text-overlay pattern already used for the modal backdrop
// header elsewhere in the app rather than a new visual language just
// for this.
function createListCard(list, isFavorites) {
    const items = isFavorites ? getFavoriteListItems() : getListItems(list.id);

    // A chosen custom backdrop (see openListBackdropPicker, and the
    // Favourites-specific version below) always wins when set.
    // Otherwise, auto-pick whichever item was added most recently that
    // actually has a backdrop image, and use that, full-size, rather
    // than a poster collage - a backdrop is already the right shape for
    // this card (landscape, matching its own 2:1 aspect ratio), where a
    // poster (portrait) never was. The collage approach broke down
    // visibly for any list under 4 items - the normal case, not a rare
    // one - since empty slots just showed blank instead of anything
    // meaningful; one full-card image reads as considered regardless of
    // how many items are actually in the list. "Most recent" specifically
    // (not just "the first one with a backdrop") means favoriting a new
    // item updates the card immediately, and un-favoriting it correctly
    // falls back to whichever item is now the most recent instead of an
    // arbitrary one. getFavoriteListItems() already returns most-recent-
    // first; getListItems() returns insertion order (oldest first, since
    // addItemToList appends), so regular lists search from the end
    // instead - same "most recent" intent, just walking the opposite
    // direction to match how each list is actually ordered. Falls back
    // to a plain surface color only if literally nothing in the list has
    // a backdrop at all.
    const customBackdrop = !isFavorites && list.backdropUrl;
    const favoritesBackdrop = isFavorites && state.favoritesBackdropUrl;
    const searchOrder = isFavorites ? items : [...items].reverse();
    const autoBackdrop = (!customBackdrop && !favoritesBackdrop) ? searchOrder.find(item => item.backdrop) : null;
    const backdropSrc = customBackdrop ? list.backdropUrl : (favoritesBackdrop ? state.favoritesBackdropUrl : (autoBackdrop ? autoBackdrop.backdrop : null));

    const visualHTML = backdropSrc
        ? `<img class="list-card-backdrop" src="${tmdbThumb(backdropSrc, 'w780')}" alt="" loading="lazy" decoding="async">`
        : '';

    const listIdAttr = isFavorites ? '' : list.id;

    return `
        <div class="list-card"
             onclick="handleListCardClick(event, '${listIdAttr}', ${isFavorites})"
             onmousedown="startListPress('${listIdAttr}', ${isFavorites}, event)"
             onmouseup="endListPress()"
             onmouseleave="endListPress()"
             ontouchstart="startListPress('${listIdAttr}', ${isFavorites}, event)"
             ontouchmove="moveListPress(event)"
             ontouchend="endListPress()"
             ontouchcancel="endListPress()">
            ${visualHTML}
            <div class="list-card-scrim"></div>
            <div class="list-card-label">
                <div class="list-card-name">${escapeHTML(isFavorites ? "Favourites" : list.name)}</div>
                <div class="list-card-count">${items.length} ${items.length === 1 ? 'title' : 'titles'}</div>
            </div>
        </div>
    `;
}

// Shared by renderListsRow and the Reorder Lists modal, so both always
// agree on the same order. Favourites is included as a movable entry
// now too (see moveList below) - it has no list document of its own,
// so its position is stored as favoritesOrder on the account's own
// document instead, the same pattern favoritesBackdropUrl already
// established. Once anything has an explicit order value (assigned the
// first time anyone actually reorders anything at all), everything
// sorts purely by that. Before that first reorder, Favourites stays
// first and lists fall back to creation order - exactly the behavior
// this app already had before reordering existed at all, so nobody
// sees anything change until they actually touch it.
function getOrderedListEntries() {
    const favoritesEntry = { id: '__favorites__', isFavorites: true, order: state.favoritesOrder };
    const listEntries = state.lists.map(l => ({ id: l.id, isFavorites: false, list: l, order: l.order }));
    const all = [favoritesEntry, ...listEntries];

    if (all.some(e => e.order != null)) {
        return all.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    }

    return [
        favoritesEntry,
        ...listEntries.sort((a, b) => new Date(a.list.createdAt || 0) - new Date(b.list.createdAt || 0))
    ];
}

function renderListsRow() {
    const container = document.getElementById("listsRow");
    if (!container) return;

    container.innerHTML = getOrderedListEntries()
        .map(e => createListCard(e.isFavorites ? null : e.list, e.isFavorites))
        .join("");
}

/* =========================================================
   REORDER LISTS
========================================================= */
function openReorderListsModal() {
    const modal = document.getElementById("reorderListsModal");
    if (modal.classList.contains("open")) return;
    renderReorderListsContent();
    modal.classList.add("open");
    lockBodyScroll("reorderListsModal");
}

function closeReorderListsModal() {
    document.getElementById("reorderListsModal").classList.remove("open");
    unlockBodyScroll("reorderListsModal");
}

function closeReorderListsModalOutside(event) {
    if (event.target.id === "reorderListsModal") closeReorderListsModal();
}

function renderReorderListsContent() {
    const container = document.getElementById("reorderListsRows");
    const entries = getOrderedListEntries();

    container.innerHTML = entries.map((entry, i) => `
        <div class="reorder-list-row">
            <div class="reorder-list-name">${escapeHTML(entry.isFavorites ? "Favourites" : entry.list.name)}</div>
            <div class="reorder-list-controls">
                <button class="reorder-move-btn" onclick="moveList('${entry.id}', -1)" ${i === 0 ? 'disabled' : ''} aria-label="Move up">
                    <svg class="icon icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
                </button>
                <button class="reorder-move-btn" onclick="moveList('${entry.id}', 1)" ${i === entries.length - 1 ? 'disabled' : ''} aria-label="Move down">
                    <svg class="icon icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                </button>
            </div>
        </div>
    `).join("");
}

// entryId: a real list's own id, or '__favorites__' for the automatic
// Favourites list, which is now a movable entry in this same ordering
// too - see getOrderedListEntries above for why that needed its own
// dedicated field (favoritesOrder, on the account document, since
// Favourites has no list document of its own to store this on).
// direction: -1 to move earlier, 1 to move later. Simple adjacent-swap
// move buttons rather than drag-and-drop - genuine drag gestures behave
// inconsistently across touch, mouse, and different browsers (native
// HTML5 drag-and-drop in particular barely works on touch devices at
// all), where a plain button tap works identically everywhere this app
// runs. The first move for any account backfills a real order value
// onto every entry at once (from whatever order they're already
// showing in, so nothing visibly jumps the first time this runs) -
// after that, every entry already has one and this just swaps two
// adjacent values. The Firestore batch mixes a user-document update
// (for Favourites) with list-document updates (for everything else) in
// the same commit where needed - a single batch isn't limited to one
// collection or document shape, so this doesn't need two separate
// writes just because the two kinds of entry are stored differently.
async function moveList(entryId, direction) {
    if (!auth || !auth.currentUser) return;
    const entries = getOrderedListEntries();
    const index = entries.findIndex(e => e.id === entryId);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= entries.length) return;

    const needsBackfill = entries.some(e => e.order == null);
    // Snapshots every entry that's about to change - just a/b normally,
    // but backfill touches every entry at once the first time anyone
    // reorders anything at all, so a failure needs to be able to put
    // all of them back, not just the two that were actually being
    // swapped.
    const touched = needsBackfill ? entries : [entries[index], entries[targetIndex]];
    const previousOrders = touched.map(e => e.order);

    if (needsBackfill) {
        entries.forEach((e, i) => { e.order = i; });
    }

    const a = entries[index];
    const b = entries[targetIndex];
    const aOrder = a.order;
    a.order = b.order;
    b.order = aOrder;

    try {
        const userRef = db.collection("users").doc(auth.currentUser.uid);
        const listsRef = userRef.collection("lists");
        const batch = db.batch();
        const writeEntry = (e) => {
            if (e.isFavorites) {
                batch.update(userRef, { favoritesOrder: e.order });
                state.favoritesOrder = e.order;
            } else {
                batch.update(listsRef.doc(e.id), { order: e.order });
                // Was missing entirely - e.order is a copied value on
                // this wrapper object (see getOrderedListEntries above),
                // not a live reference back to the real list object in
                // state.lists, so mutating it here alone never actually
                // changed anything either render function would read.
                // Reordering only appeared to work once the Firestore
                // listener round-tripped back with the server's own
                // confirmation - not instantly, the same class of bug
                // fixed in add/removeItemFromList and deleteList above.
                e.list.order = e.order;
            }
        };
        if (needsBackfill) {
            entries.forEach(writeEntry);
        } else {
            writeEntry(a);
            writeEntry(b);
        }
        await batch.commit();
        renderReorderListsContent();
        // The Reorder modal's own list above is a separate render pass
        // from the Lists row on Library's home page - without this too,
        // that row would keep showing the pre-move order until the
        // person navigated away and back, or the Firestore listener
        // eventually caught up.
        renderListsRow();
    } catch (err) {
        console.error("Reorder lists FAILED", err);
        showErrorToast(`Couldn't reorder lists (${err.code || err.message || 'unknown error'}).`);
        // Rolls every touched entry back to its pre-move order on a
        // genuine failure - otherwise the reordered position would
        // stick locally even though the server never actually saved it.
        touched.forEach((e, i) => {
            e.order = previousOrders[i];
            if (e.isFavorites) {
                state.favoritesOrder = previousOrders[i];
            } else {
                e.list.order = previousOrders[i];
            }
        });
        renderReorderListsContent();
        renderListsRow();
    }
}

function renderLibraryHome() {
    renderListsRow();

    const tvContainer = document.getElementById("tvLibraryPreviewGrid");
    if (tvContainer) {
        const shows = pickLibraryPreviewShows();
        if (shows.length > 0) {
            syncCardGrid(tvContainer, shows, createCard);
        } else {
            tvContainer.innerHTML = emptyState("Nothing to Show Yet", "Shows you're watching will appear here.");
        }
    }

    const movieContainer = document.getElementById("movieLibraryPreviewGrid");
    if (movieContainer) {
        const movies = pickLibraryPreviewMovies();
        if (movies.length > 0) {
            syncCardGrid(movieContainer, movies, createCard);
        } else {
            movieContainer.innerHTML = emptyState("Nothing to Show Yet", "Movies you're watching will appear here.");
        }
    }
}

function renderCategoryBlock(title, items) {
    return `
        <div class="category-block" data-category="${escapeHTML(title)}">
            <div class="category-title">
                <span>${escapeHTML(title)}</span>
                <span class="category-count">${items.length}</span>
            </div>
            <div class="library-grid">
                ${items.map(item => createCard(item)).join("")}
            </div>
        </div>
    `;
}

// Same "only touch what actually changed" idea as syncCardGrid, one
// level up - renderTVLibrarySection/renderMovieLibrarySection build a
// multi-category view (In Progress, Up to Date, Finished, ...), and
// setInnerHTMLIfChanged alone meant ANY single card changing anywhere
// in ANY category replaced the ENTIRE multi-category block, destroying
// and recreating every <img> in every category, not just the one that
// actually changed - the same poster-flicker problem syncCardGrid
// already fixed for the Library home preview and List Detail, just not
// yet here. This checks whether the SET of categories present (by
// title, in order) genuinely changed first - if a show moved between
// categories (In Progress -> Finished) or a category appeared/emptied
// out, that's a real structural change and still gets the full
// replacement, since inserting/removing a whole category block isn't
// something worth building a general keyed-reconciliation system for.
// But the common case - nothing changed categories, a progress bar
// updated somewhere - now updates only that one card's grid via
// syncCardGrid, leaving every other category's cards, and their
// already-decoded images, completely untouched.
function renderCategorizedLibrary(container, categories) {
    if (!container) return;

    const existingBlocks = Array.from(container.children).filter(el => el.classList.contains("category-block"));
    const existingKeys = existingBlocks.map(b => b.dataset.category);
    const newKeys = categories.map(c => c.title);
    const sameStructure = existingKeys.length === newKeys.length && existingKeys.every((k, i) => k === newKeys[i]);

    if (!sameStructure) {
        const html = categories.map(c => renderCategoryBlock(c.title, c.items)).join("");
        setInnerHTMLIfChanged(container, html);
        return;
    }

    categories.forEach((cat, i) => {
        const block = existingBlocks[i];
        const countEl = block.querySelector(".category-count");
        if (countEl && countEl.textContent !== String(cat.items.length)) {
            countEl.textContent = cat.items.length;
        }
        const grid = block.querySelector(".library-grid");
        syncCardGrid(grid, cat.items, createCard);
    });
}

/* =========================================================
   CARDS
========================================================= */
function createCard(item) {
    const hasPoster = item.poster && item.poster.trim() !== "";

    let progressBarHTML = '';
    if (item.type !== 'movie') {
        const prog = getTVProgress(item);
        if (prog.total > 0 && prog.watched > 0) {
            let barColor = 'var(--blue)';
            if (item.isStopped) {
                barColor = 'var(--text-muted)';
            } else if (isTVFinished(item)) {
                barColor = 'var(--danger)';
            } else if (isTVUpToDate(item)) {
                barColor = 'var(--success)';
            }
            progressBarHTML = `
                <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: rgba(0,0,0,0.2); z-index: 2;">
                    <div style="width: ${prog.percentage}%; height: 100%; background: ${barColor};"></div>
                </div>
            `;
        }
    }

    const placeholderIcon = item.type === 'movie'
        ? `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M2 7l4-4h3l-4 4H2z"/><path d="M11 7l4-4h3l-4 4h-3z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`
        : `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>`;

    return `
        <div class="card" onclick="handleCardClick(event, '${item.id}')" data-id="${item.id}">
            <div class="poster"
                 oncontextmenu="return false;"
                 onmousedown="startPosterPress('${item.id}', '${item.type}', event)"
                 onmouseup="endPosterPress()"
                 onmouseleave="endPosterPress()"
                 ontouchstart="startPosterPress('${item.id}', '${item.type}', event)"
                 ontouchmove="movePosterPress(event)"
                 ontouchend="endPosterPress()"
                 ontouchcancel="endPosterPress()">
                ${hasPoster ? `
                    <img src="${tmdbThumb(item.poster, 'w342')}" alt="${escapeHTML(item.title)}" draggable="false" loading="lazy" decoding="async" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="poster-placeholder" style="display: none;">${placeholderIcon}</div>
                ` : `
                    <div class="poster-placeholder">${placeholderIcon}</div>
                `}
                ${progressBarHTML}
            </div>
        </div>
    `;
}

/* =========================================================
   CONTINUE WATCHING (HOME)
   The single next thing to watch for every show/movie in the
   library: the next released-but-unwatched episode for TV shows,
   or the movie itself if it hasn't been watched yet. Stopped
   shows are excluded, same as "in progress" everywhere else.
========================================================= */
function getContinueWatchingItems() {
    const tvShows = state.library.filter(item => {
        if (item.isStopped || item.type === 'movie') return false;
        return !!getNextUnwatchedEpisode(item);
    });

    const movies = state.library.filter(item => {
        return item.type === 'movie' && !item.watched && isReleased(item.releaseDate);
    });

    const tvItems = sortTVShowsByLatestAired(tvShows).map(show => ({
        show: show,
        episode: getNextUnwatchedEpisode(show)
    }));

    // Newest to oldest by when the movie was most recently watched/updated
    // in your library (falls back to release date for older library items
    // saved before this was tracked).
    const movieItems = [...movies].sort((a, b) => {
        const dateA = a.lastWatchedAt ? new Date(a.lastWatchedAt).getTime() : (a.addedAt ? new Date(a.addedAt).getTime() : (a.releaseDate ? new Date(a.releaseDate).getTime() : 0));
        const dateB = b.lastWatchedAt ? new Date(b.lastWatchedAt).getTime() : (b.addedAt ? new Date(b.addedAt).getTime() : (b.releaseDate ? new Date(b.releaseDate).getTime() : 0));
        return dateB - dateA;
    });

    return { tvItems: tvItems, movieItems: movieItems };
}

function continuePlaceholderIcon(type) {
    return type === 'movie'
        ? `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M2 7l4-4h3l-4 4H2z"/><path d="M11 7l4-4h3l-4 4h-3z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`
        : `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>`;
}

// Builds one swipeable "up next" card. TV cards use the episode's own still
// (its preview image) as the banner with the show's poster badged over the
// bottom-left corner; movie cards fall back to the movie's backdrop/poster.
function createContinueCard(type, item, episode) {
    const hasPoster = item.poster && item.poster.trim() !== "";
    const posterHTML = hasPoster
        ? `<img src="${tmdbThumb(item.poster, 'w342')}" class="continue-poster" alt="${escapeHTML(item.title)}" draggable="false" loading="lazy" decoding="async" onerror="this.style.display='none'">`
        : `<div class="continue-poster" style="display:flex; align-items:center; justify-content:center; text-align:center; font-size:10px; color:var(--text-muted); padding:5px;">${continuePlaceholderIcon(type)}</div>`;

    // The meta line and description surface the *episode's* own info for TV
    // (season/episode + its synopsis) rather than the show's general blurb,
    // so this row tells you exactly what you're about to watch next.
    const metaHTML = type === 'tv'
        ? `<span>S${episode.season}</span><span>•</span><span>E${episode.number}</span>`
        : `<span>${escapeHTML(item.year || 'N/A')}</span><span>•</span><span>Movie</span>`;

    const episodeNameHTML = type === 'tv'
        ? `<div class="continue-episode-name">${escapeHTML(episode.title)}</div>`
        : '';

    const overviewText = type === 'tv'
        ? (episode.overview || item.description || 'No description available.')
        : (item.description || 'No description available.');

    const epId = type === 'tv' ? episode.id : '';

    // Left-swipe action: TV shows with no watched episodes yet get removed
    // outright, shows with any watched episodes get marked Stopped Watching
    // instead of losing that watch history. Movies in this list are always
    // unwatched by definition (Continue Watching only shows unwatched
    // movies), so there's no watch history to protect - left-swipe always
    // removes the movie outright, same as an untouched TV show.
    const hasWatchedEpisode = type === 'tv' && item.episodes && item.episodes.some(ep => ep.watched);
    const leftAction = type === 'tv' ? (hasWatchedEpisode ? 'stop' : 'remove') : 'remove';

    return `
        <div class="continue-card-wrap">
            <div class="continue-card-bg">
                <span>Mark Watched</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div class="continue-card" data-type="${type}" data-item-id="${item.id}" data-ep-id="${epId}" data-left-action="${leftAction}">
                ${posterHTML}
                <div class="continue-body">
                    <div class="continue-title">${escapeHTML(item.title)}</div>
                    <div class="continue-meta-line">${metaHTML}</div>
                    ${episodeNameHTML}
                    <div class="continue-overview">${escapeHTML(overviewText)}</div>
                </div>
                <button class="continue-check-btn" onclick="event.stopPropagation(); markContinueItemWatched('${type}', '${item.id}', '${epId}')" aria-label="Mark watched" title="Mark watched">
                    <svg class="icon icon-small" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>
                </button>
            </div>
        </div>
    `;
}

function renderContinueWatching(containerId = "continueWatchingList") {
    const container = document.getElementById(containerId);
    if (!container) return;

    // The cloud library hasn't finished its first fetch yet this session -
    // show a skeleton rather than "You're All Caught Up", which would
    // otherwise look identical to a genuinely empty library and read as
    // the app being done loading when it's actually still in flight.
    if (!libraryLoaded) {
        setInnerHTMLIfChanged(container, skeletonRows(3));
        return;
    }

    const data = getContinueWatchingItems();
    const tvItems = data.tvItems;
    const movieItems = data.movieItems;

    if (tvItems.length === 0 && movieItems.length === 0) {
        setInnerHTMLIfChanged(container, emptyState(
            "You're All Caught Up",
            "New episodes and unwatched movies from your library will show up here.",
            { label: "Search", onclick: "showPage('discover', null, true)" }
        ));
        return;
    }

    let html = "";

    if (tvItems.length > 0) {
        html += `
            <div class="continue-group">
                <div class="continue-group-title"><span>TV Shows</span></div>
                ${tvItems.map(entry => createContinueCard('tv', entry.show, entry.episode)).join("")}
            </div>
        `;
    }

    if (movieItems.length > 0) {
        html += `
            <div class="continue-group">
                <div class="continue-group-title"><span>Movies</span></div>
                ${movieItems.map(movie => createContinueCard('movie', movie, null)).join("")}
            </div>
        `;
    }

    // Swipe handlers stay attached to unchanged DOM elements, so only
    // re-run initContinueCardSwipe when the content genuinely changed -
    // re-initializing on the SAME elements every periodic sync (see
    // setInnerHTMLIfChanged above) risked attaching duplicate listeners.
    if (setInnerHTMLIfChanged(container, html)) {
        initContinueCardSwipe(container);
    }
}

/* =========================================================
   UPCOMING TAB
   Not-yet-released movies and TV episodes from the library - split
   into the same TV Shows/Movies segmented toggle the Library tab uses
   (setUpcomingView), and rendered with the exact same category-block/
   poster-grid card components as Library, just bucketed by
   Today/Tomorrow/This Week/Later instead of watch status. One
   consistent card system across the app instead of a bespoke design
   for this one tab.
========================================================= */
// Every not-yet-released TV episode across the whole library, one entry
// per episode - not just the next one per show, so a show with several
// unreleased episodes queued up (a season mid-air) shows all of them,
// not just the soonest.
function getUpcomingTVEpisodes(show) {
    if (!show.episodes || show.episodes.length === 0) return [];
    return show.episodes
        .filter(ep => ep.releaseDate && !isReleased(ep.releaseDate))
        .sort((a, b) => new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime());
}

function getUpcomingItems() {
    const tvShows = state.library.filter(item => item.type !== 'movie' && !item.isStopped);
    const tvEntries = tvShows.flatMap(show =>
        getUpcomingTVEpisodes(show).map(episode => ({ type: 'tv', item: show, episode }))
    );

    const movieEntries = state.library
        .filter(item => item.type === 'movie' && !item.watched && item.releaseDate && !isReleased(item.releaseDate))
        .map(item => ({ type: 'movie', item, episode: null }));

    const combined = [...tvEntries, ...movieEntries];
    combined.sort((a, b) => {
        const dateA = new Date(a.type === 'tv' ? a.episode.releaseDate : a.item.releaseDate).getTime();
        const dateB = new Date(b.type === 'tv' ? b.episode.releaseDate : b.item.releaseDate).getTime();
        return dateA - dateB;
    });
    return combined;
}

// Buckets already-sorted upcoming entries into Today / Tomorrow / This
// Week / Later, using the same daysUntil() calendar-day math the
// countdown captions themselves use, so the bucket a card lands in
// always agrees with the countdown printed on it.
function bucketUpcomingItems(entries) {
    const buckets = { today: [], tomorrow: [], thisWeek: [], later: [] };
    entries.forEach(entry => {
        const date = entry.type === 'tv' ? entry.episode.releaseDate : entry.item.releaseDate;
        const days = daysUntil(date);
        if (days <= 0) buckets.today.push(entry);
        else if (days === 1) buckets.tomorrow.push(entry);
        else if (days <= 7) buckets.thisWeek.push(entry);
        else buckets.later.push(entry);
    });
    return buckets;
}

// Same poster-card markup as the Library grid's createCard() - including
// the same long-press-to-change-poster gesture (these are already-
// tracked library items, same as a Library card, so the same poster
// customization makes just as much sense here) - plus a caption line
// underneath for what Library cards don't need to show (a show/movie
// you already added doesn't need its release status spelled out under
// the poster; an upcoming one does).
function createUpcomingLibraryCard(entry) {
    const item = entry.item;
    const episode = entry.episode;
    const date = entry.type === 'tv' ? episode.releaseDate : item.releaseDate;
    const hasPoster = item.poster && item.poster.trim() !== "";

    const placeholderIcon = entry.type === 'movie'
        ? `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M2 7l4-4h3l-4 4H2z"/><path d="M11 7l4-4h3l-4 4h-3z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`
        : `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>`;

    const captionHTML = entry.type === 'tv'
        ? `S${episode.season} E${episode.number} &bull; ${getCountdown(date)}`
        : getCountdown(date);

    return `
        <div class="card" onclick="handleCardClick(event, '${item.id}')" data-id="${item.id}" title="${escapeHTML(formatDateWithReleaseTime(date))}">
            <div class="poster"
                 oncontextmenu="return false;"
                 onmousedown="startPosterPress('${item.id}', '${entry.type}', event)"
                 onmouseup="endPosterPress()"
                 onmouseleave="endPosterPress()"
                 ontouchstart="startPosterPress('${item.id}', '${entry.type}', event)"
                 ontouchmove="movePosterPress(event)"
                 ontouchend="endPosterPress()"
                 ontouchcancel="endPosterPress()">
                ${hasPoster ? `
                    <img src="${tmdbThumb(item.poster, 'w342')}" alt="${escapeHTML(item.title)}" draggable="false" loading="lazy" decoding="async" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="poster-placeholder" style="display: none;">${placeholderIcon}</div>
                ` : `
                    <div class="poster-placeholder">${placeholderIcon}</div>
                `}
            </div>
            <div class="card-title">${escapeHTML(item.title)}</div>
            <div class="upcoming-card-caption">${captionHTML}</div>
        </div>
    `;
}

function renderUpcomingCategoryBlock(title, entries) {
    return `
        <div class="category-block">
            <div class="category-title">
                <span>${escapeHTML(title)}</span>
                <span class="category-count">${entries.length}</span>
            </div>
            <div class="library-grid">
                ${entries.map(entry => createUpcomingLibraryCard(entry)).join("")}
            </div>
        </div>
    `;
}

function renderUpcomingBuckets(container, entries, query, emptyTitle, emptySub, emptyOnclick, matchingTitle, matchingSub) {
    if (!container) return;

    if (!libraryLoaded) {
        setInnerHTMLIfChanged(container, skeletonRows(3));
        return;
    }

    if (entries.length === 0) {
        // Same query-aware distinction as the Library empty states -
        // "nothing upcoming at all" and "your search matched nothing"
        // are different situations and shouldn't share one message.
        if (query) {
            setInnerHTMLIfChanged(container, emptyState(matchingTitle, matchingSub));
        } else {
            setInnerHTMLIfChanged(container, emptyState(emptyTitle, emptySub, { label: "Search", onclick: emptyOnclick }));
        }
        return;
    }

    const buckets = bucketUpcomingItems(entries);
    let html = "";
    if (buckets.today.length > 0) html += renderUpcomingCategoryBlock("Today", buckets.today);
    if (buckets.tomorrow.length > 0) html += renderUpcomingCategoryBlock("Tomorrow", buckets.tomorrow);
    if (buckets.thisWeek.length > 0) html += renderUpcomingCategoryBlock("This Week", buckets.thisWeek);
    if (buckets.later.length > 0) html += renderUpcomingCategoryBlock("Later", buckets.later);
    setInnerHTMLIfChanged(container, html);
}

function renderUpcomingTVSection() {
    const searchInput = document.getElementById("upcomingTVSearchInput");
    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";

    let items = getUpcomingItems().filter(entry => entry.type === 'tv');
    if (query) items = items.filter(entry => entry.item.title.toLowerCase().includes(query));

    renderUpcomingBuckets(
        document.getElementById("upcomingTVCategories"),
        items,
        query,
        "Nothing Upcoming",
        "New episodes from your TV shows will show up here.",
        "showPage('discover', 'tv')",
        "No TV Shows Matching",
        "No upcoming TV shows match your search query."
    );
}

function renderUpcomingMovieSection() {
    const searchInput = document.getElementById("upcomingMovieSearchInput");
    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";

    let items = getUpcomingItems().filter(entry => entry.type === 'movie');
    if (query) items = items.filter(entry => entry.item.title.toLowerCase().includes(query));

    renderUpcomingBuckets(
        document.getElementById("upcomingMovieCategories"),
        items,
        query,
        "Nothing Upcoming",
        "New movie releases from your library will show up here.",
        "showPage('discover', 'movie')",
        "No Movies Matching",
        "No upcoming movies match your search query."
    );
}

// Same TV Shows/Movies segmented-toggle pattern as setLibraryView.
let currentUpcomingView = 'tv';
function setUpcomingView(view) {
    currentUpcomingView = view;

    document.getElementById("upcomingTabTV").classList.toggle("active", view === 'tv');
    document.getElementById("upcomingTabMovies").classList.toggle("active", view === 'movies');

    document.getElementById("upcomingViewTV").style.display = view === 'tv' ? 'block' : 'none';
    document.getElementById("upcomingViewMovies").style.display = view === 'movies' ? 'block' : 'none';

    if (view === 'tv') renderUpcomingTVSection();
    if (view === 'movies') renderUpcomingMovieSection();
}

// Pointer-based swipe-to-dismiss: dragging a card left or right past the
// threshold triggers an action and lets it fly off; a short drag springs
// back. A vertical drag (scrolling) is left alone.
//
// Direction matters: swiping right always marks the up-next episode/movie
// watched (the lightest gray in the scale). Swiping left removes the item
// outright (the darkest) - or, for TV shows with some watched episodes
// already, marks it Stopped Watching instead (a middle gray) so that
// watch history isn't lost. Movies never have partial watch history to
// protect here (Continue Watching only shows unwatched movies), so a
// movie's left-swipe is always a plain removal.
function initContinueCardSwipe(container) {
    const threshold = 90;

    const RIGHT_BG_HTML = `<span>Mark Watched</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const STOP_BG_HTML = `<span>Stop Watching</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
    const REMOVE_BG_HTML = `<span>Remove</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
    const RIGHT_BG_COLOR = "var(--glass-sheen), var(--green-gradient)";
    const STOP_BG_COLOR = "var(--glass-sheen), var(--orange-gradient)";
    const REMOVE_BG_COLOR = "var(--glass-sheen), var(--red-gradient)";

    container.querySelectorAll(".continue-card").forEach(card => {
        let startX = 0, startY = 0, deltaX = 0, dragging = false, axisLocked = null, pointerId = null;
        const leftAction = card.dataset.leftAction; // 'stop' | 'remove' | '' (movies)

        function setBgOpacity(value) {
            const bg = card.parentElement.querySelector(".continue-card-bg");
            if (bg) bg.style.opacity = String(value);
        }

        // Swaps the reveal panel's color/icon/label to match whichever
        // direction is currently being dragged, so the person sees exactly
        // what letting go will do. Justify-content flips with it: a
        // right-swipe reveals this panel on the left of the card (so the
        // label sits flex-start), a left-swipe reveals it on the right
        // (so the label sits flex-end) - matching whichever side of the
        // card actually uncovers.
        function updateBgForDirection(dir) {
            const bg = card.parentElement.querySelector(".continue-card-bg");
            if (!bg) return;
            if (dir === -1 && leftAction) {
                bg.style.background = leftAction === 'stop' ? STOP_BG_COLOR : REMOVE_BG_COLOR;
                bg.innerHTML = leftAction === 'stop' ? STOP_BG_HTML : REMOVE_BG_HTML;
                bg.style.justifyContent = 'flex-end';
            } else {
                bg.style.background = RIGHT_BG_COLOR;
                bg.innerHTML = RIGHT_BG_HTML;
                bg.style.justifyContent = 'flex-start';
            }
        }

        function springBack() {
            card.style.transition = "transform 0.25s cubic-bezier(0.25,1,0.5,1), opacity 0.25s ease";
            card.style.transform = "translateX(0)";
            card.style.opacity = "1";
            setBgOpacity(0);
            card.classList.remove("dragging");
        }

        card.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            dragging = true;
            axisLocked = null;
            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            deltaX = 0;
            card.style.transition = "";
        });

        card.addEventListener("pointermove", (e) => {
            if (!dragging || e.pointerId !== pointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (axisLocked === null) {
                if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
                axisLocked = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
                if (axisLocked === "x") {
                    card.setPointerCapture(pointerId);
                    card.classList.add("dragging");
                }
            }
            if (axisLocked !== "x") return;

            deltaX = dx;
            card.style.transform = `translateX(${deltaX}px)`;
            const progress = Math.min(Math.abs(deltaX) / threshold, 1);
            card.style.opacity = String(1 - progress * 0.35);
            updateBgForDirection(deltaX < 0 ? -1 : 1);
            setBgOpacity(progress);
        });

        function finishDrag() {
            if (!dragging) return;
            dragging = false;

            if (axisLocked !== "x") {
                axisLocked = null;
                return;
            }

            if (Math.abs(deltaX) > threshold) {
                const dir = deltaX < 0 ? -1 : 1;
                card.style.transition = "transform 0.25s ease, opacity 0.25s ease";
                card.style.transform = `translateX(${dir * 500}px)`;
                card.style.opacity = "0";

                const type = card.dataset.type;
                const itemId = card.dataset.itemId;
                const epId = card.dataset.epId;
                setTimeout(() => {
                    if (dir === -1 && leftAction === 'stop') {
                        markShowStoppedById(itemId);
                    } else if (dir === -1 && leftAction === 'remove') {
                        removeLibraryItemById(itemId);
                    } else {
                        markContinueItemWatched(type, itemId, epId);
                    }
                }, 240);
            } else {
                springBack();
            }
            axisLocked = null;
        }

        card.addEventListener("pointerup", finishDrag);
        card.addEventListener("pointercancel", finishDrag);

        card.addEventListener("click", (e) => {
            if (Math.abs(deltaX) > 6) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            openDetails(card.dataset.itemId);
        });
    });
}

async function markContinueItemWatched(type, itemId, epId) {
    const item = getItem(itemId);
    if (!item) return;

    if (type === 'movie') {
        item.watched = true;
        item.lastWatchedAt = new Date().toISOString();
    } else if (item.episodes) {
        const ep = item.episodes.find(e => e.id === epId);
        if (ep) setEpisodeWatched(ep, true);
    }

    await saveItem(item);
    refreshActivePage();

    // How many released-but-unwatched episodes remain for this show,
    // right after marking one watched - a quick, useful "how much is
    // left" signal without having to open the show itself to check.
    // Movie-only items don't have a meaningful "episodes left" concept,
    // so this only fires for TV.
    if (type !== 'movie' && item.episodes) {
        const prog = getTVProgress(item);
        const remaining = prog.total - prog.watched;
        if (remaining > 0) {
            showToast(`${remaining} episode${remaining === 1 ? '' : 's'} left in ${item.title}`, 'success');
        } else {
            // "Up to date" - same word used for the Library category
            // (isTVUpToDate) so this toast and that category always agree
            // on the term for "nothing released left to watch".
            showToast(`${item.title} is up to date!`, 'success');
        }
    }
}

function emptyState(title, message = "Check back later or search for new shows and movies to add.", cta = null) {
    return `
        <div class="empty-state">
            <svg class="icon icon-large" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 8v4l3 3"/>
            </svg>
            <h3>${title}</h3>
            <p>${message}</p>
            ${cta ? `<button class="empty-state-cta" onclick="${cta.onclick}">${cta.label}</button>` : ''}
        </div>
    `;
}

// Loading placeholders for the two content shapes used across the app -
// a row list (search results, episodes) and a 3-column grid (poster
// picker). Sized/laid out to match the real content that replaces them,
// so nothing shifts when it arrives - see the .skeleton-* CSS above.
function skeletonRows(count = 6) {
    return Array.from({ length: count }, () => `
        <div class="skeleton-row">
            <div class="skeleton skeleton-row-thumb"></div>
            <div class="skeleton-row-lines">
                <div class="skeleton skeleton-line" style="width: 55%;"></div>
                <div class="skeleton skeleton-line" style="width: 35%; height: 9px;"></div>
                <div class="skeleton skeleton-line" style="width: 92%;"></div>
                <div class="skeleton skeleton-line" style="width: 68%;"></div>
            </div>
        </div>
    `).join("");
}

function skeletonGrid(count = 9) {
    return `
        <div class="skeleton-grid">
            ${Array.from({ length: count }, () => `<div class="skeleton skeleton-grid-item"></div>`).join("")}
        </div>
    `;
}

/* =========================================================
   HOME UI HANDLING
========================================================= */
function updateHomeUI() {
    let displayName = "";

    // The editable display name (state.profiles[0].name) is now the
    // primary source of truth for what's shown everywhere - separate
    // from the unique, fixed username used only for the reservation
    // itself. Firebase Auth's own user.displayName is just a fallback
    // for the brief window right after sign-in before the profile doc
    // has actually loaded (or if it's somehow missing), not the main
    // source it used to be.
    if (state.profiles && state.profiles[0] && state.profiles[0].name) {
        displayName = state.profiles[0].name;
    } else if (auth && auth.currentUser) {
        const user = auth.currentUser;
        displayName = user.displayName || user.email.split('@')[0];
    } else {
        displayName = "Guest";
    }

    const initial = displayName.charAt(0).toUpperCase() || "G";
    const isSignedIn = !!(auth && auth.currentUser);

    const greetingEl = document.getElementById("homeGreeting");
    if (greetingEl) greetingEl.textContent = isSignedIn ? getTimeOfDayGreeting() : "Welcome";

    const statusDotEl = document.getElementById("avatarStatusDot");
    if (statusDotEl) statusDotEl.classList.toggle("show", isSignedIn);

    const homeNameEl = document.getElementById("homeName");
    if (homeNameEl) homeNameEl.textContent = displayName;

    const homeEmailSub = document.getElementById("homeEmailSubtitle");
    if (homeEmailSub) {
        // Only the display name (homeName above) is shown for a signed-in
        // account now - the email itself is never rendered. The subtitle
        // line stays in use for the guest/logged-out state.
        if (auth && auth.currentUser) {
            homeEmailSub.style.display = "none";
        } else {
            homeEmailSub.style.display = "";
            homeEmailSub.textContent = "Guest Account";
        }
    }

    const largeAvatarEl = document.getElementById("largeAvatar");
    renderAvatarInto(largeAvatarEl, initial);

    // Settings sheet shows the same identity - mirrored rather than shared
    // markup since it's a separate part of the DOM.
    const settingsNameEl = document.getElementById("settingsName");
    if (settingsNameEl) settingsNameEl.textContent = displayName;

    // The username - the fixed, unique handle, distinct from the display
    // name above - shown as a secondary "@handle" line, same idea as
    // display name vs. handle on most social apps. Only ever shown
    // signed-in with a reserved username on file; hidden entirely
    // otherwise (guest, or the brief window before a first-time
    // Google/legacy account has claimed one).
    const settingsUsernameSub = document.getElementById("settingsUsernameSubtitle");
    if (settingsUsernameSub) {
        if (auth && auth.currentUser && state.username) {
            settingsUsernameSub.style.display = "";
            settingsUsernameSub.textContent = `@${state.username}`;
        } else {
            settingsUsernameSub.style.display = "none";
        }
    }

    const settingsEmailSub = document.getElementById("settingsEmailSubtitle");
    if (settingsEmailSub) {
        if (auth && auth.currentUser) {
            settingsEmailSub.style.display = "none";
        } else {
            settingsEmailSub.style.display = "";
            settingsEmailSub.textContent = "Guest Account";
        }
    }

    const settingsAvatarEl = document.getElementById("settingsAvatar");
    renderAvatarInto(settingsAvatarEl, initial);

    // Only cache once there's real, authoritative data worth caching -
    // never for the signed-out/"Guest" pass through this same function,
    // which would otherwise overwrite a genuinely useful cache with
    // nothing the moment someone signs out.
    if (isSignedIn) {
        const avatarId = state.profiles && state.profiles[0] ? state.profiles[0].avatarId : null;
        cacheIdentitySnapshot(displayName, avatarId, state.username || null);
    }
}

/* =========================================================
   EDIT DISPLAY NAME
   Separate from the username on purpose - see the HTML comment on
   #editDisplayNameModal. Reuses the confirm-card pattern (same as
   Delete Account) rather than a full page, since it's a single field.
========================================================= */
function openEditDisplayNameModal() {
    if (!auth || !auth.currentUser) return;
    const modal = document.getElementById("editDisplayNameModal");
    if (modal.classList.contains("open")) return;

    const input = document.getElementById("editDisplayNameInput");
    if (input) {
        input.value = (state.profiles && state.profiles[0] && state.profiles[0].name) || "";
    }
    clearEditDisplayNameError();

    modal.classList.add("open");
    lockBodyScroll("editDisplayNameModal");
    setTimeout(() => input && input.focus(), 50);
}

function closeEditDisplayNameModal() {
    document.getElementById("editDisplayNameModal").classList.remove("open");
    unlockBodyScroll("editDisplayNameModal");
}

function closeEditDisplayNameModalOutside(event) {
    if (event.target.id === "editDisplayNameModal") closeEditDisplayNameModal();
}

function clearEditDisplayNameError() {
    const errEl = document.getElementById("editDisplayNameError");
    if (errEl) {
        errEl.textContent = "";
        errEl.classList.remove("show");
    }
    const input = document.getElementById("editDisplayNameInput");
    if (input) input.classList.remove("input-error");
}

function showEditDisplayNameError(message) {
    const errEl = document.getElementById("editDisplayNameError");
    if (errEl) {
        errEl.textContent = message;
        errEl.classList.add("show");
    }
    const input = document.getElementById("editDisplayNameInput");
    if (input) input.classList.add("input-error");
}

function handleEditDisplayNameKeydown(event) {
    if (event.key === "Enter") saveDisplayName();
}

async function saveDisplayName() {
    if (!auth || !auth.currentUser) return;

    const input = document.getElementById("editDisplayNameInput");
    const name = input ? input.value.trim() : "";

    if (!name) {
        showEditDisplayNameError("Please enter a display name.");
        return;
    }

    const btn = document.getElementById("saveDisplayNameBtn");
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Saving...";
    }

    try {
        if (!state.profiles || state.profiles.length === 0) {
            state.profiles = [{ id: "profile-main", name: name, initials: name.charAt(0).toUpperCase(), avatarId: randomAvatarId() }];
        } else {
            state.profiles[0].name = name;
            state.profiles[0].initials = name.charAt(0).toUpperCase();
            // Defensive, same as the other profile-creation call sites -
            // covers any account that still somehow has no avatarId set.
            if (!state.profiles[0].avatarId) {
                state.profiles[0].avatarId = randomAvatarId();
            }
        }
        await saveUserProfile();

        // Best-effort only - Firebase Auth's own displayName is no longer
        // what the app actually reads (see updateHomeUI), so a failure
        // here shouldn't block saving the name that matters.
        auth.currentUser.updateProfile({ displayName: name }).catch(() => {});

        updateHomeUI();
        closeEditDisplayNameModal();
        showToast("Display name updated!", "success");
    } catch (err) {
        console.error("Display name save FAILED", err);
        showEditDisplayNameError("Couldn't save right now. Please try again.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Save";
        }
    }
}

/* =========================================================
   LISTS
   Each list is { id, name, itemIds, createdAt } in
   users/{uid}/lists/{listId} - itemIds stored on the list itself
   (rather than "which lists" on each library item) so reading a list's
   contents, or reordering it later, is a single document read rather
   than a scan across the whole library. The automatic "Favourites"
   list is deliberately NOT one of these documents - see
   getFavoriteListItems() below - so favoriting something never needs a
   second write to keep a list in sync with it.
========================================================= */
// null while the Create/Rename List modal is open to make a brand new
// list; set to a list's own id while renaming an existing one - the
// one thing that differs between those two flows (see saveList below).
let editingListId = null;

function openCreateListModal() {
    if (!auth || !auth.currentUser) return;
    editingListId = null;
    const modal = document.getElementById("createListModal");
    if (modal.classList.contains("open")) return;

    document.getElementById("createListModalTitle").textContent = "New List";
    const input = document.getElementById("createListInput");
    if (input) input.value = "";
    clearCreateListError();

    modal.classList.add("open");
    lockBodyScroll("createListModal");
    setTimeout(() => input && input.focus(), 50);
}

function openRenameListModal(listId) {
    if (!auth || !auth.currentUser) return;
    const list = state.lists.find(l => l.id === listId);
    if (!list) return;
    editingListId = listId;
    const modal = document.getElementById("createListModal");
    if (modal.classList.contains("open")) return;

    document.getElementById("createListModalTitle").textContent = "Rename List";
    const input = document.getElementById("createListInput");
    if (input) input.value = list.name;
    clearCreateListError();

    modal.classList.add("open");
    lockBodyScroll("createListModal");
    setTimeout(() => input && input.focus(), 50);
}

function closeCreateListModal() {
    document.getElementById("createListModal").classList.remove("open");
    unlockBodyScroll("createListModal");
    editingListId = null;
}

function closeCreateListModalOutside(event) {
    if (event.target.id === "createListModal") closeCreateListModal();
}

function clearCreateListError() {
    const errEl = document.getElementById("createListError");
    if (errEl) {
        errEl.textContent = "";
        errEl.classList.remove("show");
    }
    const input = document.getElementById("createListInput");
    if (input) input.classList.remove("input-error");
}

function showCreateListError(message) {
    const errEl = document.getElementById("createListError");
    if (errEl) {
        errEl.textContent = message;
        errEl.classList.add("show");
    }
    const input = document.getElementById("createListInput");
    if (input) input.classList.add("input-error");
}

function handleCreateListKeydown(event) {
    if (event.key === "Enter") saveList();
}

async function saveList() {
    if (!auth || !auth.currentUser) return;

    const input = document.getElementById("createListInput");
    const name = input ? input.value.trim() : "";

    if (!name) {
        showCreateListError("Please enter a list name.");
        return;
    }

    const btn = document.getElementById("saveListBtn");
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Saving...";
    }

    try {
        const listsRef = db.collection("users").doc(auth.currentUser.uid).collection("lists");

        if (editingListId) {
            const list = state.lists.find(l => l.id === editingListId);
            const previousName = list ? list.name : null;
            // Same reasoning as every other list mutation above -
            // updates the local copy immediately so the Lists row's own
            // card, and this list's own title if its detail view is
            // open underneath, show the new name the instant this
            // returns rather than waiting on a round-trip.
            if (list) list.name = name;
            renderListsRow();
            if (document.getElementById("listDetailModal").classList.contains("open")) {
                renderListDetailContent();
            }
            try {
                await listsRef.doc(editingListId).update({ name });
            } catch (err) {
                if (list) list.name = previousName;
                renderListsRow();
                if (document.getElementById("listDetailModal").classList.contains("open")) {
                    renderListDetailContent();
                }
                throw err;
            }
        } else {
            const newRef = listsRef.doc();
            // If this list is being created from within the Add to List
            // picker (rather than Library's own "+ New"), the whole
            // reason someone got here was to add THIS item somewhere -
            // creating an empty list and making them tap "Add" a second
            // time for the item they came here to add would be
            // pointless friction, so it's included at creation time
            // instead of a separate follow-up step.
            const pickerOpen = document.getElementById("listPickerModal").classList.contains("open");
            const initialItemIds = (pickerOpen && currentItem) ? [currentItem.id] : [];
            const newList = { id: newRef.id, name, itemIds: initialItemIds, createdAt: new Date().toISOString() };
            // newRef.id is a real, permanent id generated client-side by
            // the SDK, not a placeholder - Firestore always assigns the
            // document's id up front, before the write is ever sent, so
            // this is safe to add locally right away rather than
            // waiting for the write to come back with an id to use.
            state.lists.push(newList);
            renderListsRow();
            try {
                await newRef.set(newList);
            } catch (err) {
                state.lists = state.lists.filter(l => l.id !== newRef.id);
                renderListsRow();
                throw err;
            }
        }

        closeCreateListModal();
        showToast(editingListId ? "List renamed!" : "List created!", "success");
    } catch (err) {
        console.error("List save FAILED", err);
        showCreateListError(`Couldn't save right now (${err.code || err.message || 'unknown error'}).`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Save";
        }
    }
}

async function deleteList(listId) {
    if (!auth || !auth.currentUser) return false;
    const index = state.lists.findIndex(l => l.id === listId);
    const removed = index !== -1 ? state.lists[index] : null;
    // Same optimistic-local-update reasoning as add/removeItemFromList
    // above - removes it from the local copy immediately rather than
    // waiting on a round-trip, so the Lists row (and Reorder Lists, if
    // that's where this was triggered from) drops the card the instant
    // this returns.
    if (removed) state.lists.splice(index, 1);
    renderListsRow();

    try {
        await db.collection("users").doc(auth.currentUser.uid).collection("lists").doc(listId).delete();
        showToast("List deleted.", "success");
        return true;
    } catch (err) {
        console.error("List delete FAILED", err);
        showErrorToast(`Couldn't delete this list (${err.code || err.message || 'unknown error'}).`);
        // Rolls the optimistic removal back out on a genuine failure,
        // at its original position rather than just appended to the
        // end - otherwise the list would keep looking deleted even
        // though the server never actually removed it.
        if (removed) {
            state.lists.splice(index, 0, removed);
            renderListsRow();
        }
        return false;
    }
}

// Both add/remove read the list's current itemIds straight from
// state.lists (already kept live by the onSnapshot listener - see
// proceedToApp) rather than re-fetching, then write the whole updated
// array back. Lists are small enough (a handful of shows/movies, not
// hundreds of library items) that this is simpler and plenty fast,
// unlike the library's own more careful merge/dedupe handling.
async function addItemToList(listId, itemId) {
    if (!auth || !auth.currentUser) return;
    const list = state.lists.find(l => l.id === listId);
    if (!list) return;
    if (list.itemIds.includes(itemId)) return;

    const previousItemIds = list.itemIds;
    const itemIds = [...list.itemIds, itemId];
    // Same reasoning as removeItemFromList's own local update above -
    // updates the local copy immediately, before the write, so anything
    // reading state.lists (the Lists row's card, this list's own
    // checkbox state in the Add to List picker) is correct the instant
    // this function returns rather than waiting on a round-trip.
    list.itemIds = itemIds;
    renderListsRow();

    try {
        await db.collection("users").doc(auth.currentUser.uid).collection("lists").doc(listId).update({ itemIds });
        showToast(`Added to "${list.name}".`, "success");
    } catch (err) {
        console.error("Add to list FAILED", err);
        showErrorToast(`Couldn't add this to the list (${err.code || err.message || 'unknown error'}).`);
        // Rolls the optimistic update back out on a genuine failure -
        // otherwise the checkbox/card would keep showing the item as
        // added even though the server never actually got the change.
        list.itemIds = previousItemIds;
        renderListsRow();
    }
}

async function removeItemFromList(listId, itemId) {
    if (!auth || !auth.currentUser) return;
    const list = state.lists.find(l => l.id === listId);
    if (!list) return;

    const previousItemIds = list.itemIds;
    const itemIds = list.itemIds.filter(id => id !== itemId);
    // Updates the local copy immediately, before the write below - the
    // Lists row and this modal's own grid both read straight from
    // state.lists, so without this they'd keep showing the pre-removal
    // count/items until the onSnapshot listener round-trips back with
    // the server's confirmation, even though Firestore's local-write
    // behavior usually makes that fast. Setting it directly here means
    // the UI is correct the instant this function returns, not "usually
    // fast" - genuinely not dependent on listener timing at all.
    list.itemIds = itemIds;

    try {
        await db.collection("users").doc(auth.currentUser.uid).collection("lists").doc(listId).update({ itemIds });
    } catch (err) {
        console.error("Remove from list FAILED", err);
        showErrorToast(`Couldn't remove this from the list (${err.code || err.message || 'unknown error'}).`);
        // Rolls the optimistic update back out on a genuine failure
        // (not Firestore's own offline retry queue, which resolves on
        // its own once connectivity returns) - otherwise the screen
        // would keep showing the item as removed even though the
        // server never actually got the change.
        list.itemIds = previousItemIds;
        renderListDetailContent();
        renderListsRow();
    }
}

// Resolves a list's stored itemIds into the actual current library item
// objects - filters out any id that no longer matches anything (the
// item was removed from the library entirely since being added to this
// list) rather than showing a broken/blank card for it.
function getListItems(listId) {
    const list = state.lists.find(l => l.id === listId);
    if (!list) return [];
    return list.itemIds
        .map(id => state.library.find(i => i.id === id))
        .filter(Boolean);
}

// The automatic Favourites "list" - deliberately not a real document
// (see the LISTS block comment above), just every library item with
// isFavorite set, computed fresh every time rather than tracked
// separately.
// Most recently favorited first - not just "everything with isFavorite
// set" in whatever order state.library happens to be in. The Favourites
// list card's auto-picked backdrop (see createListCard) depends on this
// order specifically: it always wants the most recent favorite that has
// a backdrop, and unfavoriting that one should correctly fall back to
// whichever favorite is now the most recent, not an arbitrary one.
function getFavoriteListItems() {
    return state.library
        .filter(i => i.isFavorite)
        .sort((a, b) => new Date(b.favoritedAt || 0) - new Date(a.favoritedAt || 0));
}

/* =========================================================
   LIST DETAIL
========================================================= */
// null while viewing the automatic Favourites list, since it isn't a
// real document with an id - checked throughout below instead of
// tracking a separate boolean, so there's exactly one source of truth
// for "which list, if any, is currently open".
let currentListDetailId = null;

function openListDetailModal(listId, isFavorites) {
    currentListDetailId = isFavorites ? null : listId;
    const modal = document.getElementById("listDetailModal");
    if (modal.classList.contains("open")) return;

    // Rename/Delete/Share only make sense for a real list document, so
    // those three stay hidden for the automatic Favourites list -
    // Backdrop is the one exception now, since it works for Favourites
    // too (see openListBackdropPicker/selectListBackdrop, which save its
    // choice on the user's own account document instead of a list
    // document that doesn't exist for Favourites). The row container
    // itself always stays visible, since Backdrop alone is enough to
    // justify it - only individual buttons within it toggle.
    document.getElementById("listDetailShareBtn").style.display = isFavorites ? "none" : "";
    document.getElementById("listDetailRenameBtn").style.display = isFavorites ? "none" : "";
    document.getElementById("listDetailDeleteBtn").style.display = isFavorites ? "none" : "";

    renderListDetailContent();
    modal.classList.add("open");
    lockBodyScroll("listDetailModal");
}

function closeListDetailModal() {
    document.getElementById("listDetailModal").classList.remove("open");
    unlockBodyScroll("listDetailModal");
}

function closeListDetailModalOutside(event) {
    if (event.target.id === "listDetailModal") closeListDetailModal();
}

function renderListDetailContent() {
    const isFavorites = !currentListDetailId;
    const list = isFavorites ? null : state.lists.find(l => l.id === currentListDetailId);
    if (!isFavorites && !list) {
        // The list was deleted (from another device, or this one)
        // while its detail view happened to be open - close rather
        // than show a broken, list-less screen.
        closeListDetailModal();
        return;
    }

    document.getElementById("listDetailTitle").textContent = isFavorites ? "Favourites" : list.name;

    const items = isFavorites ? getFavoriteListItems() : getListItems(currentListDetailId);
    const grid = document.getElementById("listDetailGrid");
    if (items.length > 0) {
        syncCardGrid(grid, items, item => createListDetailCard(item, currentListDetailId, isFavorites));
    } else {
        grid.innerHTML = emptyState(
            isFavorites ? "No Favourites Yet" : "Nothing in This List Yet",
            isFavorites ? "Favorite a show or movie from its details to see it here." : "Add shows or movies to this list from their details."
        );
    }
}

// A simpler, separate render from the shared createCard() used
// everywhere else - deliberately doesn't wire up createCard's own
// long-press/swipe gesture handling here, since that gesture means
// "remove from the library entirely" elsewhere, which would be the
// wrong action to trigger by accident in a context that's specifically
// about list membership, not library membership. Tapping the poster
// opens the item normally; the small corner button removes it from
// just this list (or unfavorites it, for Favourites) without touching
// whether it's still in the library at all.
function createListDetailCard(item, listId, isFavorites) {
    const hasPoster = item.poster && item.poster.trim() !== "";
    const placeholderIcon = item.type === 'movie'
        ? `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M2 7l4-4h3l-4 4H2z"/><path d="M11 7l4-4h3l-4 4h-3z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`
        : `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>`;

    const removeOnclick = isFavorites
        ? `event.stopPropagation(); unfavoriteFromListDetail('${item.id}')`
        : `event.stopPropagation(); removeItemFromListDetail('${listId}', '${item.id}')`;

    return `
        <div class="card" data-id="${item.id}" onclick="openDetails('${item.id}')">
            <div class="poster">
                ${hasPoster ? `
                    <img src="${tmdbThumb(item.poster, 'w342')}" alt="${escapeHTML(item.title)}" draggable="false" loading="lazy" decoding="async" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="poster-placeholder" style="display: none;">${placeholderIcon}</div>
                ` : `
                    <div class="poster-placeholder">${placeholderIcon}</div>
                `}
                <button class="list-detail-remove-btn" onclick="${removeOnclick}" aria-label="Remove">
                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
                </button>
            </div>
        </div>
    `;
}

async function removeItemFromListDetail(listId, itemId) {
    await removeItemFromList(listId, itemId);
    renderListDetailContent();
    // The Lists row on Library's home page (the card's own item count
    // and auto-picked backdrop, if it's not showing a custom one) is a
    // separate render pass from this modal's own grid above - without
    // calling it directly here too, that card would keep showing its
    // pre-removal count/backdrop until something else happened to
    // trigger a re-render (navigating away and back, or the Firestore
    // listener eventually catching up), rather than updating the
    // moment the removal actually happens.
    renderListsRow();
}

async function unfavoriteFromListDetail(itemId) {
    const item = state.library.find(i => i.id === itemId);
    if (!item) return;
    item.isFavorite = false;
    await saveItem(item);
    renderListDetailContent();
    // Same reasoning as removeItemFromListDetail above - Favourites'
    // own card on the Lists row needs the same direct, immediate update.
    renderListsRow();
}

// A list's chosen backdrop is only ever one of its own members' own
// backdrop images - picked here, from whatever's already in the list,
// rather than any kind of upload or external image search. Works for
// the automatic Favourites list too (currentListDetailId is null while
// viewing it, the same check used throughout Lists) - Favourites has no
// list document to store this on, so its choice is saved on the user's
// own account document instead (see selectListBackdrop below), which
// state's own boot-time load already spreads directly into state, so
// no separate fetch is needed to read it back.
// Every backdrop TMDB actually has for each item in the list, not just
// the single one saved on it - reuses fetchItemImages(), the same
// per-title alternate-image gallery the poster/backdrop picker for an
// individual show already pulls from. Fetched in parallel (not one
// request after another) so opening this for a list with several items
// doesn't feel like it's loading each one in sequence. Capped at 8
// backdrops per item - some titles have dozens of alternates on TMDB,
// and showing every single one for every item in a larger list would
// make the grid unmanageably long for a marginal amount of extra
// choice.
async function openListBackdropPicker() {
    const isFavorites = !currentListDetailId;
    const items = isFavorites ? getFavoriteListItems() : getListItems(currentListDetailId);
    const grid = document.getElementById("listBackdropPickerGrid");
    const modal = document.getElementById("listBackdropPickerModal");

    if (items.length === 0) {
        grid.innerHTML = emptyState("No Backdrops Available", "Add something to this list first.");
    } else {
        grid.innerHTML = emptyState("Loading Backdrops...", "Fetching every available image for what's in this list.");
    }
    if (!modal.classList.contains("open")) {
        modal.classList.add("open");
        lockBodyScroll("listBackdropPickerModal");
    }
    if (items.length === 0) return;

    const galleries = await Promise.all(items.map(item => fetchItemImages(item.tmdbId, item.type)));
    const options = [];
    items.forEach((item, i) => {
        const backdrops = galleries[i].backdrops.slice(0, 8);
        backdrops.forEach(img => options.push({ title: item.title, thumb: img.thumb, full: img.full }));
    });

    if (options.length === 0) {
        grid.innerHTML = emptyState("No Backdrops Available", "Nothing in this list has a backdrop image available.");
        return;
    }

    // The backdrop URL travels via a data attribute, not interpolated
    // directly into the onclick string - escapeHTML() is the right
    // tool for embedding it as an HTML attribute value (which this
    // is), not for safely embedding it inside a JS string literal
    // (which the previous version effectively needed, since the URL
    // was interpolated straight into onclick="selectListBackdrop('...')").
    // The browser handles decoding a data attribute back to its
    // original value automatically when read via .dataset, so this
    // sidesteps that whole class of escaping mismatch entirely
    // rather than trying to pick the "correct" escaping for a JS
    // string context by hand.
    grid.innerHTML = options.map(opt => `
        <button class="poster-picker-item" data-backdrop="${escapeHTML(opt.full)}" onclick="selectListBackdrop(this.dataset.backdrop)" aria-label="${escapeHTML(opt.title)}">
            <img src="${opt.thumb}" alt="${escapeHTML(opt.title)}" loading="lazy" decoding="async">
        </button>
    `).join("");
}

function closeListBackdropPicker() {
    document.getElementById("listBackdropPickerModal").classList.remove("open");
    unlockBodyScroll("listBackdropPickerModal");
}

function closeListBackdropPickerOutside(event) {
    if (event.target.id === "listBackdropPickerModal") closeListBackdropPicker();
}

async function selectListBackdrop(backdropUrl) {
    if (!auth || !auth.currentUser) return;
    const isFavorites = !currentListDetailId;
    try {
        if (isFavorites) {
            await db.collection("users").doc(auth.currentUser.uid).update({ favoritesBackdropUrl: backdropUrl });
            state.favoritesBackdropUrl = backdropUrl;
            refreshActivePage();
        } else {
            const list = state.lists.find(l => l.id === currentListDetailId);
            await db.collection("users").doc(auth.currentUser.uid).collection("lists").doc(currentListDetailId).update({ backdropUrl });
            // Was missing entirely for the non-Favourites branch - the
            // write succeeded, but nothing told the Lists row's own
            // card to actually show the new backdrop, so it would keep
            // showing the old one until something else happened to
            // trigger a re-render (navigating away and back, or the
            // Firestore listener eventually catching up). Setting the
            // local copy directly here, same as the optimistic updates
            // in add/removeItemFromList, means it's correct the instant
            // this returns rather than depending on that round-trip.
            if (list) list.backdropUrl = backdropUrl;
            renderListsRow();
        }
        closeListBackdropPicker();
    } catch (err) {
        // Surfaces the real Firestore error code (e.g. "permission-denied"
        // if the lists subcollection is missing its own security rule -
        // see the README's note on this) rather than a generic message,
        // so a failure here is actually diagnosable from what shows on
        // screen instead of needing a console dump to explain it.
        console.error("Set list backdrop FAILED", err);
        showErrorToast(`Couldn't set that backdrop (${err.code || err.message || 'unknown error'}).`);
    }
}

function confirmDeleteCurrentList() {
    if (!currentListDetailId) return;
    const list = state.lists.find(l => l.id === currentListDetailId);
    if (!list) return;
    document.getElementById("deleteListTitle").textContent = `Delete "${list.name}"?`;
    const modal = document.getElementById("deleteListModal");
    modal.classList.add("open");
    lockBodyScroll("deleteListModal");
}

function closeDeleteListModal() {
    document.getElementById("deleteListModal").classList.remove("open");
    unlockBodyScroll("deleteListModal");
}

function closeDeleteListModalOutside(event) {
    if (event.target.id === "deleteListModal") closeDeleteListModal();
}

async function executeDeleteCurrentList() {
    if (!currentListDetailId) return;
    const succeeded = await deleteList(currentListDetailId);
    closeDeleteListModal();
    // Was unconditional - closing the list's own detail view even when
    // the delete genuinely failed made it look like it had succeeded,
    // right as an error toast was telling the person otherwise. Now
    // only closes it on a real success, leaving them on the list they
    // tried to delete (still there, per deleteList's own rollback)
    // rather than dropped back to Library with no clear sense of
    // whether anything actually happened.
    if (succeeded) closeListDetailModal();
}

/* =========================================================
   DETAILS MODAL & TRAILERS
========================================================= */
async function playTrailer(tmdbId, type) {
    showToast("Finding trailer...");
    try {
        const endpoint = type === 'movie' 
            ? `https://api.themoviedb.org/3/movie/${tmdbId}/videos?api_key=${TMDB_API_KEY}`
            : `https://api.themoviedb.org/3/tv/${tmdbId}/videos?api_key=${TMDB_API_KEY}`;

        const res = await fetch(endpoint);
        const data = await res.json();

        if (!res.ok) {
            console.warn(`TMDB videos request failed (${res.status}):`, data?.status_message || data);
            showErrorToast("Could not load trailer.");
            return;
        }

        const trailer = (data.results || []).find(v => v.site === "YouTube" && v.type === "Trailer");

        if (trailer) {
            window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank');
        } else {
            showErrorToast("No official trailer found.");
        }
    } catch (err) {
        console.error("Error playing trailer:", err);
        showErrorToast("Could not load trailer.");
    }
}

async function addModalItemToLibrary() {
    if (!currentItem) return;
    if (state.library.some(s => s.tmdbId === currentItem.tmdbId)) return;
    
    const btn = document.getElementById('modalAddLibBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Adding...";
    }
    
    await importMediaData(currentItem.tmdbId, currentItem.type);
    
    const newItem = state.library.find(s => s.tmdbId === currentItem.tmdbId);
    if (newItem) {
        currentItem = newItem;
    }
    updateModalContent();
}

// Shares the item currently open in the details modal via the native share
// sheet where available (mobile browsers), falling back to copying a
// shareable link to the clipboard on desktop/unsupported browsers. The
// share always points back to NovaWatch itself (not TMDB) - it's the app
// being shared from.
// Handles a PWA install shortcut (long-press/right-click the installed
// app icon -> Discover/Library/Upcoming) - jumps straight to that tab
// right after the normal Home landing, same pattern as
// openSharedItemFromURL() below for shared show/movie links. An
// unrecognized or missing value just leaves the normal Home landing
// alone. Strips the param afterward so refreshing doesn't keep re-jumping.
function openShortcutTabFromURL() {
    const params = new URLSearchParams(window.location.search);
    const shortcut = params.get('shortcut');
    if (!['discover', 'library', 'upcoming'].includes(shortcut)) return;

    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    showPage(shortcut);
}

// Reads a shared item link from the URL, if present, and opens the right
// thing directly - this is what makes a shared link actually take the
// recipient to the specific show/movie/episode/list instead of just the
// app's home screen. Shapes:
//   ?share_type=tv|movie&share_id=<tmdbId>              - a show or movie
//   ?share_type=episode&share_id=<showTmdbId>&share_ep=sXeY - one episode
//   ?share_type=list&share_id=<sharedListDocId>          - a shared list
// Returns true if a shared item was found and opened, so the caller can
// skip anything (like a generic "Welcome back!" toast) that would
// otherwise talk over it.
function openSharedItemFromURL() {
    const params = new URLSearchParams(window.location.search);
    const type = params.get('share_type');
    const id = params.get('share_id');
    const epId = params.get('share_ep');

    const isEpisodeShare = type === 'episode' && id && !isNaN(Number(id)) && epId && /^s\d+e\d+$/.test(epId);
    const isItemShare = (type === 'tv' || type === 'movie') && id && !isNaN(Number(id));
    // A shared list's id is a Firestore auto-id (opaque string), not a
    // numeric TMDB id like the other two share shapes - no numeric check
    // here, just that something was actually provided.
    const isListShare = type === 'list' && !!id;
    if (!isEpisodeShare && !isItemShare && !isListShare) return false;

    // Strip the params so refreshing or navigating within the app doesn't
    // keep reopening the same shared item.
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);

    if (isEpisodeShare) {
        openSharedEpisode(Number(id), epId);
    } else if (isListShare) {
        openSharedList(id);
    } else {
        openSearchResultDetails(Number(id), type);
    }
    return true;
}

// A shared episode link opens its parent show first (same preview/library
// path as a normal show link), then once the show's episode list has
// actually loaded, opens that specific episode's modal on top of it - a
// single episode isn't independently addressable without its show's
// context, so this is really "open the show, then drill in."
async function openSharedEpisode(showTmdbId, epId) {
    await openSearchResultDetails(showTmdbId, 'tv');
    if (!currentItem || currentItem.tmdbId !== showTmdbId) return;

    const episode = (currentItem.episodes || []).find(e => e.id === epId);
    if (episode) {
        selectedSeason = episode.season;
        updateModalContent();
        openEpisodeDetails(epId);
        return;
    }

    // Preview shows fetch their episode list progressively in the
    // background (see openSearchResultDetails) - if it's not there yet,
    // wait for it rather than silently failing to open the episode.
    let attempts = 0;
    const waitForEpisode = setInterval(() => {
        attempts++;
        if (!currentItem || currentItem.tmdbId !== showTmdbId) {
            clearInterval(waitForEpisode);
            return;
        }
        const ep = (currentItem.episodes || []).find(e => e.id === epId);
        if (ep) {
            clearInterval(waitForEpisode);
            selectedSeason = ep.season;
            updateModalContent();
            openEpisodeDetails(epId);
        } else if (attempts > 20 || !currentItem.episodesLoading) {
            clearInterval(waitForEpisode);
        }
    }, 300);
}

// Backs the Word of Mouth achievement - set the first time any share
// genuinely succeeds (the native share sheet completing, or a clipboard
// copy landing), across any of the three share functions below (a show/
// movie, an episode, or a list). Persisted on the account document like
// favoritesBackdropUrl/favoritesOrder, so it's a real, permanent
// account-wide fact once true, not something that resets per device or
// session. Guarded so it only ever writes once - nothing else depends
// on this being current beyond "has this ever happened", so there's no
// reason to touch it again after the first time.
async function markHasShared() {
    if (state.hasSharedSomething || !auth || !auth.currentUser) return;
    state.hasSharedSomething = true;
    try {
        await db.collection("users").doc(auth.currentUser.uid).update({ hasSharedSomething: true });
        checkAchievements();
    } catch (err) {
        console.error("Mark hasShared FAILED", err);
    }
}

async function shareCurrentItem() {
    if (!currentItem || !currentItem.tmdbId) return;

    const kind = currentItem.type === 'movie' ? 'movie' : 'TV show';
    const type = currentItem.type === 'movie' ? 'movie' : 'tv';
    const deepLink = `${NOVAWATCH_APP_URL}?share_type=${type}&share_id=${currentItem.tmdbId}`;

    const shareData = {
        title: `${currentItem.title} - NovaWatch`,
        text: `I'm tracking the ${kind} "${currentItem.title}" on NovaWatch - check it out!`,
        url: deepLink
    };

    if (navigator.share) {
        try {
            await navigator.share(shareData);
            markHasShared();
        } catch (err) {
            if (err.name !== 'AbortError') console.error("Share failed:", err);
        }
        return;
    }

    if (navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
            showToast("Link copied to clipboard!", "success");
            markHasShared();
        } catch (err) {
            console.error("Clipboard write failed:", err);
            showErrorToast("Unable to share.");
        }
        return;
    }

    showErrorToast("Sharing isn't supported on this device.");
}

async function shareCurrentEpisode() {
    if (!currentItem || !currentEpisode || !currentItem.tmdbId) return;

    const deepLink = `${NOVAWATCH_APP_URL}?share_type=episode&share_id=${currentItem.tmdbId}&share_ep=${currentEpisode.id}`;
    const episodeLabel = `S${currentEpisode.season} E${currentEpisode.number}`;

    const shareData = {
        title: `${currentItem.title} ${episodeLabel} - NovaWatch`,
        text: `I'm tracking "${currentItem.title}" (${episodeLabel}: ${currentEpisode.title}) on NovaWatch - check it out!`,
        url: deepLink
    };

    if (navigator.share) {
        try {
            await navigator.share(shareData);
            markHasShared();
        } catch (err) {
            if (err.name !== 'AbortError') console.error("Share failed:", err);
        }
        return;
    }

    if (navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
            showToast("Link copied to clipboard!", "success");
            markHasShared();
        } catch (err) {
            console.error("Clipboard write failed:", err);
            showErrorToast("Unable to share.");
        }
        return;
    }

    showErrorToast("Sharing isn't supported on this device.");
}

// Sharing a list is fundamentally different from sharing a show/movie/
// episode above - those point at public TMDB data, so there's nothing to
// protect and the deep link alone is enough. A list is private data
// behind Firestore rules (only the owner can read users/{uid}/lists/*),
// so a friend's account could never read it directly even with the
// right link. Instead this writes a lightweight, standalone, PUBLIC
// snapshot to its own top-level sharedLists collection - just the list's
// name and a plain array of {tmdbId, type, title, poster} for whatever
// was in it at share time, decoupled entirely from the owner's private
// library/lists structure. That needs its own separate Firestore rule
// (see README) - readable by anyone with the exact link, but never
// listable/browsable, and writable by any signed-in account (creating a
// snapshot of a list you own, not modifying anyone else's data). A
// snapshot is immutable once created - if the original list changes
// later, an already-shared link keeps showing what it looked like at
// share time, the same reasonable tradeoff most "share a copy" features
// make elsewhere.
async function shareCurrentList() {
    if (!currentListDetailId || !auth || !auth.currentUser) return;
    const list = state.lists.find(l => l.id === currentListDetailId);
    if (!list) return;

    const items = getListItems(currentListDetailId);
    if (items.length === 0) {
        showErrorToast("Add something to this list before sharing it.");
        return;
    }

    try {
        const snapshot = {
            name: list.name,
            items: items.map(i => ({
                tmdbId: i.tmdbId,
                type: i.type,
                title: i.title,
                poster: i.poster || null
            })),
            createdAt: new Date().toISOString()
        };
        const docRef = await db.collection("sharedLists").add(snapshot);
        const deepLink = `${NOVAWATCH_APP_URL}?share_type=list&share_id=${docRef.id}`;

        const shareData = {
            title: `${list.name} - NovaWatch`,
            text: `Check out my "${list.name}" list on NovaWatch!`,
            url: deepLink
        };

        if (navigator.share) {
            try {
                await navigator.share(shareData);
                markHasShared();
            } catch (err) {
                if (err.name !== 'AbortError') console.error("Share failed:", err);
            }
            return;
        }

        if (navigator.clipboard) {
            try {
                await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
                showToast("Link copied to clipboard!", "success");
                markHasShared();
            } catch (err) {
                console.error("Clipboard write failed:", err);
                showErrorToast("Unable to share.");
            }
            return;
        }

        showErrorToast("Sharing isn't supported on this device.");
    } catch (err) {
        console.error("Share list FAILED", err);
        showErrorToast(`Couldn't share this list (${err.code || err.message || 'unknown error'}).`);
    }
}

// Opens a shared list from a deep link - a plain, read-only viewer, not
// the same List Detail modal an owner sees. There's no rename/delete/
// remove/backdrop here at all, since the viewer doesn't own this list
// and the snapshot has no such data anyway; tapping an item just opens
// the normal Details preview for it (openSearchResultDetails, the same
// path a shared show/movie link already used), so the recipient can add
// it to their own library the ordinary way.
async function openSharedList(shareId) {
    try {
        const doc = await db.collection("sharedLists").doc(shareId).get();
        if (!doc.exists) {
            showErrorToast("This shared list link isn't valid anymore.");
            return;
        }
        const data = doc.data();
        document.getElementById("sharedListTitle").textContent = data.name || "Shared List";

        const grid = document.getElementById("sharedListGrid");
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
            grid.innerHTML = emptyState("Empty List", "This list didn't have anything in it when it was shared.");
        } else {
            grid.innerHTML = items.map(item => {
                const hasPoster = item.poster && item.poster.trim() !== "";
                const placeholderIcon = item.type === 'movie'
                    ? `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M2 7l4-4h3l-4 4H2z"/><path d="M11 7l4-4h3l-4 4h-3z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`
                    : `<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>`;
                return `
                    <div class="card" onclick="openSearchResultDetails(${item.tmdbId}, '${item.type}')">
                        <div class="poster">
                            ${hasPoster ? `
                                <img src="${tmdbThumb(item.poster, 'w342')}" alt="${escapeHTML(item.title)}" draggable="false" loading="lazy" decoding="async" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                <div class="poster-placeholder" style="display: none;">${placeholderIcon}</div>
                            ` : `
                                <div class="poster-placeholder">${placeholderIcon}</div>
                            `}
                        </div>
                    </div>
                `;
            }).join("");
        }

        const modal = document.getElementById("sharedListModal");
        if (!modal.classList.contains("open")) {
            modal.classList.add("open");
            lockBodyScroll("sharedListModal");
        }
    } catch (err) {
        console.error("Open shared list FAILED", err);
        showErrorToast("Couldn't open this shared list.");
    }
}

function closeSharedListModal() {
    document.getElementById("sharedListModal").classList.remove("open");
    unlockBodyScroll("sharedListModal");
}

function closeSharedListModalOutside(event) {
    if (event.target.id === "sharedListModal") closeSharedListModal();
}

function openDetails(itemId) {
    currentItem = getItem(itemId);
    if (!currentItem) return;

    if (currentItem.type !== 'movie' && currentItem.episodes) {
        selectedSeason = getCurrentSeasonForShow(currentItem);
        scrollToNextEpisodeOnRender = true;
    }

    updateModalContent();
    const detailsModal = document.getElementById("detailsModal");
    if (!detailsModal.classList.contains("open")) {
        detailsModal.classList.add("open");
        lockBodyScroll("detailsModal");
    }
    loadWatchAvailability(currentItem);

    // Cached data renders immediately above; quietly pull the latest TMDB
    // data for this one item so the modal never shows stale info while
    // waiting on the periodic background sync.
    refreshOpenItemFromTMDB(currentItem);
}

async function refreshOpenItemFromTMDB(item) {
    if (!item || !item.tmdbId) return;

    const result = await refreshItemFromTMDB(item);

    // The user may have closed the modal or opened a different item while
    // this was in flight — only act if they're still looking at it.
    if (!currentItem || currentItem.id !== item.id) return;

    if (result.changed) {
        if (currentItem.type !== 'movie' && currentItem.episodes) {
            const availableSeasons = [...new Set(currentItem.episodes.map(ep => ep.season))].sort((a, b) => a - b);
            if (!availableSeasons.includes(selectedSeason) && availableSeasons.length > 0) {
                selectedSeason = availableSeasons[0];
            }
        }
        updateModalContent();
    } else if (result.failed) {
        // Quiet, honest heads-up rather than silently showing possibly-stale
        // info with no explanation - only shown for this direct, user-facing
        // refresh, never for the silent background sync loop.
        showErrorToast("Couldn't reach TMDB - showing saved info.");
    }
}

function closeModal() {
    document.getElementById("detailsModal").classList.remove("open");
    unlockBodyScroll("detailsModal");
    currentItem = null;
    refreshActivePage();
}

function closeModalOutside(event) {
    if (event.target.id === "detailsModal") {
        closeModal();
    }
}

function updateModalContent() {
    if (!currentItem) return;

    // Movies never have more content than a poster/backdrop, meta, and a
    // description - never enough to justify forcing the full screen, so
    // they get the same compact/content-sized card treatment as the
    // episode modal. TV shows keep the full-screen treatment since their
    // episode list can run long regardless of the show's own description
    // length.
    const detailsModalEl = document.getElementById("detailsModal");
    const detailsSheetEl = detailsModalEl.querySelector(".modal-sheet");
    detailsModalEl.classList.toggle("modal-compact", currentItem.type === 'movie');
    detailsSheetEl.classList.toggle("modal-sheet-compact", currentItem.type === 'movie');

    const backdropHeader = document.getElementById("modalBackdropHeader");
    const backdropUrl = currentItem.backdrop || currentItem.poster;
    if (backdropUrl) {
        backdropHeader.style.backgroundImage = `url('${backdropUrl}')`;
    } else {
        backdropHeader.style.backgroundImage = `none`;
        backdropHeader.style.backgroundColor = `var(--surface-2)`;
    }

    document.getElementById("modalTitle").textContent = currentItem.title;

    // Reflects favorite state whenever the modal opens for a different
    // item or after toggling it - "filled" reads as favorited without
    // needing separate on/off icon artwork, the same fill-vs-outline
    // convention most apps already use for this. The label swaps too
    // (Favorite/Unfavorite), not just the icon - the chip has room for
    // a word, so it should say what tapping it will actually do next,
    // not require already knowing the fill/outline convention to tell.
    const favBtn = document.getElementById("modalFavoriteBtn");
    if (favBtn) {
        favBtn.classList.toggle("favorited", !!currentItem.isFavorite);
        favBtn.querySelector("svg").setAttribute("fill", currentItem.isFavorite ? "currentColor" : "none");
        document.getElementById("modalFavoriteBtnLabel").textContent = currentItem.isFavorite ? "Unfavorite" : "Favorite";
    }

    let metaHTML = "";

    const ratingHTML = currentItem.rating ? `<span>•</span><span>★ ${escapeHTML(currentItem.rating)}</span>` : '';
    // Boxed badge rather than plain bulleted text - see .content-rating-badge.
    // Shown for both movies and TV, since fetchContentRating() covers both.
    const contentRatingHTML = currentItem.contentRating ? `<span>•</span><span class="content-rating-badge">${escapeHTML(currentItem.contentRating)}</span>` : '';

    if (currentItem.type === 'movie') {
        const releaseDateStr = currentItem.releaseDate ? formatDateWithReleaseTime(currentItem.releaseDate) : 'TBA';
        metaHTML = `
            <span>${currentItem.year || 'N/A'}</span>
            <span>•</span>
            <span style="text-transform:uppercase;">Movie</span>
            <span>•</span>
            <span>${currentItem.runtime || '120 min'}</span>
            <span>•</span>
            <span>${releaseDateStr}</span>
            ${contentRatingHTML}
            ${ratingHTML}
        `;
        if (currentItem.watched) {
            const watchedDateStr = currentItem.lastWatchedAt
                ? formatDate(currentItem.lastWatchedAt)
                : 'Date unavailable';
            metaHTML += `<span>•</span><span style="color: var(--success); font-weight:700;">Watched ${escapeHTML(watchedDateStr)}</span>`;
            if (isCurrentItemInLibrary()) {
                metaHTML += `<span>•</span><span class="rewatch-count-tap" onclick="event.stopPropagation(); openMovieRewatchPopup()">Rewatched \u00d7${currentItem.rewatchCount || 0}</span>`;
            }
        }
    } else {
        const prog = getTVProgress(currentItem);
        const statusHTML = currentItem.status ? `<span>•</span><span>${escapeHTML(currentItem.status)}</span>` : '';
        const showRewatches = (currentItem.episodes || []).reduce((sum, ep) => sum + (ep.rewatchCount || 0), 0);
        const rewatchHTML = showRewatches > 0 ? `<span>•</span><span style="color: var(--blue-light); font-weight:700;">${showRewatches} Rewatch${showRewatches === 1 ? '' : 'es'}</span>` : '';
        metaHTML = `
            <span>${currentItem.year || 'N/A'}</span>
            <span>•</span>
            <span style="text-transform:uppercase;">TV Show</span>
            <span>•</span>
            <span>${prog.watched}/${prog.total} Episodes Watched (${prog.percentage}%)</span>
            ${statusHTML}
            ${contentRatingHTML}
            ${ratingHTML}
            ${rewatchHTML}
        `;
    }

    document.getElementById("modalMeta").innerHTML = metaHTML;

    // Movie collection/franchise info only now - the weekly-schedule line
    // that used to also populate this (TV-only) depended entirely on
    // TVmaze, which has been removed from the timing pipeline (see the
    // tmdbDateToISO comment). Hidden entirely when there's nothing to
    // show, rather than an empty line taking up space.
    const extraInfoEl = document.getElementById("modalExtraInfo");
    let extraInfoHTML = '';
    if (currentItem.type === 'movie' && currentItem.collectionName) {
        extraInfoHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M4 9h16"/><path d="M9 4v16"/></svg><span>Part of ${escapeHTML(currentItem.collectionName)}</span>`;
    }
    extraInfoEl.innerHTML = extraInfoHTML;
    extraInfoEl.style.display = extraInfoHTML ? 'flex' : 'none';

    renderWatchOnSection(currentItem);
    document.getElementById("modalDescription").textContent = currentItem.description;

    let actionsHTML = '';
    const isAdded = state.library.some(s => s.tmdbId === currentItem.tmdbId);

    if (currentItem.type === 'movie') {
        actionsHTML = `
            <div class="modal-actions-row movie-actions-grid">
                <button class="action-button primary" onclick="toggleMovieWatched('${currentItem.id}')">
                    ${currentItem.watched ? 'Unwatch' : 'Watch'}
                </button>
                <button class="action-button trailer" onclick="playTrailer(${currentItem.tmdbId}, 'movie')">
                    Trailer
                </button>
                <button class="action-button danger" onclick="removeCurrentItem()">
                    Remove
                </button>
            </div>
            <div style="margin-top: 10px;">
                <button id="modalAddLibBtn" class="action-button ${isAdded ? '' : 'primary'}" style="width: 100%; ${isAdded ? 'background: var(--surface-2); color: var(--success); border: 1px solid rgba(163, 163, 163, 0.3);' : ''}" onclick="addModalItemToLibrary()" ${isAdded ? 'disabled' : ''}>
                    ${isAdded ? 'In Library' : 'Add to Library'}
                </button>
            </div>
        `;
    } else {
        const nextEp = getNextUnwatchedEpisode(currentItem);
        const nextLabel = nextEp ? `S${nextEp.season} E${nextEp.number}` : 'Up to Date';
        const prog = getTVProgress(currentItem);
        const hasUnwatched = (currentItem.episodes || []).some(ep => !ep.watched);

        actionsHTML = `
            <div class="modal-actions-row movie-actions-grid">
                <button class="action-button primary" onclick="markNextEpisodeWatched('${currentItem.id}')">
                    Next: ${nextLabel}
                </button>
                <button class="action-button trailer" onclick="playTrailer(${currentItem.tmdbId}, 'tv')">
                    Trailer
                </button>
                <button class="action-button danger" onclick="removeCurrentItem()">
                    Remove
                </button>
            </div>
            <div class="modal-actions-row" style="grid-template-columns: repeat(2, 1fr); margin-top: 10px;">
                <button class="action-button ${currentItem.isStopped ? 'primary' : 'warning'}" onclick="toggleStopWatching('${currentItem.id}')">
                    ${currentItem.isStopped ? 'Resume Show' : 'Stop Watching'}
                </button>
                <button id="modalAddLibBtn" class="action-button ${isAdded ? '' : 'primary'}" style="${isAdded ? 'background: var(--surface-2); color: var(--success); border: 1px solid rgba(163, 163, 163, 0.3);' : ''}" onclick="addModalItemToLibrary()" ${isAdded ? 'disabled' : ''}>
                    ${isAdded ? 'In Library' : 'Add to Library'}
                </button>
            </div>
            ${hasUnwatched ? `
                <div style="margin-top: 10px;">
                    <button class="action-button" style="width: 100%;" onclick="markAllReleasedEpisodesWatched()">
                        Mark All Episodes Watched
                    </button>
                </div>
            ` : ''}
        `;
    }

    document.getElementById("modalActions").innerHTML = actionsHTML;

    const episodesContainer = document.getElementById("modalEpisodes");
    if (currentItem.type === 'movie') {
        episodesContainer.innerHTML = '';
    } else {
        renderEpisodesList(episodesContainer);
    }
}

function renderEpisodesList(container) {
    const shouldScrollToNext = scrollToNextEpisodeOnRender;
    scrollToNextEpisodeOnRender = false;

    if (currentItem.episodesLoading) {
        setInnerHTMLIfChanged(container, skeletonRows(5));
        return;
    }

    if (!currentItem.episodes || currentItem.episodes.length === 0) {
        setInnerHTMLIfChanged(container, `<div style="font-size:13px; color:var(--text-muted); margin-top:20px;">No episode info available.</div>`);
        return;
    }

    const seasons = [...new Set(currentItem.episodes.map(ep => ep.season))].sort((a, b) => a - b);
    
    if (!seasons.includes(selectedSeason) && seasons.length > 0) {
        selectedSeason = seasons[0];
    }

    const seasonEpisodes = currentItem.episodes.filter(ep => ep.season === selectedSeason);
    const nextEp = getNextUnwatchedEpisode(currentItem);
    const seasonReleasedEpisodes = seasonEpisodes.filter(ep => isReleased(ep.releaseDate));
    const seasonFullyWatched = seasonReleasedEpisodes.length > 0 && seasonReleasedEpisodes.every(ep => ep.watched);
    const showSeasonRewatchButton = isCurrentItemInLibrary();

    let html = `
        <div class="season-selector-wrapper">
            <div class="season-selector">
                ${seasons.map(s => `
                    <button class="season-button ${s === selectedSeason ? 'active' : ''}" 
                            onmousedown="startSeasonPress(${s})" 
                            onmouseup="endSeasonPress()" 
                            onmouseleave="endSeasonPress()"
                            ontouchstart="startSeasonPress(${s}, event)" 
                            ontouchmove="moveSeasonPress(event)"
                            ontouchend="endSeasonPress()" 
                            ontouchcancel="endSeasonPress()"
                            onclick="handleSeasonClick(event, ${s})">
                        Season ${s}
                    </button>
                `).join("")}
            </div>
            ${showSeasonRewatchButton ? `
                <button class="season-rewatch-button" onclick="openSeasonRewatchPopup(${selectedSeason})" ${seasonFullyWatched ? '' : 'disabled'} style="${seasonFullyWatched ? '' : 'opacity: 0.4; pointer-events: none;'}" aria-label="Log a rewatch for this season" title="${seasonFullyWatched ? 'Log a rewatch for this season' : 'Finish watching the season to rewatch it'}">
                    ${rewatchIconSVG()}
                </button>
            ` : ''}
        </div>
        <div class="episodes-list">
            ${seasonEpisodes.map(ep => {
                const hasStill = ep.still && ep.still.trim() !== "";
                const isFuture = !isReleased(ep.releaseDate);
                // A future episode shows when it's due instead of a
                // Watched/Unwatched state - it can't be either yet.
                const watchedText = isFuture ? getCountdown(ep.releaseDate) : (ep.watched ? "Watched" : "Unwatched");
                const watchedColor = isFuture ? "var(--text-muted)" : (ep.watched ? "var(--success)" : "var(--danger)");
                const isUpNext = nextEp && nextEp.id === ep.id;

                return `
                    <div class="episode ${isUpNext ? 'episode-up-next' : ''} ${isFuture ? 'episode-future' : ''}" data-ep-id="${ep.id}" onclick="openEpisodeDetails('${ep.id}')">
                        <div class="episode-main">
                            <div class="episode-left">
                                ${hasStill ? `
                                    <img src="${tmdbThumb(ep.still, 'w300')}" class="episode-still" alt="${escapeHTML(ep.title)}" loading="lazy" decoding="async">
                                ` : `
                                    <div class="episode-still" style="display:flex; align-items:center; justify-content:center; font-size:9px; color:var(--text-muted); text-align:center;">S${ep.season}E${ep.number}</div>
                                `}
                                <div class="episode-info">
                                    <div class="episode-title">E${ep.number} • ${escapeHTML(ep.title)}</div>
                                    <div class="episode-overview">${escapeHTML(ep.overview)}</div>
                                    <div class="episode-meta">
                                        ${ep.runtime || '45 min'} &bull; <span style="color: ${watchedColor}; font-weight:700;">${watchedText}</span>${(ep.watched && !isFuture) ? ` &bull; <span class="rewatch-count-tap" onclick="event.stopPropagation(); openRewatchPopup('${ep.id}')">Rewatched \u00d7${ep.rewatchCount || 0}</span>` : ''}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join("")}
        </div>
    `;
    setInnerHTMLIfChanged(container, html);

    // Keep the currently selected season visible after the episode list re-renders.
    // This runs after the DOM has been updated so the active season button can
    // be scrolled into view without affecting the press-and-hold functionality.
    requestAnimationFrame(() => {
        const seasonSelector = container.querySelector('.season-selector');
        const activeSeasonButton = container.querySelector('.season-button.active');

        if (seasonSelector && activeSeasonButton) {
            activeSeasonButton.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'center'
            });
        }

        // On a fresh modal open, also jump straight to the up-next episode
        // row so the user doesn't have to hunt for it in a long list.
        if (shouldScrollToNext) {
            const upNextRow = nextEp ? container.querySelector(`[data-ep-id="${nextEp.id}"]`) : null;
            if (upNextRow) {
                upNextRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    });
}

/* =========================================================
   SEASON PRESS-AND-HOLD FUNCTIONALITY
========================================================= */
let seasonPressTimer = null;
let isLongPress = false;
let seasonPressStartX = 0;
let seasonPressStartY = 0;

function startSeasonPress(seasonNumber, event) {
    isLongPress = false;
    const touch = event && event.touches && event.touches[0];
    seasonPressStartX = touch ? touch.clientX : 0;
    seasonPressStartY = touch ? touch.clientY : 0;
    seasonPressTimer = setTimeout(() => {
        isLongPress = true;
        toggleEntireSeasonWatched(seasonNumber);
        if (navigator.vibrate) navigator.vibrate(50);
    }, 600);
}

// The season strip scrolls horizontally - without this, swiping between
// seasons with a finger that lingers 600ms (easy to do mid-swipe) could
// fire "mark whole season watched" instead of just switching seasons.
// Same fix, same reasoning as movePosterPress() above.
function moveSeasonPress(event) {
    if (!seasonPressTimer) return;
    const touch = event && event.touches && event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - seasonPressStartX;
    const dy = touch.clientY - seasonPressStartY;
    if (Math.hypot(dx, dy) > POSTER_PRESS_MOVE_THRESHOLD) {
        endSeasonPress();
    }
}

function endSeasonPress() {
    if (seasonPressTimer) {
        clearTimeout(seasonPressTimer);
        seasonPressTimer = null;
    }
}

function handleSeasonClick(event, seasonNumber) {
    if (isLongPress) {
        event.preventDefault();
        event.stopPropagation();
        isLongPress = false;
        return;
    }
    selectedSeason = seasonNumber;
    updateModalContent();
}

/* =========================================================
   CHANGE POSTER / BACKDROP
   Long-pressing a poster (Library grid) opens a picker of every
   poster/backdrop TMDB has for that title - same 600ms long-press
   pattern as the season selector above, including the click-suppression
   so the long-press doesn't also open the details modal underneath it.

   Movement cancellation: the original version only ever cleared the
   timer on touchend/touchcancel/mouseup - never on movement - so
   scrolling the library with a finger that lingered on a poster for
   600ms (easy to do mid-scroll, especially right as a scroll gesture
   starts or during momentum) would pop the picker open in the middle of
   scrolling. movePosterPress() now cancels the pending long-press the
   moment the touch moves more than a few pixels from where it started,
   the same "was this actually a hold, or a drag/scroll" distinction the
   nav bar's drag-to-switch gesture already makes (see DRAG_THRESHOLD).
========================================================= */
let posterPressTimer = null;
let isPosterLongPress = false;
let posterPressStartX = 0;
let posterPressStartY = 0;
const POSTER_PRESS_MOVE_THRESHOLD = 10;

function startPosterPress(itemId, type, event) {
    isPosterLongPress = false;
    const touch = event && event.touches && event.touches[0];
    posterPressStartX = touch ? touch.clientX : 0;
    posterPressStartY = touch ? touch.clientY : 0;
    posterPressTimer = setTimeout(() => {
        isPosterLongPress = true;
        if (navigator.vibrate) navigator.vibrate(50);
        openChangePosterPicker(itemId, type);
    }, 600);
}

function movePosterPress(event) {
    if (!posterPressTimer) return;
    const touch = event && event.touches && event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - posterPressStartX;
    const dy = touch.clientY - posterPressStartY;
    if (Math.hypot(dx, dy) > POSTER_PRESS_MOVE_THRESHOLD) {
        endPosterPress();
    }
}

function endPosterPress() {
    if (posterPressTimer) {
        clearTimeout(posterPressTimer);
        posterPressTimer = null;
    }
}

// Wraps the card's normal tap-to-open behavior so a long-press (which
// already opened the picker above) doesn't also open the details modal
// underneath it.
function handleCardClick(event, itemId) {
    if (isPosterLongPress) {
        event.preventDefault();
        event.stopPropagation();
        isPosterLongPress = false;
        return;
    }
    openDetails(itemId);
}

/* =========================================================
   LIST CARD LONG-PRESS -> CHANGE BACKDROP
   Same 600ms long-press pattern as the poster/backdrop change above
   (same move-cancellation, same click-suppression) - holding a list
   card jumps straight into that list's backdrop picker rather than
   needing to open the list's own detail view first just to reach the
   Backdrop button in there. Genuinely the same interaction people
   already learned from posters, not a new one to discover separately.
========================================================= */
let listPressTimer = null;
let isListLongPress = false;
let listPressStartX = 0;
let listPressStartY = 0;
const LIST_PRESS_MOVE_THRESHOLD = 10;

function startListPress(listId, isFavorites, event) {
    isListLongPress = false;
    const touch = event && event.touches && event.touches[0];
    listPressStartX = touch ? touch.clientX : 0;
    listPressStartY = touch ? touch.clientY : 0;
    listPressTimer = setTimeout(() => {
        isListLongPress = true;
        if (navigator.vibrate) navigator.vibrate(50);
        // openListBackdropPicker() reads currentListDetailId to decide
        // which list it's working with (null means Favourites) - the
        // same variable openListDetailModal() sets when entering a
        // list's own detail view normally. Setting it directly here,
        // without actually opening that modal, is what lets this
        // shortcut skip straight to the picker. Any real navigation
        // into a list's detail view afterward overwrites this the same
        // way it always does, so there's nothing to reset or clean up.
        currentListDetailId = isFavorites ? null : listId;
        openListBackdropPicker();
    }, 600);
}

function moveListPress(event) {
    if (!listPressTimer) return;
    const touch = event && event.touches && event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - listPressStartX;
    const dy = touch.clientY - listPressStartY;
    if (Math.hypot(dx, dy) > LIST_PRESS_MOVE_THRESHOLD) {
        endListPress();
    }
}

function endListPress() {
    if (listPressTimer) {
        clearTimeout(listPressTimer);
        listPressTimer = null;
    }
}

// Wraps the card's normal tap-to-open behavior so a long-press (which
// already opened the backdrop picker above) doesn't also open the
// list's detail view underneath it.
function handleListCardClick(event, listId, isFavorites) {
    if (isListLongPress) {
        event.preventDefault();
        event.stopPropagation();
        isListLongPress = false;
        return;
    }
    if (isFavorites) {
        openListDetailModal(null, true);
    } else {
        openListDetailModal(listId);
    }
}

// TMDB keeps a whole gallery of posters/backdrops per title (different
// languages, fan-submitted alternates, different crops) beyond the one
// "primary" image the app shows by default. include_image_language pulls
// in the language-neutral and English-labeled sets, which covers the vast
// majority of what's actually available without fetching every language.
// Thumb sizes are only for the picker grid itself - each cell only ever
// renders at ~110px (poster, 3-col) or ~170px (backdrop, 2-col), so pulling
// full w500/w780 images for every candidate was shipping far more pixels
// than the grid could ever show and made the picker feel slow to fill in.
// `full` stays at the original, higher-res size and is what actually gets
// saved onto the item / shown everywhere else in the app once picked.
async function fetchItemImages(tmdbId, type) {
    try {
        const endpoint = type === 'movie'
            ? `https://api.themoviedb.org/3/movie/${tmdbId}/images?api_key=${TMDB_API_KEY}&include_image_language=en,null`
            : `https://api.themoviedb.org/3/tv/${tmdbId}/images?api_key=${TMDB_API_KEY}&include_image_language=en,null`;
        const res = await fetch(endpoint);
        const data = await res.json();

        if (!res.ok) {
            console.warn(`TMDB images request failed (${res.status}):`, data?.status_message || data);
            return { posters: [], backdrops: [], failed: true };
        }

        return {
            posters: (data.posters || []).map(img => ({
                thumb: `https://image.tmdb.org/t/p/w185${img.file_path}`,
                full: `https://image.tmdb.org/t/p/w500${img.file_path}`
            })),
            backdrops: (data.backdrops || []).map(img => ({
                thumb: `https://image.tmdb.org/t/p/w300${img.file_path}`,
                full: `https://image.tmdb.org/t/p/w780${img.file_path}`
            })),
            failed: false
        };
    } catch (err) {
        console.error("Failed to fetch alternate images:", err);
        return { posters: [], backdrops: [], failed: true };
    }
}

let posterPickerItemId = null;
let posterPickerType = null;
let posterPickerTab = 'poster';
let posterPickerImages = { posters: [], backdrops: [] };
// Picking an image no longer saves+closes immediately - it just updates
// these two pending values so the person can switch to the other tab and
// pick a backdrop too before anything is written. Whatever's still pending
// (unset = "no change from what's already saved") is applied together when
// they tap Done, so one visit to the picker can update both.
let pendingPosterUrl = null;
let pendingBackdropUrl = null;
// Whether the person actually tapped an image in this session, separate
// from pendingPosterUrl/pendingBackdropUrl's value. Without this, tapping
// the image that's already the current poster/backdrop (e.g. to "lock it
// in" against future auto-updates) compared equal to the existing value
// and silently did nothing - customPoster/customBackdrop never got set.
let posterPicked = false;
let backdropPicked = false;

async function openChangePosterPicker(itemId, type) {
    const item = getItem(itemId);
    if (!item || !item.tmdbId) return;

    posterPickerItemId = itemId;
    posterPickerType = type;
    posterPickerTab = 'poster';
    pendingPosterUrl = item.poster || null;
    pendingBackdropUrl = item.backdrop || null;
    posterPicked = false;
    backdropPicked = false;

    document.getElementById("posterPickerTabPoster").classList.add("active");
    document.getElementById("posterPickerTabBackdrop").classList.remove("active");

    const grid = document.getElementById("posterPickerGrid");
    grid.className = "poster-picker-grid";
    grid.innerHTML = skeletonGrid();
    const posterModal = document.getElementById("posterPickerModal");
    if (!posterModal.classList.contains("open")) {
        posterModal.classList.add("open");
        lockBodyScroll("posterPickerModal");
    }

    posterPickerImages = await fetchItemImages(item.tmdbId, type);

    // The picker could still be open for this same item when the fetch
    // resolves, or the person could have already closed it / long-pressed
    // a different card in the meantime - only render if it's still relevant.
    if (posterPickerItemId === itemId) {
        renderPosterPickerGrid();
    }
}

function setPosterPickerTab(tab) {
    posterPickerTab = tab;
    document.getElementById("posterPickerTabPoster").classList.toggle("active", tab === 'poster');
    document.getElementById("posterPickerTabBackdrop").classList.toggle("active", tab === 'backdrop');
    renderPosterPickerGrid();
}

function renderPosterPickerGrid() {
    const grid = document.getElementById("posterPickerGrid");
    const item = getItem(posterPickerItemId);
    if (!grid || !item) return;

    const images = posterPickerTab === 'poster' ? posterPickerImages.posters : posterPickerImages.backdrops;
    const currentUrl = posterPickerTab === 'poster' ? pendingPosterUrl : pendingBackdropUrl;

    grid.className = `poster-picker-grid ${posterPickerTab === 'backdrop' ? 'backdrop-mode' : 'poster-mode'}`;

    if (!images.length) {
        grid.innerHTML = posterPickerImages.failed
            ? emptyState("Couldn't Load Images", "There was a problem reaching TMDB. Check your connection and try again.")
            : emptyState("No Images Found", `TMDB doesn't have any alternate ${posterPickerTab}s for this title.`);
        return;
    }

    grid.innerHTML = images.map(img => `
        <div class="poster-picker-item ${img.full === currentUrl ? 'selected' : ''}" onclick="selectPickerImage('${img.full}')">
            <img src="${img.thumb}" loading="lazy" decoding="async" alt="">
        </div>
    `).join("");
}

// Just records the choice and re-renders the grid to move the selection
// highlight - it deliberately does not save or close, so the person can
// switch tabs (Poster <-> Backdrop) and pick the other one too before
// anything is written. See confirmPosterPickerChanges() for the actual save.
function selectPickerImage(url) {
    if (posterPickerTab === 'poster') {
        pendingPosterUrl = url;
        posterPicked = true;
    } else {
        pendingBackdropUrl = url;
        backdropPicked = true;
    }
    renderPosterPickerGrid();
}

async function confirmPosterPickerChanges() {
    const item = getItem(posterPickerItemId);
    if (!item) {
        closePosterPicker();
        return;
    }

    // posterPicked/backdropPicked (not just a URL comparison) is what
    // decides whether there's anything to save - see the flag declarations
    // above for why: tapping the already-current image needs to count as
    // "lock this one in" even though the URL itself didn't change.
    const posterChanged = pendingPosterUrl && posterPicked;
    const backdropChanged = pendingBackdropUrl && backdropPicked;

    if (!posterChanged && !backdropChanged) {
        closePosterPicker();
        return;
    }

    // Keep the previous values on hand so a failed save can be rolled back
    // locally rather than leaving the in-memory item out of sync with what
    // actually made it to Firestore.
    const previousPoster = item.poster;
    const previousCustomPoster = item.customPoster;
    const previousBackdrop = item.backdrop;
    const previousCustomBackdrop = item.customBackdrop;

    if (posterChanged) {
        item.poster = pendingPosterUrl;
        item.customPoster = true;
    }
    if (backdropChanged) {
        item.backdrop = pendingBackdropUrl;
        item.customBackdrop = true;
    }

    const saved = await saveItem(item);

    if (!saved) {
        // Roll back the in-memory change so the app doesn't show a poster/
        // backdrop it never actually managed to save, then say so honestly
        // instead of the unconditional "updated" toast this used to show
        // regardless of whether the Firestore write succeeded.
        item.poster = previousPoster;
        item.customPoster = previousCustomPoster;
        item.backdrop = previousBackdrop;
        item.customBackdrop = previousCustomBackdrop;
        closePosterPicker();
        showErrorToast("Couldn't save - check your connection and try again.");
        return;
    }

    refreshActivePage();
    if (currentItem && currentItem.id === item.id) updateModalContent();
    closePosterPicker();

    const message = posterChanged && backdropChanged
        ? "Poster and backdrop updated."
        : `${posterChanged ? "Poster" : "Backdrop"} updated.`;
    showToast(message, "success");
}

function closePosterPicker() {
    document.getElementById("posterPickerModal").classList.remove("open");
    unlockBodyScroll("posterPickerModal");
    posterPickerItemId = null;
    pendingPosterUrl = null;
    pendingBackdropUrl = null;
}

function closePosterPickerOutside(event) {
    if (event.target.id === "posterPickerModal") closePosterPicker();
}

// Every place in the app that flips an episode's watched state goes through
// this, so the per-episode watch date stays consistent everywhere rather
// than being set inline four different ways. The show-level lastWatchedAt
// field (used by movies too) only ever reflects the single most recent
// action across a whole show, so it can't answer "when was THIS episode
// watched" - that's what this timestamp is for, and it's what a future
// yearly recap would read from.
function setEpisodeWatched(ep, watched) {
    ep.watched = watched;
    ep.watchedAt = watched ? new Date().toISOString() : null;
    if (!watched) {
        ep.rewatchCount = 0;
        ep.rewatchedAt = null;
    }
}

async function toggleEntireSeasonWatched(seasonNumber) {
    if (!currentItem || !currentItem.episodes) return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }

    const seasonEps = currentItem.episodes.filter(ep => ep.season === seasonNumber);
    if (seasonEps.length === 0) return;

    const releasedEps = seasonEps.filter(ep => isReleased(ep.releaseDate));
    if (releasedEps.length === 0) {
        showErrorToast("No released episodes in this season yet.");
        return;
    }

    // Only released episodes are ever touched - unaired ones always stay unwatched.
    const anyUnwatched = releasedEps.some(ep => !ep.watched);
    releasedEps.forEach(ep => {
        setEpisodeWatched(ep, anyUnwatched);
    });

    showToast(`Season ${seasonNumber} marked as ${anyUnwatched ? 'Watched' : 'Unwatched'}`, "success");
    await saveItem(currentItem);
    updateModalContent();
    refreshActivePage();
}

// Same idea as toggleEntireSeasonWatched above, scaled to the whole show
// instead of just the selected season - only ever touches released
// episodes (unaired ones always stay unwatched), and only marks forward
// to watched (unlike the season version, this has no "unwatch everything"
// direction - a whole-show catch-up action isn't the natural place to
// also offer a whole-show un-watch). Consistent with the rest of the
// app's watch-marking actions (Next: SxEy, the season long-press), this
// acts immediately without a confirmation step, since watched status is
// always reversible per-episode afterward.
async function markAllReleasedEpisodesWatched() {
    if (!currentItem || !currentItem.episodes) return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }

    const toMark = currentItem.episodes.filter(ep => !ep.watched && isReleased(ep.releaseDate));
    if (toMark.length === 0) {
        showToast("Already up to date.", "success");
        return;
    }

    toMark.forEach(ep => setEpisodeWatched(ep, true));

    showToast(`Marked ${toMark.length} episode${toMark.length === 1 ? '' : 's'} watched.`, "success");
    await saveItem(currentItem);
    updateModalContent();
    refreshActivePage();
}

/* =========================================================
   MODAL CONTROLS & ACTIONS
========================================================= */
function openEpisodeDetails(epId) {
    if (!currentItem || !currentItem.episodes) return;
    currentEpisode = currentItem.episodes.find(e => e.id === epId);
    if (!currentEpisode) return;
    
    document.getElementById("episodeModalTitle").textContent = `E${currentEpisode.number}: ${currentEpisode.title}`;
    
    const backdrop = document.getElementById("episodeModalBackdrop");
    if (currentEpisode.still) {
        backdrop.style.backgroundImage = `url('${currentEpisode.still}')`;
    } else {
        backdrop.style.backgroundImage = 'none';
        backdrop.style.backgroundColor = 'var(--surface-2)';
    }
    
    refreshEpisodeModalMeta();
    
    document.getElementById("episodeModalDescription").textContent = currentEpisode.overview || "No description available.";
    
    // A future, not-yet-released episode can't be marked watched - the
    // button instead shows when it's due, matching how the episode list
    // row itself displays it (see renderEpisodesList).
    const btn = document.getElementById("episodeWatchedToggleBtn");
    const isFuture = !isReleased(currentEpisode.releaseDate);
    if (isFuture && !currentEpisode.watched) {
        btn.textContent = `Releases ${getCountdown(currentEpisode.releaseDate)}`;
        btn.disabled = true;
    } else {
        btn.textContent = currentEpisode.watched ? "Mark as Unwatched" : "Mark as Watched";
        btn.disabled = false;
    }

    // Only offer the catch-up shortcut when there's actually an earlier,
    // released, unwatched episode for it to do anything useful with.
    const upToHereBtn = document.getElementById("episodeMarkUpToHereBtn");
    const hasEarlierUnwatched = currentItem.episodes.some(ep => {
        if (ep.watched || !isReleased(ep.releaseDate)) return false;
        return ep.season < currentEpisode.season || (ep.season === currentEpisode.season && ep.number <= currentEpisode.number);
    });
    upToHereBtn.style.display = hasEarlierUnwatched ? "flex" : "none";

    const episodeModal = document.getElementById("episodeDetailsModal");
    if (episodeModal.classList.contains("open")) return;
    episodeModal.classList.add("open");
    lockBodyScroll("episodeDetailsModal");
}

// Rebuilds just the episode modal's meta line (season/runtime/date and the
// tappable rewatch indicator). Split out from openEpisodeDetails so the
// rewatch popup can refresh the count behind it without re-running the
// full open sequence - calling openEpisodeDetails again there was calling
// lockBodyScroll() an extra, unmatched time per tap (openEpisodeDetails
// always locks once), so a few taps of Add/Remove Rewatch would leave the
// body scroll permanently locked after closing everything.
function refreshEpisodeModalMeta() {
    if (!currentEpisode) return;
    const isFuture = !isReleased(currentEpisode.releaseDate);
    document.getElementById("episodeModalMeta").innerHTML = `
        <span>Season ${currentEpisode.season}</span>
        <span>•</span>
        <span>${currentEpisode.runtime || '45 min'}</span>
        ${currentEpisode.releaseDate ? `
            <span>•</span>
            <span>${escapeHTML(formatDateWithReleaseTime(currentEpisode.releaseDate))}</span>
        ` : ''}
        ${(currentEpisode.watched && isCurrentItemInLibrary()) ? `
            <span>•</span>
            <span class="rewatch-count-tap" onclick="event.stopPropagation(); openRewatchPopup('${currentEpisode.id}')">Rewatched \u00d7${currentEpisode.rewatchCount || 0}</span>
        ` : ''}
    `;
}

function closeEpisodeModal() {
    document.getElementById("episodeDetailsModal").classList.remove("open");
    unlockBodyScroll("episodeDetailsModal");
    currentEpisode = null;
}

function closeEpisodeModalOutside(event) {
    if (event.target.id === "episodeDetailsModal") closeEpisodeModal();
}

async function toggleCurrentEpisodeWatched() {
    if (!currentItem || !currentEpisode) return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    // Defensive - the button is already disabled for this case in
    // openEpisodeDetails, this just guards any other path to this function.
    if (!currentEpisode.watched && !isReleased(currentEpisode.releaseDate)) {
        return;
    }
    setEpisodeWatched(currentEpisode, !currentEpisode.watched);
    await saveItem(currentItem);
    closeEpisodeModal();
    updateModalContent();
    refreshActivePage();
}

// Marks every episode up to and including the currently open one as
// watched, for catching up in one tap instead of tapping through each
// episode individually.
async function markWatchedUpToCurrentEpisode() {
    if (!currentItem || !currentEpisode || !currentItem.episodes) return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }

    let count = 0;
    currentItem.episodes.forEach(ep => {
        if (ep.watched || !isReleased(ep.releaseDate)) return;
        const isUpToHere = ep.season < currentEpisode.season || (ep.season === currentEpisode.season && ep.number <= currentEpisode.number);
        if (isUpToHere) {
            setEpisodeWatched(ep, true);
            count++;
        }
    });

    if (count === 0) return;

    await saveItem(currentItem);
    showToast(`Marked ${count} episode${count === 1 ? '' : 's'} as watched.`, "success");
    closeEpisodeModal();
    updateModalContent();
    refreshActivePage();
}

// Search-result "preview" items (opened before the user taps "Add to Library")
// carry a real tmdbId and full data, but aren't in state.library yet. Without
// this check, tapping Watch/Next/Stop on a preview would still call saveItem()
// (which only checks item.id) and silently write a partial, incomplete doc
// into the user's Firestore library — which then syncs back down as a
// "phantom" entry the user never meant to add.
//
// Matches by id OR tmdbId rather than tmdbId alone - currentItem for a real
// (non-preview) item almost always comes straight from getItem(), which
// already returns the exact state.library object, so its .id trivially
// matches. That makes id a reliable independent signal if tmdbId is ever
// missing, mismatched, or NaN on a particular item (NaN !== NaN in JS, so a
// bad tmdbId fails silently and permanently for just that one item, not
// everything - hard to spot without this fallback). A preview's id (e.g.
// "preview-tv-123") can never collide with a real library item's id, so
// this doesn't weaken the guard above.
function isCurrentItemInLibrary() {
    if (!currentItem || currentItem.isPreview) return false;
    return state.library.some(s => s.id === currentItem.id || (currentItem.tmdbId && s.tmdbId === currentItem.tmdbId));
}

// Small circular-arrows icon used on the Rewatch button, in the same
// stroke-based style as the app's other inline action icons.
function rewatchIconSVG() {
    return `<svg class="icon icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
}

// Rewatch Count popup - shared by movies, single episodes, and whole
// seasons. currentEpisode (when set) is the same object reference as the
// matching entry in currentItem.episodes, so mutating it and saving
// currentItem persists it - but the popup can also be opened directly from
// an episode row or the season-rewatch button without the Episode Details
// Modal being open, so episode lookups go by id/season rather than
// assuming currentEpisode is already pointing at the right one.
let rewatchPopupMode = null; // 'movie' | 'episode' | 'season'
let rewatchPopupSeasonNumber = null;

function findEpisodeById(epId) {
    if (!currentItem || !currentItem.episodes) return null;
    return currentItem.episodes.find(e => e.id === epId) || null;
}

// A season's count is the minimum rewatchCount across its released
// episodes - the number of full passes every episode in the season has
// had. Since the season-rewatch button is only enabled once every
// released episode is watched, this is well-defined whenever it's usable.
function getSeasonReleasedEpisodes(seasonNumber) {
    if (!currentItem || !currentItem.episodes) return [];
    return currentItem.episodes.filter(ep => ep.season === seasonNumber);
}

function getSeasonRewatchCount(seasonNumber) {
    const eps = getSeasonReleasedEpisodes(seasonNumber);
    if (eps.length === 0) return 0;
    return Math.min(...eps.map(ep => ep.rewatchCount || 0));
}

function openMovieRewatchPopup() {
    if (!currentItem || currentItem.type !== 'movie') return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    rewatchPopupMode = 'movie';
    rewatchPopupEpId = null;
    rewatchPopupSeasonNumber = null;
    document.getElementById("rewatchPopupTitle").textContent = currentItem.title;
    renderRewatchPopup();
    const modal = document.getElementById("rewatchCountModal");
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    lockBodyScroll("rewatchCountModal");
}

function openRewatchPopup(epId) {
    const episode = findEpisodeById(epId);
    if (!episode) return;
    rewatchPopupMode = 'episode';
    rewatchPopupEpId = epId;
    rewatchPopupSeasonNumber = null;
    document.getElementById("rewatchPopupTitle").textContent = `E${episode.number}: ${episode.title}`;
    renderRewatchPopup();
    const modal = document.getElementById("rewatchCountModal");
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    lockBodyScroll("rewatchCountModal");
}

function openSeasonRewatchPopup(seasonNumber) {
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    rewatchPopupMode = 'season';
    rewatchPopupSeasonNumber = seasonNumber;
    rewatchPopupEpId = null;
    document.getElementById("rewatchPopupTitle").textContent = `Season ${seasonNumber}`;
    renderRewatchPopup();
    const modal = document.getElementById("rewatchCountModal");
    if (modal.classList.contains("open")) return;
    modal.classList.add("open");
    lockBodyScroll("rewatchCountModal");
}

function renderRewatchPopup() {
    let count = 0;
    let canRemove = false;
    const clearBtn = document.getElementById("rewatchPopupClearBtn");
    if (rewatchPopupMode === 'movie') {
        if (!currentItem) return;
        count = currentItem.rewatchCount || 0;
        canRemove = count > 0;
        clearBtn.style.display = "none";
    } else if (rewatchPopupMode === 'episode') {
        const episode = findEpisodeById(rewatchPopupEpId);
        if (!episode) return;
        count = episode.rewatchCount || 0;
        canRemove = count > 0;
        clearBtn.style.display = "none";
    } else if (rewatchPopupMode === 'season') {
        count = getSeasonRewatchCount(rewatchPopupSeasonNumber);
        // Remove should be enabled whenever ANY episode in the season still
        // has a rewatch to take back, not just when every episode does -
        // the displayed count is the minimum across episodes (full passes
        // completed by all of them), so it can read 0 even while some
        // individual episode still has rewatches left to remove.
        canRemove = getSeasonReleasedEpisodes(rewatchPopupSeasonNumber).some(ep => (ep.rewatchCount || 0) > 0);
        clearBtn.style.display = canRemove ? "block" : "none";
    } else {
        return;
    }
    document.getElementById("rewatchPopupCount").textContent = `\u00d7${count}`;
    const removeBtn = document.getElementById("rewatchPopupRemoveBtn");
    removeBtn.disabled = !canRemove;
    removeBtn.style.opacity = canRemove ? "1" : "0.5";
}

function closeRewatchPopup() {
    document.getElementById("rewatchCountModal").classList.remove("open");
    unlockBodyScroll("rewatchCountModal");
    rewatchPopupMode = null;
    rewatchPopupEpId = null;
    rewatchPopupSeasonNumber = null;
}

function closeRewatchPopupOutside(event) {
    if (event.target.id === "rewatchCountModal") closeRewatchPopup();
}

async function addRewatchFromPopup() {
    if (!currentItem || !isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    const now = new Date().toISOString();

    if (rewatchPopupMode === 'movie') {
        currentItem.rewatchCount = (currentItem.rewatchCount || 0) + 1;
        currentItem.lastWatchedAt = now;
    } else if (rewatchPopupMode === 'episode') {
        const episode = findEpisodeById(rewatchPopupEpId);
        if (!episode) return;
        episode.rewatchCount = (episode.rewatchCount || 0) + 1;
        episode.rewatchedAt = now;
        if (currentEpisode && currentEpisode.id === episode.id) refreshEpisodeModalMeta();
    } else if (rewatchPopupMode === 'season') {
        getSeasonReleasedEpisodes(rewatchPopupSeasonNumber).forEach(ep => {
            ep.rewatchCount = (ep.rewatchCount || 0) + 1;
            ep.rewatchedAt = now;
        });
    } else {
        return;
    }

    await saveItem(currentItem);
    renderRewatchPopup();
    updateModalContent();
    refreshActivePage();
}

async function removeRewatchFromPopup() {
    if (!currentItem) return;

    if (rewatchPopupMode === 'movie') {
        if (!currentItem.rewatchCount) return;
        currentItem.rewatchCount = Math.max(0, currentItem.rewatchCount - 1);
    } else if (rewatchPopupMode === 'episode') {
        const episode = findEpisodeById(rewatchPopupEpId);
        if (!episode || !episode.rewatchCount) return;
        episode.rewatchCount = Math.max(0, episode.rewatchCount - 1);
        if (episode.rewatchCount === 0) episode.rewatchedAt = null;
        if (currentEpisode && currentEpisode.id === episode.id) refreshEpisodeModalMeta();
    } else if (rewatchPopupMode === 'season') {
        getSeasonReleasedEpisodes(rewatchPopupSeasonNumber).forEach(ep => {
            if (!ep.rewatchCount) return;
            ep.rewatchCount = Math.max(0, ep.rewatchCount - 1);
            if (ep.rewatchCount === 0) ep.rewatchedAt = null;
        });
    } else {
        return;
    }

    await saveItem(currentItem);
    renderRewatchPopup();
    updateModalContent();
    refreshActivePage();
}

// Wipes rewatch data for every episode in the season at once, rather than
// stepping the count down one at a time via Remove Rewatch. Season-mode
// only - there's no equivalent for a single episode since Remove Rewatch
// already gets there in as many taps as the count requires.
async function clearSeasonRewatchesFromPopup() {
    if (!currentItem || rewatchPopupMode !== 'season') return;
    getSeasonReleasedEpisodes(rewatchPopupSeasonNumber).forEach(ep => {
        ep.rewatchCount = 0;
        ep.rewatchedAt = null;
    });
    await saveItem(currentItem);
    renderRewatchPopup();
    updateModalContent();
    refreshActivePage();
}

async function toggleMovieWatched(id) {
    if (!currentItem || currentItem.type !== 'movie') return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    if (!currentItem.watched && !isReleased(currentItem.releaseDate)) {
        showErrorToast("This movie hasn't been released yet.");
        return;
    }
    currentItem.watched = !currentItem.watched;
    currentItem.lastWatchedAt = currentItem.watched ? new Date().toISOString() : null;
    if (!currentItem.watched) currentItem.rewatchCount = 0;
    await saveItem(currentItem);
    updateModalContent();
    refreshActivePage();
}

async function markNextEpisodeWatched(id) {
    if (!currentItem || currentItem.type === 'movie') return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    const nextEp = getNextUnwatchedEpisode(currentItem);
    if (nextEp) {
        setEpisodeWatched(nextEp, true);
        await saveItem(currentItem);
        updateModalContent();
        refreshActivePage();
    }
}

async function toggleStopWatching(id) {
    if (!currentItem) return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    currentItem.isStopped = !currentItem.isStopped;
    await saveItem(currentItem);
    updateModalContent();
    refreshActivePage();
}

// Same shape as toggleStopWatching above - a lightweight per-item flag,
// no separate confirmation needed since it's trivially reversible. The
// automatic "Favourites" list (see FAVOURITES & LISTS below) is entirely
// computed from this flag rather than being a real, separately-tracked
// list - there's nothing else to keep in sync when this changes.
async function toggleFavoriteCurrentItem() {
    if (!currentItem) return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    currentItem.isFavorite = !currentItem.isFavorite;
    // Records when, not just whether - the Favourites list card's own
    // auto-picked backdrop (see createListCard) needs to know which
    // favorite is the most recent one, not just which items happen to
    // be favorited, so unfavoriting the current backdrop's source
    // correctly falls back to whichever favorite is now the most recent
    // instead of an arbitrary one. Left in place on unfavorite rather
    // than cleared - harmless once isFavorite is false, and simpler
    // than deciding whether to erase history that might just get set
    // again a moment later.
    if (currentItem.isFavorite) currentItem.favoritedAt = new Date().toISOString();
    await saveItem(currentItem);
    updateModalContent();
    refreshActivePage();
}

/* =========================================================
   ADD TO LIST PICKER
========================================================= */
function openListPickerModal() {
    if (!currentItem) return;
    if (!isCurrentItemInLibrary()) {
        showErrorToast("Add this to your library first.");
        return;
    }
    const modal = document.getElementById("listPickerModal");
    if (modal.classList.contains("open")) return;
    const nameEl = document.getElementById("listPickerItemName");
    if (nameEl) nameEl.textContent = currentItem.title;
    renderListPickerContent();
    modal.classList.add("open");
    lockBodyScroll("listPickerModal");
}

function closeListPickerModal() {
    document.getElementById("listPickerModal").classList.remove("open");
    unlockBodyScroll("listPickerModal");
}

function closeListPickerModalOutside(event) {
    if (event.target.id === "listPickerModal") closeListPickerModal();
}

function renderListPickerContent() {
    const container = document.getElementById("listPickerRows");
    if (!container || !currentItem) return;

    if (state.lists.length === 0) {
        container.innerHTML = emptyState("No Lists Yet", "Create your first list below.");
        return;
    }

    container.innerHTML = state.lists.map(list => {
        const isIn = list.itemIds.includes(currentItem.id);
        return `
            <button class="hero-pill-btn ${isIn ? 'pill-on' : 'pill-off'}" style="width: 100%; display: flex; justify-content: space-between; align-items: center;" onclick="toggleItemInListFromPicker('${list.id}')">
                <span>${escapeHTML(list.name)}</span>
                <span>${isIn ? 'Added' : 'Add'}</span>
            </button>
        `;
    }).join("");
}

async function toggleItemInListFromPicker(listId) {
    if (!currentItem) return;
    const list = state.lists.find(l => l.id === listId);
    if (!list) return;

    if (list.itemIds.includes(currentItem.id)) {
        await removeItemFromList(listId, currentItem.id);
    } else {
        await addItemToList(listId, currentItem.id);
    }
    renderListPickerContent();
}

// Generic, id-based versions of stop-watching/remove that don't depend on
// a details modal being open with `currentItem` set - used by the Continue
// Watching left-swipe gesture, which acts on whichever card was dragged.
async function markShowStoppedById(id) {
    const item = state.library.find(i => i.id === id);
    if (!item) return;
    item.isStopped = true;
    refreshActivePage();

    const saved = await saveItem(item);
    if (!saved) {
        item.isStopped = false;
        refreshActivePage();
        showErrorToast(`Couldn't save - "${item.title}" wasn't marked as Stopped Watching.`);
        return;
    }

    showToast(`Marked "${item.title}" as Stopped Watching.`, "success");
}

// Removing a TV show from the library shouldn't throw away which episodes
// you'd already watched - if you re-add the same show later (same slug id,
// since that's derived deterministically from its title), that progress
// should still be there. So for TV shows, instead of deleting the library
// doc outright, this parks a copy of it in a separate "archivedShows"
// collection first, keyed by the same id. importMediaData checks that
// collection when a show is (re-)added and, if a match turns up, carries
// the watched flags (and isStopped) over onto the freshly-fetched episode
// list before clearing the archive entry out.
//
// Movies only ever track a single watched boolean rather than per-episode
// history, so there's nothing meaningful to preserve there - those are
// still deleted outright, same as before.
async function removeLibraryItem(item) {
    if (auth && auth.currentUser && db) {
        const uid = auth.currentUser.uid;
        try {
            if (item.type !== 'movie') {
                await db.collection("users").doc(uid).collection("archivedShows").doc(item.id).set(item);
            }
            await db.collection("users").doc(uid).collection("library").doc(item.id).delete();
            return true;
        } catch (err) {
            console.error("Failed to remove item:", err);
            return false;
        }
    }
    return false;
}

async function removeLibraryItemById(id) {
    const idx = state.library.findIndex(i => i.id === id);
    if (idx === -1) return;
    const removedItem = state.library[idx];

    state.library.splice(idx, 1);
    refreshActivePage();

    const removed = await removeLibraryItem(removedItem);

    if (!removed) {
        // Put it back where it was rather than leaving the UI showing the
        // library as if the removal worked when Firestore never actually
        // confirmed it - a reload would've brought it back anyway.
        state.library.splice(idx, 0, removedItem);
        refreshActivePage();
        showErrorToast(`Couldn't remove "${removedItem.title}" - check your connection and try again.`);
        return;
    }

    const message = removedItem.type !== 'movie'
        ? `Removed "${removedItem.title}" - your watch history is saved if you add it back.`
        : `Removed "${removedItem.title}" from your library.`;
    showToast(message, "success");
}

async function removeCurrentItem() {
    if (!currentItem) return;
    const removedIndex = state.library.findIndex(i => i.id === currentItem.id);
    if (removedIndex === -1) {
        closeModal();
        return;
    }

    const removedItem = currentItem;

    state.library.splice(removedIndex, 1);
    closeModal();
    refreshActivePage();

    const removed = await removeLibraryItem(removedItem);

    if (!removed) {
        state.library.splice(removedIndex, 0, removedItem);
        refreshActivePage();
        showErrorToast(`Couldn't remove "${removedItem.title}" - check your connection and try again.`);
    }
}

// A quick, always-visible way to remove any card straight from a library
// grid, without needing to open its details modal first - a guaranteed
// path to clear anything out (including any oddly-shaped leftover entry
// automatic cleanup didn't confidently catch), not just a fallback.
function clearPasswordError() {
    const passwordInput = document.getElementById("authPassword");
    const passwordError = document.getElementById("authPasswordError");

    if (!passwordInput || !passwordError) return;

    passwordError.textContent = "";
    passwordError.classList.remove("show", "success");
    passwordInput.classList.remove("input-error");
}

/* =========================================================
   CONNECTIVITY STATE
   navigator.onLine/the online/offline events don't guarantee TMDB or
   Firebase are actually reachable (a captive portal can report "online"
   with no real connectivity), but they're a reliable, zero-cost signal
   for the common case of the device itself losing its connection - which
   is the case worth surfacing immediately rather than waiting for the
   next search or add-to-library action to fail and confuse the user.
========================================================= */
function updateOfflineBanner() {
    const banner = document.getElementById("offlineBanner");
    if (!banner) return;
    banner.classList.toggle("show", !navigator.onLine);
}

window.addEventListener("online", () => {
    updateOfflineBanner();
    showToast("Back online.", "success");
});

window.addEventListener("offline", () => {
    updateOfflineBanner();
    showErrorToast("You're offline - some features won't work until you're back.");
});

// Covers the case where the app is opened while already offline (e.g.
// launched from the home screen with no signal), not just the moment the
// connection drops mid-session.
updateOfflineBanner();

/* =========================================================
   ADD TO HOME SCREEN PROMPT
   There's no cross-platform API that reports "is this app installed to
   the home screen" directly - the closest reliable signal is whether
   the page is CURRENTLY running in standalone display mode, which is
   only ever true once someone has already added it and is opening it
   from that icon. That's the one thing checked here that can't be
   spoofed by the person themselves; everything else (the "Added"/"No
   thanks" buttons) is them self-reporting, since - particularly on iOS,
   which has no install-completion event at all, only a manual Share ->
   Add to Home Screen flow - there's no way to detect the action itself
   actually happening.
========================================================= */
const ADD_TO_HOME_SCREEN_ADDED_KEY = "novawatch-a2hsAdded";
const ADD_TO_HOME_SCREEN_DISMISSED_KEY = "novawatch-a2hsDismissedThisSession";

function isRunningStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOSDevice() {
    // No feature-detection alternative exists for this specifically -
    // the whole reason this check is needed is to decide which
    // INSTRUCTIONS to show (Share sheet vs browser menu), which is
    // inherently a platform question, not a capability one.
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function maybeShowAddToHomeScreenPrompt() {
    if (isRunningStandalone()) return;

    try {
        if (localStorage.getItem(ADD_TO_HOME_SCREEN_ADDED_KEY) === "true") return;
    } catch (e) { /* treat as not yet added */ }

    try {
        if (sessionStorage.getItem(ADD_TO_HOME_SCREEN_DISMISSED_KEY) === "true") return;
    } catch (e) { /* treat as not dismissed this session */ }

    const instructionsEl = document.getElementById("addToHomeScreenInstructions");
    if (instructionsEl) {
        instructionsEl.textContent = isIOSDevice()
            ? "Tap the Share icon in Safari's toolbar, then \"Add to Home Screen\"."
            : "Open your browser's menu, then choose \"Install app\" or \"Add to Home Screen\".";
    }

    const modal = document.getElementById("addToHomeScreenModal");
    if (modal && !modal.classList.contains("open")) {
        modal.classList.add("open");
        lockBodyScroll("addToHomeScreenModal");
    }
}

function closeAddToHomeScreenModal() {
    const modal = document.getElementById("addToHomeScreenModal");
    if (modal) modal.classList.remove("open");
    unlockBodyScroll("addToHomeScreenModal");
}

// Permanent - localStorage, not sessionStorage. Never shown again on
// this device while that flag stands, regardless of session/browser
// restarts (on top of isRunningStandalone() above, which would already
// suppress it forever anyway once the person is actually using the
// installed version - this just also covers someone who added it but
// hasn't relaunched from the icon yet).
function confirmAddToHomeScreen() {
    try {
        localStorage.setItem(ADD_TO_HOME_SCREEN_ADDED_KEY, "true");
    } catch (e) { /* non-fatal - worst case this shows again next visit */ }
    closeAddToHomeScreenModal();
}

// Temporary - sessionStorage, which clears itself once the browser tab/
// window actually closes. Declining just means "not now" - the next
// real visit (a fresh session, not just a page reload within this one)
// is meant to ask again, not be permanently silenced by a single "No
// thanks" tap the way "Added" is.
function dismissAddToHomeScreen() {
    try {
        sessionStorage.setItem(ADD_TO_HOME_SCREEN_DISMISSED_KEY, "true");
    } catch (e) { /* non-fatal - worst case this shows again this same session */ }
    closeAddToHomeScreenModal();
}

// Tapping outside the dialog reads the same as "No thanks" (a session-
// scoped decline), not as "Added" - dismissing without engaging isn't
// the same as confirming the action was actually taken.
function closeAddToHomeScreenOutside(event) {
    if (event.target.id === "addToHomeScreenModal") dismissAddToHomeScreen();
}

/* =========================================================
   SERVICE WORKER REGISTRATION (PWA installability + notifications)
========================================================= */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        // Once OneSignal is configured (see ONESIGNAL_APP_ID), its SDK
        // registers its own combined service worker itself
        // (OneSignalSDKWorker.js at the site root, which importScripts
        // both OneSignal's worker code and this app's own
        // service-worker.js - see that file's header comment). A second,
        // separate registration of service-worker.js directly here would
        // fight it for control of the same scope. Only register directly
        // while OneSignal isn't set up yet, so offline caching and
        // installability still work before that's configured.
        if (!isOneSignalConfigured()) {
            navigator.serviceWorker.register("service-worker.js").catch(err => {
                console.warn("Service worker registration failed:", err);
            });
        }
    });
}
