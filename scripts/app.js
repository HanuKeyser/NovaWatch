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

// Remembers which top-level tab (Home / Discover / Library) the user was
// last on. Currently write-only: saveLastTab() persists it on every tab
// switch, but nothing reads it back on load (the app always opens on
// Home) - kept as-is rather than wired up, since restoring the last tab
// on launch wasn't asked for.
const LAST_ACTIVE_TAB_KEY = "novawatch_last_tab";

function saveLastTab(page) {
    try {
        localStorage.setItem(LAST_ACTIVE_TAB_KEY, page);
    } catch (e) {
        // Private browsing / storage disabled - not worth failing over.
    }
}

let state = {
    library: [],
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
    if (metaTheme) metaTheme.setAttribute('content', effectiveTheme === 'dark' ? '#000000' : '#F3F4F9');

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
    { id: 'first_rewatch', tier: 'free', title: 'First Rewatch', description: 'Log your first rewatch.', check: (s) => s.totalRewatches >= 1 }
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

function computeAchievementStats() {
    let moviesWatched = 0;
    let showsCompleted = 0;
    let totalRewatches = 0;
    let rewatchedFullSeason = false;
    let sameWeekFinish = false;
    let clearedWatchlist = true;
    let anyItems = false;
    const watchedDates = new Set();

    state.library.forEach(item => {
        if (item.type === 'movie') {
            anyItems = true;
            if (item.watched) {
                moviesWatched++;
                totalRewatches += (item.rewatchCount || 0);
                if (item.lastWatchedAt) watchedDates.add(item.lastWatchedAt.slice(0, 10));
            } else {
                clearedWatchlist = false;
            }
        } else if (item.episodes && item.episodes.length > 0) {
            anyItems = true;
            const releasedEps = item.episodes.filter(ep => isReleased(ep.releaseDate));
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
                    if (ep.watchedAt) watchedDates.add(ep.watchedAt.slice(0, 10));
                }
            });

            const seasons = [...new Set(item.episodes.map(ep => ep.season))];
            seasons.forEach(s => {
                const seasonEps = item.episodes.filter(ep => ep.season === s && isReleased(ep.releaseDate));
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

    return { moviesWatched, showsCompleted, totalRewatches, longestStreak, rewatchedFullSeason, clearedWatchlist, sameWeekFinish };
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
        // The Settings row's "N unlocked" count previously only refreshed
        // when the Achievements modal itself was opened (inside
        // renderAchievementsList) - so an achievement earned in the
        // background (e.g. finishing a show) wouldn't show up in Settings
        // until you'd opened Achievements at least once to force a
        // re-render. Updating it here too means it's live immediately.
        updateAchievementsRowSub();
    }
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
// Filter applied within the Upcoming tab: 'tv' or 'movie', matching the
// plain 2-way TV Shows/Movies split used by Discover and Library (no
// combined "All" view) - getUpcomingItems() already supports this
// filterType param.
let currentUpcomingFilter = 'tv';
let toastTimer = null;
let searchDebounceTimer = null;
let libSearchDebounceTimers = {};

/* =========================================================
   NOTIFICATIONS SYSTEM
========================================================= */
async function checkNotificationPermissionState() {
    const btn = document.getElementById("notificationBtn");
    if (!btn) return;

    if (!("Notification" in window)) {
        btn.textContent = "Unsupported";
        btn.disabled = true;
        return;
    }
    if (Notification.permission === "granted") {
        btn.textContent = "Enabled";
        btn.style.color = "white";
        btn.disabled = true;
    } else if (Notification.permission === "denied") {
        btn.textContent = "Blocked";
        btn.disabled = true;
    } else {
        btn.textContent = "Enable";
        btn.disabled = false;
    }
}

async function requestNotificationPermission() {
    if (!("Notification" in window)) {
        showToast("Notifications not supported on this browser/device.", "error");
        return;
    }
    try {
        const permission = await Notification.requestPermission();
        checkNotificationPermissionState();
        if (permission === "granted") {
            showToast("Notifications enabled successfully!", "success");
            sendAppNotification("NovaWatch Notifications Active", {
                body: "You will now receive alerts for upcoming releases and new episodes!"
            });
        } else {
            showToast("Notification permission denied.", "error");
        }
    } catch (err) {
        console.error("Error requesting notification permission:", err);
        showToast("Could not enable notifications.", "error");
    }
}

function sendAppNotification(title, options = {}) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
        return;
    }
    
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(registration => {
            registration.showNotification(title, {
                icon: "https://www.novawatch.site/images/NovaWatch_App_Icon.png",
                badge: "https://www.novawatch.site/images/NovaWatch_App_Icon.png",
                ...options
            });
        }).catch(() => {
            new Notification(title, { icon: "https://www.novawatch.site/images/NovaWatch_App_Icon.png", ...options });
        });
    } else {
        new Notification(title, { icon: "https://www.novawatch.site/images/NovaWatch_App_Icon.png", ...options });
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

let toastActionHandler = null;

function showToast(message, type = null, action = null) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    document.getElementById("toastMessage").textContent = message;

    const icon = document.getElementById("toastIcon");
    if (icon) {
        if (type === "success") {
            icon.style.display = "flex";
            icon.className = "toast-icon success";
            icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        } else if (type === "error") {
            icon.style.display = "flex";
            icon.className = "toast-icon error";
            icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        } else {
            icon.style.display = "none";
            icon.innerHTML = "";
        }
    }

    const actionBtn = document.getElementById("toastAction");
    if (actionBtn) {
        if (action && action.label) {
            actionBtn.textContent = action.label;
            actionBtn.style.display = "block";
            toastActionHandler = action.onClick;
        } else {
            actionBtn.style.display = "none";
            toastActionHandler = null;
        }
    }

    toast.classList.add("show");
    clearTimeout(toastTimer);
    // Give toasts with an undo action a beat longer, since there's an
    // extra decision (tap Undo or let it stand) instead of just reading it.
    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
        toastActionHandler = null;
    }, action ? 4500 : 3000);
}

function handleToastAction(event) {
    event.stopPropagation();
    const toast = document.getElementById("toast");
    const handler = toastActionHandler;
    toastActionHandler = null;
    clearTimeout(toastTimer);
    if (toast) toast.classList.remove("show");
    if (handler) handler();
}

function clearSearch(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = "";
    input.parentElement.classList.remove("has-text");
    if (inputId === "onlineSearchInput") fetchForYou();
    if (inputId === "tvLibrarySearchInput") renderTVLibrarySection();
    if (inputId === "movieLibrarySearchInput") renderMovieLibrarySection();
    if (inputId === "regionSearchInput") filterRegionOptions("");
}

document.addEventListener("DOMContentLoaded", () => {
    // The inline head script already applied the right theme before first
    // paint (saved choice, or OS preference if none saved yet) - this just
    // keeps it live-following the OS afterward when no explicit Light/Dark
    // choice exists, and syncs the Settings toggle to match.
    if (getSavedThemeMode() === 'auto') setupOSThemeListener();
    syncThemeToggleUI();

    const versionLabel = document.getElementById("appVersionLabel");
    if (versionLabel) versionLabel.textContent = `v${APP_VERSION}`;

    const searchInputs = ['onlineSearchInput', 'tvLibrarySearchInput', 'movieLibrarySearchInput', 'regionSearchInput'];
    
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
    checkTodaysReleases();

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
    // also re-renders whichever tab is open, not just the notification
    // check, so Upcoming/Continue Watching/Home actually reflect the
    // change within this window instead of staying stale until the next
    // navigation or data sync happens to touch them.
    setInterval(() => {
        checkTodaysReleases();
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

// The real-world convention most STREAMING platforms (Netflix, Disney+,
// Hulu, etc.) actually use: everything drops at once. Deliberately a
// FIXED UTC-8 offset, NOT the DST-aware America/Los_Angeles lookup
// getTimezoneAnchorUTC() normally does - real-world observation
// confirmed this: a Netflix release consistently lands at 10:00 in
// South Africa (SAST, UTC+2, which doesn't observe its own DST) year-
// round, never drifting to 9:00 during the months US clocks are on PDT.
// That's only possible if the platform's internal target is a fixed
// "Pacific Standard Time" (UTC-8 always), not a civil Pacific Time that
// follows US Daylight Saving - a streaming release cutover is a company
// policy choice, not a literal broadcast timeslot, so there's no reason
// it would shift with US clocks the way an actual over-the-air schedule
// does (see getBroadcastPrimetimeUTC below, which genuinely should stay
// DST-aware, since a broadcast station's schedule grid IS tied to real
// civil clock time).
// The real-world convention most STREAMING platforms (Netflix, Disney+,
// Hulu, etc.) actually use: everything drops at once, at midnight in the
// civil America/Los_Angeles timezone - genuinely DST-aware (Netflix's own
// stated policy is "12:01 AM Pacific Time", meaning the actual civil
// Pacific clock, which shifts between PST/UTC-8 in winter and PDT/UTC-7
// in summer, exactly like every other Pacific-time civil clock does).
// This is the default anchor for anything that isn't a US broadcast/cable
// network (see isBroadcastNetworkShow below) or a known streaming
// platform being handled separately.
function getPacificMidnightUTC(dateStr) {
    return getTimezoneAnchorUTC(dateStr, "America/Los_Angeles", 0, 0, -8);
}

// Broadcast AND cable networks both work the same way for this purpose -
// neither is a streaming-style all-at-once drop, both air on a fixed
// weekly schedule at a specific advertised timeslot that varies show to
// show, and TMDB doesn't give us that per-show slot for either kind. 8 PM
// EASTERN is the earliest/most common US primetime start - a real,
// deliberate approximation of "some time during the primetime block",
// not a claim of the exact minute a specific show actually airs. Better
// than treating a scheduled network show as a midnight-Pacific streaming
// drop (which it isn't, broadcast or cable).
function getBroadcastPrimetimeUTC(dateStr) {
    return getTimezoneAnchorUTC(dateStr, "America/New_York", 20, 0, -5);
}

// Named/kept as "broadcast" for compatibility with the isBroadcastNetwork
// field already persisted on existing library items (renaming it would
// silently lose that stored value for every show already added, until
// the next sync) - despite the name, this list covers major US CABLE
// networks too, not just the original 6 broadcast ones. A cable show
// that only ever got the earlier broadcast-only list would fall through
// to the midnight-Pacific streaming default, which is just as wrong for
// scheduled cable programming as it was for broadcast.
const US_BROADCAST_NETWORKS = [
    // Broadcast
    "NBC", "ABC", "CBS", "FOX", "The CW", "PBS",
    // Major scheduled cable
    "AMC", "FX", "FXX", "USA Network", "TNT", "TBS", "Bravo",
    "Discovery", "A&E", "Lifetime", "Syfy", "Comedy Central",
    "MTV", "VH1", "E!", "History", "National Geographic",
    "Freeform", "Nickelodeon", "Cartoon Network", "Adult Swim",
    "HBO", "Showtime", "Starz", "Paramount Network"
];

// TMDB's /tv/{id} response includes a `networks` array by default (no
// append_to_response needed) - this just checks it against the list
// above. Anything not on it (a streaming original, an international
// network, something genuinely obscure) falls back to the midnight-
// Pacific streaming anchor, which is the safer default for content this
// list doesn't specifically recognize.
// Corporate ownership overlaps make simple network-name matching alone
// unsafe for a real chunk of major streaming platforms: Disney owns ABC,
// Freeform, FX, FXX, and National Geographic (all in the broadcast/cable
// list above); Paramount+ owns CBS; Peacock owns NBC, USA Network,
// Bravo, and Syfy; Max owns TNT and TBS; Hulu is Disney-owned too. A
// streaming Original can plausibly get tagged in TMDB's own network data
// with one of its corporate siblings even though it only actually
// streams on the platform itself, at the platform's own midnight-
// Pacific schedule, not any sibling's broadcast timeslot - this is the
// confirmed root cause of Disney+ specifically showing wrong times
// despite the platform never being intended to match as broadcast.
// Checked FIRST, before US_BROADCAST_NETWORKS below, so a co-listed
// corporate sibling can never override the platform a show actually
// streams on.
const PRIORITY_STREAMING_PLATFORMS = [
    "Netflix", "Disney+", "Hulu", "Max", "HBO Max", "Apple TV+",
    "Paramount+", "Peacock", "Amazon", "Amazon Prime Video",
    "Amazon Video", "Crunchyroll"
];

function isBroadcastNetworkShow(networks) {
    if (!networks || !Array.isArray(networks)) return false;
    if (networks.some(n => n && PRIORITY_STREAMING_PLATFORMS.includes(n.name))) {
        return false;
    }
    return networks.some(n => n && US_BROADCAST_NETWORKS.includes(n.name));
}

// A SECOND, independent signal, on top of isBroadcastNetworkShow() above -
// TMDB's `networks` field mainly tracks the ORIGINATING/PRODUCING network,
// which for a show co-produced by a cable network but distributed
// internationally through a streaming app can list ONLY the producing
// network, with no mention of the streaming platform at all. A real,
// confirmed case: FX's "The Shards" - produced by FX (correctly matches
// US_BROADCAST_NETWORKS), watched via Disney+ internationally, but with
// no "Disney+" entry in `networks` for the PRIORITY_STREAMING_PLATFORMS
// check above to catch - there's nothing to prioritize over "FX" in the
// first place, since Disney+ was never listed there at all. Checking the
// viewer's own CONFIRMED watch-provider data (the same TMDB endpoint the
// "Watch On" section already uses) closes that gap: if a known streaming
// platform is confirmed to actually carry this title in the viewer's own
// region, that's treated as authoritative over `networks`, regardless of
// what network produced it. Only called when isBroadcastNetworkShow()
// already returned true (see the 3 TV fetch sites) - shows already
// excluded by the networks check don't need this extra request. Fails
// soft (false) on any error, same as every other TVmaze/TMDB call here -
// never blocks or breaks an add/sync.
const KNOWN_STREAMING_PROVIDER_NAMES = [
    "netflix", "disney plus", "disney+", "hulu", "max", "hbo max",
    "apple tv plus", "apple tv+", "paramount plus", "paramount+",
    "peacock", "amazon prime video", "amazon video", "crunchyroll"
];

async function isConfirmedOnStreamingPlatform(tmdbId, mediaType) {
    try {
        const res = await fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`);
        const data = await res.json();
        const results = data.results || {};
        const regionData = results[getUserRegion()] || results.US;
        if (!regionData) return false;
        const flatrate = regionData.flatrate || [];
        return flatrate.some(p => {
            const name = (p && p.provider_name || "").toLowerCase();
            return KNOWN_STREAMING_PROVIDER_NAMES.some(known => name.includes(known));
        });
    } catch (err) {
        return false;
    }
}

// TV EPISODE TIMING: TMDB date + real-world convention only, no TVmaze.
//
// REWORK NOTE (this replaced the entire TVmaze integration): every
// previous attempt at using TVmaze's per-episode airtime data ran into
// the same underlying problem repeatedly, in different shapes - TVmaze's
// own data for a given show could be a wrong-show match, a wrong-episode
// match, or (confirmed directly via two separate real diagnostic
// screenshots) a flat, un-resolved placeholder timestamp that LOOKS
// well-formed but isn't a real time at all. Each fix closed one specific
// failure mode and a new one kept surfacing - matching the wrong show,
// matching the wrong episode, a per-episode sanity-check tolerance that
// was too loose, a show missing real network/timezone data on TVmaze's
// own end, a placeholder region literally named "UTC" passing as if it
// were real. That pattern - fixing one failure mode only to have another
// appear - is what a genuinely unreliable, unverifiable data source
// looks like, not a bug that eventually gets fully closed by one more
// validation layer.
//
// This is the deliberate response to that: stop trying to source a
// specific clock TIME from anywhere at all, for any show, and never
// display one for TV. What's left is simple and fully verified:
// getPacificMidnightUTC()/getBroadcastPrimetimeUTC() below anchor TMDB's
// own reported date to a real-world release convention (streaming
// platforms drop everything at midnight Pacific; US broadcast/cable
// airs in the Eastern primetime block) - both DST-aware, both verified
// against known-correct reference points multiple times over. Every
// episode's DATE is computed the exact same way, every time, with
// nothing per-show or per-episode that can silently be wrong the way an
// external, per-title data source could be. The trade-off, stated
// plainly: this is an inferred convention, not every individual show's
// verified real airtime - accepted deliberately, because "correct date,
// no fabricated time" beats "sometimes-right, sometimes-wrong time from
// a source that kept finding new ways to be unreliable."
function tmdbDateToISO(dateStr, isBroadcastNetwork) {
    if (!dateStr) return null;
    const anchorMs = isBroadcastNetwork
        ? getBroadcastPrimetimeUTC(dateStr)
        : getPacificMidnightUTC(dateStr);
    return new Date(anchorMs).toISOString();
}

/* =========================================================
   TV EPISODE TIMING PIPELINE (shared)
   Single source of truth for turning TMDB season/episode data into the
   standardized per-episode timing fields (releaseDate/timingSource/
   rawTmdbAirDate), and for the show-level fields built from the same
   input (the final isBroadcast classification, nextEpisodeAirDate).

   REWORK NOTE: this used to also take a TVmaze-sourced airtimes map and
   prefer it over the TMDB-date approximation whenever validated. TVmaze
   has been removed entirely (see the comment above tmdbDateToISO) -
   every episode's timing is now computed the same simple way, always.
   Kept as shared functions rather than folding back into each of the 3
   call sites, for the same reason as before: three independent copies
   of the same logic drift over time, one gets a fix the others don't.
========================================================= */

// A season's episode fetch, retried once before giving up on it. Only
// the background sync used to get this retry originally (see the BUG
// FIX note in buildEpisodesFromSeasons() below for why that mattered) -
// the preview and add-to-library flows made one bare, un-retried attempt
// per season, meaning a single transient failure (a network blip, a
// rate limit) on the very first load of a show could silently ship it
// with a season missing entirely, never retried, never surfaced as an
// error. Sharing this one implementation closes that gap for every
// caller at once.
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

// Resolves the classification every episode's timing anchor is built
// from: whether this show gets the broadcast/cable convention (8pm
// Eastern) or the streaming convention (midnight Pacific) - see
// isBroadcastNetworkShow()/isConfirmedOnStreamingPlatform() above for
// how that's decided. Kept as its own async function (rather than
// inlined at each call site) since isConfirmedOnStreamingPlatform() is
// itself a network call, and every caller already awaits this the same
// way regardless.
async function resolveShowTimingContext(showData) {
    const isBroadcastByNetwork = isBroadcastNetworkShow(showData.networks);
    const isBroadcast = isBroadcastByNetwork
        ? !(await isConfirmedOnStreamingPlatform(showData.id, 'tv'))
        : false;
    return { isBroadcast };
}

// Builds one standardized episode object from a single TMDB episode plus
// the show's isBroadcast classification above - the one place that
// decides an episode's actual releaseDate and the fields the debug tool
// (showTimingDebugInfo) depends on.
function buildEpisodeTimingFields(seasonNumber, ep, isBroadcast) {
    const epId = `s${seasonNumber}e${ep.episode_number}`;

    return {
        id: epId,
        season: seasonNumber,
        number: ep.episode_number,
        title: ep.name || `Episode ${ep.episode_number}`,
        overview: ep.overview || '',
        still: ep.still_path ? `https://image.tmdb.org/t/p/w780${ep.still_path}` : '',
        runtime: ep.runtime ? `${ep.runtime} min` : "45 min",
        watched: false,
        watchedAt: null,
        releaseDate: ep.air_date ? tmdbDateToISO(ep.air_date, isBroadcast) : new Date().toISOString(),
        // Diagnostic-only fields, surfaced via showTimingDebugInfo() - lets
        // a specific episode's actual computed timing be checked directly
        // (which convention, TMDB's raw date, the result) instead of
        // guessing from the outside.
        timingSource: isBroadcast ? 'approx-broadcast' : 'approx-streaming',
        rawTmdbAirDate: ep.air_date || null
    };
}

// Turns a batch of already-fetched TMDB season payloads into the full,
// flat episode list for a show, via buildEpisodeTimingFields() for each
// episode. `seasonsData` and `validSeasons` must be the same length and
// in the same order (index i of one corresponds to index i of the
// other) - every call site builds them that way via Promise.all over a
// validSeasons.map(...) list.
//
// existingEpisodes (optional) is the item's own already-stored episode
// list. BUG FIX, now shared by every caller instead of sync-only: a
// season whose fetch still failed even after fetchTMDBSeason()'s retry
// falls back to that season's EXISTING episodes, completely untouched,
// instead of being silently dropped. A single transient season failure
// used to be enough to wipe that season's episodes - watched history
// included - the moment it happened during a background sync, with
// nothing shown anywhere; falling back instead means worst case that
// one season's data is a sync cycle stale, never lost. (For a brand new
// add, existingEpisodes is naturally empty/omitted, so a failed season
// there just contributes no episodes yet - there's nothing prior to
// fall back to, and the next sync will pick it up.)
function buildEpisodesFromSeasons(validSeasons, seasonsData, isBroadcast, existingEpisodes = null) {
    const episodes = [];
    validSeasons.forEach((season, i) => {
        const seasonData = seasonsData[i];
        if (seasonData && seasonData.episodes) {
            seasonData.episodes.forEach(ep => {
                episodes.push(buildEpisodeTimingFields(seasonData.season_number, ep, isBroadcast));
            });
        } else if (existingEpisodes && existingEpisodes.length > 0) {
            episodes.push(...existingEpisodes.filter(ep => ep.season === season.season_number));
        }
    });
    return episodes;
}

// The show-level "next episode" timing field works exactly like a single
// episode's releaseDate above, but TMDB exposes it as its own top-level
// next_episode_to_air object rather than as part of a season fetch.
function computeNextEpisodeAirDate(showData, isBroadcast) {
    const next = showData.next_episode_to_air;
    if (!next || !next.air_date) return null;
    return tmdbDateToISO(next.air_date, isBroadcast);
}

// timeZone defaults to UTC - correct for movies and streaming TV, since
// their anchor (see tmdbDateToISO/getPacificMidnightUTC) always lands
// within the same UTC calendar day as the date TMDB reported. A
// broadcast show's 8pm-Eastern anchor does NOT (it crosses into the next
// UTC day - 8pm ET is after midnight UTC) - passing "America/New_York"
// here for THAT specific case keeps the displayed date matching what
// TMDB and the network itself call the air date, instead of showing one
// day later than it should.
function formatDate(date, timeZone = "UTC") {
    if (!date) return "TBA";
    const options = {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric"
    };
    if (timeZone) options.timeZone = timeZone;
    return new Intl.DateTimeFormat("en-ZA", options).format(new Date(date));
}

// Shows just the date - reworked per explicit request to never show a
// clock time for TV at all, only the date, so the one thing being
// verified is date correctness with nothing else in the way. See the
// tmdbDateToISO comment above for why: real per-episode time data
// (TVmaze) kept surfacing new ways to be wrong across many rounds of
// fixes, and each fix just uncovered the next failure mode rather than
// eventually closing all of them - "always show a correct date, never a
// possibly-wrong time" is the deliberately simpler, more reliable
// alternative. formatReleaseTime() (the clock-time formatter) is gone
// entirely along with it - nothing calls it anymore.
function formatDateWithReleaseTime(date) {
    if (!date) return "TBA";
    return formatDate(date, null);
}

// DIAGNOSTIC ONLY - not a permanent, polished feature, just a direct way
// to see exactly what's driving a title's displayed date (which
// convention, TMDB's raw date, the result) without guessing from the
// outside. Tapped by tapping the (dotted-underlined) date text itself,
// for any episode row, the single-episode modal, or a movie's own meta
// line. episodeId is null for a movie (always the streaming convention -
// movies have no broadcast/cable concept and no per-episode data).
function showTimingDebugInfo(episodeId) {
    if (!currentItem) return;

    if (episodeId === null || currentItem.type === 'movie') {
        const lines = [
            `${currentItem.title} (movie)`,
            ``,
            `Timing source: streaming convention (midnight Pacific)`,
            `Stored release instant (UTC): ${currentItem.releaseDate || '(none)'}`,
            `Date shown to you: ${currentItem.releaseDate ? formatDate(currentItem.releaseDate, null) : '(n/a)'}`,
            `Your device's own timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
        ];
        alert(lines.join('\n'));
        return;
    }

    if (!currentItem.episodes) return;
    const ep = currentItem.episodes.find(e => e.id === episodeId);
    if (!ep) return;

    const sourceLabel = {
        'approx-broadcast': 'broadcast/cable convention (8PM Eastern)',
        'approx-streaming': 'streaming convention (midnight Pacific)'
    }[ep.timingSource] || 'Unknown';

    const lines = [
        `${currentItem.title} — S${ep.season}E${ep.number}: ${ep.title}`,
        ``,
        `Timing source: ${sourceLabel}`,
        `TMDB air_date: ${ep.rawTmdbAirDate || '(none)'}`,
        `Stored release instant (UTC): ${ep.releaseDate || '(none)'}`,
        `Date shown to you: ${ep.releaseDate ? formatDate(ep.releaseDate, null) : '(n/a)'}`,
        `Your device's own timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
    ];

    alert(lines.join('\n'));
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

/* =========================================================
   RELEASE-DAY NOTIFICATIONS
========================================================= */
// Scans the whole library directly (not the Upcoming tab's own filtered
// list) for movies/episodes whose release date is exactly `daysOffset` days
// from today. Used to reliably catch "this is out today" the moment it's
// true, independent of how the Upcoming tab itself displays things.
function getReleasesForDay(daysOffset = 0) {
    const results = [];

    state.library.forEach(item => {
        if (item.type === 'movie') {
            if (item.releaseDate && daysUntil(item.releaseDate) === daysOffset) {
                results.push({ item, type: 'movie', title: item.title, subtitle: 'Movie Release', date: new Date(item.releaseDate) });
            }
        } else if (item.episodes) {
            item.episodes.forEach(episode => {
                if (episode.releaseDate && daysUntil(episode.releaseDate) === daysOffset) {
                    results.push({ item, type: 'tv', title: item.title, subtitle: `S${episode.season} E${episode.number} - ${episode.title}`, date: new Date(episode.releaseDate) });
                }
            });
        }
    });

    return results;
}

// Fires a notification for anything releasing today, exactly once per item
// per day (tracked in localStorage so re-opening the app or re-running the
// background check doesn't spam the same notification repeatedly).
const TODAYS_RELEASE_NOTIFIED_KEY = "novawatch_notifiedReleaseDay";

function checkTodaysReleases() {
    const releases = getReleasesForDay(0);
    if (releases.length === 0) return;

    const t = getLocalTodayParts();
    const todayStamp = `${t.y}-${t.m}-${t.d}`;

    let record = { day: todayStamp, ids: [] };
    try {
        const raw = localStorage.getItem(TODAYS_RELEASE_NOTIFIED_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.day === todayStamp) record = parsed;
        }
    } catch (e) {
        // If the stored record is corrupt, just fall back to a fresh one for today.
    }

    let changed = false;
    releases.forEach(release => {
        const releaseId = release.type === 'movie'
            ? `movie:${release.item.id}`
            : `tv:${release.item.id}:${release.subtitle}`;

        if (record.ids.includes(releaseId)) return;

        sendAppNotification(
            release.type === 'movie' ? "Out Today!" : "New Episode Today!",
            { body: `${release.title} - ${release.subtitle}` }
        );
        record.ids.push(releaseId);
        changed = true;
    });

    if (changed) {
        try {
            localStorage.setItem(TODAYS_RELEASE_NOTIFIED_KEY, JSON.stringify(record));
        } catch (e) {
            // Non-fatal — worst case the notification could repeat next check.
        }
    }
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
            region: state.region
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
        showToast("Cloud sync not configured yet.", "error");
        return;
    }

    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        await auth.signInWithPopup(provider);
        showToast("Signed in with Google!", "success");
    } catch (err) {
        console.error("Google Sign-In Error:", err);
        showToast(err.message || "Failed to sign in with Google.", "error");
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
        showToast("Cloud sync not configured yet.", "error");
        return;
    }

    clearPasswordError();

    if (!email) {
        showToast("Please enter your email address.", "error");
        return;
    }

    if (!password) {
        showToast("Please enter your password.", "error");
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
            showToast("No account found with that email address.", "error");
        } else if (err.code === "auth/invalid-email") {
            showToast("Please enter a valid email address.", "error");
        } else if (err.code === "auth/too-many-requests") {
            showToast("Too many attempts. Please try again later.", "error");
        } else if (err.code === "auth/user-disabled") {
            showToast("This account has been disabled.", "error");
        } else {
            showToast(err.message || "Unable to sign in.", "error");
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

async function handleForgotPassword() {
    if (!auth) {
        showToast("Cloud sync not configured yet.", "error");
        return;
    }

    const emailInput = document.getElementById("authEmail");
    const email = emailInput ? emailInput.value.trim() : "";

    // Deliberately no window.prompt() fallback here - native browser
    // dialogs (prompt/alert/confirm) are unreliable and often silently do
    // nothing inside an installed standalone PWA on mobile, which is this
    // app's primary context. Asking in-app instead is the reliable path.
    if (!email) {
        showToast("Enter your email address above first.", "error");
        if (emailInput) emailInput.focus();
        return;
    }

    try {
        await auth.sendPasswordResetEmail(email);
        showToast(`Password reset email sent to ${email}.`, "success");
    } catch (err) {
        console.error("Password Reset Error:", err);

        if (err.code === "auth/user-not-found") {
            // Deliberately vague to avoid confirming which emails have accounts.
            showToast("If that email has an account, a reset link has been sent.", "success");
        } else if (err.code === "auth/invalid-email") {
            showToast("Please enter a valid email address.", "error");
        } else if (err.code === "auth/too-many-requests") {
            showToast("Too many attempts. Please try again later.", "error");
        } else {
            showToast(err.message || "Couldn't send reset email right now.", "error");
        }
    }
}

async function handleSignUp() {
    const username = document.getElementById("authUsername").value.trim();
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;

    if (!auth) {
        showToast("Cloud sync not configured yet.", "error");
        return;
    }

    clearPasswordError();

    // Username validation
    if (!username) {
        showToast("Please enter a username to register.", "error");
        return;
    }

    if (!isValidUsernameFormat(username)) {
        showToast("Usernames must be 3-20 characters: lowercase letters, numbers, dots, and underscores only.", "error");
        return;
    }

    if (!email) {
        showToast("Please enter your email address.", "error");
        return;
    }

    // Password validation
    if (!password) {
        showToast("Please enter a password.", "error");
        return;
    }

    // Password must be at least 6 characters
    if (password.length < 6) {
        showPasswordError("Password is too short. It must be at least 6 characters.");
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
            showToast("That username is already taken. Please choose another.", "error");
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
            showToast("That username was just taken by someone else. Please choose another.", "error");
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
            showToast("This email address is already registered.", "error");
        } else if (err.code === "auth/invalid-email") {
            showToast("Please enter a valid email address.", "error");
        } else {
            showToast(err.message || "Unable to create your account.", "error");
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
        hideChooseUsernameScreen();
        refreshActivePage();
        showToast("Signed out successfully.", "success");
    } catch (err) {
        showToast(err.message, "error");
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
            showToast("Not verified yet - tap the link in your email first.", "error");
        }
    } catch (err) {
        console.error("Failed to refresh verification status:", err);
        if (!silent) showToast("Couldn't check verification status. Please try again.", "error");
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
            showToast("Please wait a bit before requesting another email.", "error");
        } else {
            showToast("Couldn't send verification email. Please try again.", "error");
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
    if (Date.now() < NOVAWRAPPED_RELEASE_MS) {
        showToast("Available 1 January 2027 @ 00:00 UTC", "error");
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
                    showEpisodeCounts.set(item.id, { title: item.title, count: 1 });
                }
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
            <div class="wrapped-hero-sub">Everything you watched, one year at a time.</div>
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
        <div class="analytics-card" style="margin-top: 0;">
            <div class="analytics-main">
                <div class="analytics-icon-badge">
                    <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </div>
                <div>
                    <div class="stat-label" style="text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Total Watch Time</div>
                    <div class="stat-value highlight">${stats.days} days, ${stats.hours} hours, ${stats.minutes} minutes</div>
                </div>
            </div>
            <div class="stats">
                <div class="stat">
                    <svg class="icon stat-icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>
                    <div class="stat-value">${stats.showsCount}</div>
                    <div class="stat-label">TV Shows</div>
                </div>
                <div class="stat">
                    <svg class="icon stat-icon" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M2 7l4-4h3l-4 4H2z"/><path d="M11 7l4-4h3l-4 4h-3z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>
                    <div class="stat-value">${stats.moviesCount}</div>
                    <div class="stat-label">Movies</div>
                </div>
                <div class="stat">
                    <svg class="icon stat-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <div class="stat-value">${stats.episodesCount}</div>
                    <div class="stat-label">Episodes</div>
                </div>
            </div>
        </div>

        ${stats.topShow ? `
        <div class="section-header" style="margin-top: 20px;"><div class="section-title settings-section-title">Most Watched Show</div></div>
        <div class="analytics-card" style="margin-top: 0;">
            <div class="analytics-main" style="border-bottom: none; padding-bottom: 0;">
                <div>
                    <div class="spotlight-title">${escapeHTML(stats.topShow.title)}</div>
                    <div class="stat-label">${stats.topShow.count} episode${stats.topShow.count === 1 ? '' : 's'} watched</div>
                </div>
            </div>
        </div>` : ''}

        ${stats.busiestMonth ? `
        <div class="section-header" style="margin-top: 20px;"><div class="section-title settings-section-title">Busiest Month</div></div>
        <div class="analytics-card" style="margin-top: 0;">
            <div class="analytics-main" style="border-bottom: none; padding-bottom: 0;">
                <div>
                    <div class="spotlight-title">${stats.busiestMonth.label}</div>
                    <div class="stat-label">${Math.round(stats.busiestMonth.minutes / 60)} hours watched</div>
                </div>
            </div>
        </div>` : ''}
    `;
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
                showToast("Account deletion cancelled - please try again.", "error");
            } else {
                try {
                    await attemptDelete();
                    closeDeleteAccountModal();
                    showToast("Your account has been deleted.", "success");
                } catch (err2) {
                    console.error("Account deletion failed after reauthentication:", err2);
                    showToast("Couldn't delete your account. Please try again.", "error");
                }
            }
        } else {
            console.error("Account deletion failed:", err);
            showToast("Couldn't delete your account. Please try again.", "error");
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

function refreshActivePage() {
    if (document.getElementById("libraryPage").classList.contains("active")) {
        if (currentLibraryView === 'tv') renderTVLibrarySection();
        if (currentLibraryView === 'movies') renderMovieLibrarySection();
    }
    if (document.getElementById("upcomingPage").classList.contains("active")) renderUpcomingTab();
    if (document.getElementById("homePage").classList.contains("active")) renderHomeTab();
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

        // Run regardless of whether anything changed above — the point is to
        // catch the calendar day rolling over onto a release, not just new data.
        checkTodaysReleases();
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
                    const res = await fetch(`https://api.themoviedb.org/3/tv/${item.tmdbId}?api_key=${TMDB_API_KEY}`);
                    const showData = await res.json();
                    if (!showData || !showData.seasons) return { changed: false, failed: false };
                    // See isBroadcastNetworkShow()/getBroadcastPrimetimeUTC() -
                    // resolveShowTimingContext() (shared by every place that builds
                    // episode timing, see the TV EPISODE TIMING PIPELINE comment
                    // above) resolves this alongside the streaming-provider cross-
                    // check, kicked off in parallel with the season fetches below
                    // rather than adding sequential latency.
                    const validSeasons = showData.seasons.filter(s => s.season_number > 0);
                    const [seasonsData, timingContext] = await Promise.all([
                        Promise.all(validSeasons.map(season => fetchTMDBSeason(item.tmdbId, season.season_number))),
                        resolveShowTimingContext(showData)
                    ]);
                    const { isBroadcast } = timingContext;
                    // BUG FIX (now shared logic - see buildEpisodesFromSeasons()):
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
                    const newEpisodes = buildEpisodesFromSeasons(validSeasons, seasonsData, isBroadcast, item.episodes);

                    // Merge against the existing episode list: keep each episode's
                    // watched flag (and the date it was watched on - see
                    // setEpisodeWatched), but pick up any TMDB edit (renamed
                    // episode, fixed synopsis/still/air date/runtime) and flag
                    // genuinely new episodes for a notification. This runs on
                    // every periodic background sync, so skipping the watchedAt
                    // carryover here would quietly erase every per-episode watch
                    // date shortly after it was first set.
                    let hasNewContent = false;
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
                                    existing.releaseDate !== newEp.releaseDate ||
                                    existing.still !== newEp.still ||
                                    existing.runtime !== newEp.runtime ||
                                    // Real, confirmed bug closed here (kept from before
                                    // the TVmaze removal, since the same failure mode
                                    // applies to ANY new field added to an episode's
                                    // shape): comparing this explicitly catches an old-
                                    // schema episode missing a newer field even when
                                    // every other field already happens to match, so a
                                    // sync doesn't silently report "nothing changed" and
                                    // skip backfilling it. If a new field is ever added
                                    // to an episode's shape again, add it here too.
                                    existing.timingSource !== newEp.timingSource
                                ) {
                                    episodesChanged = true;
                                }
                            } else {
                                hasNewContent = true;
                                episodesChanged = true;
                                sendAppNotification(`New Episode Available!`, {
                                    body: `${item.title} - S${newEp.season}E${newEp.number}: ${newEp.title}`
                                });
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
                    const newReleaseDate = showData.first_air_date ? tmdbDateToISO(showData.first_air_date, isBroadcast) : item.releaseDate;
                    const newStatus = showData.status || item.status || '';
                    const newRating = (typeof showData.vote_average === 'number' && showData.vote_average > 0)
                        ? showData.vote_average.toFixed(1)
                        : (item.rating || '');
                    const newSeasonCount = (typeof showData.number_of_seasons === 'number') ? showData.number_of_seasons : item.numberOfSeasons;
                    const newEpisodeCount = (typeof showData.number_of_episodes === 'number') ? showData.number_of_episodes : item.numberOfEpisodes;
                    const newNextAirDate = computeNextEpisodeAirDate(showData, isBroadcast);

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
                        item.numberOfEpisodes !== newEpisodeCount ||
                        (item.nextEpisodeAirDate || null) !== newNextAirDate
                    );

                    if (episodesChanged || metadataChanged) {
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
                        item.nextEpisodeAirDate = newNextAirDate;
                        item.isBroadcastNetwork = isBroadcast;

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
   country code), auto-detected once from the browser's locale and
   editable any time from the "Streaming region" control on Home - see
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
// This is only ever a starting point - it can easily be wrong (a device
// left on "en-US" while physically in another country is common), which
// is exactly why it's stored as an editable, persisted preference rather
// than re-detected and silently overridden every session.
function detectDefaultRegion() {
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
        showToast("Couldn't save region - check your connection and try again.", "error");
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
            await proceedToApp(user, authScreen, mainApp);
        } else {
            hideVerifyScreen();
            hideChooseUsernameScreen();

            // User is logged out: Show Auth Screen, Hide Main App
            authScreen.style.display = "flex";
            mainApp.style.display = "none";

            // Clear local state
            state.library = [];
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
                            state.region = detectDefaultRegion();
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
                        state.region = detectDefaultRegion();
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
            } catch (err) {
                console.error("Error fetching cloud data:", err);
                showToast("Library sync failed.", "error");
                // Stop showing the loading skeleton even though the fetch
                // failed - otherwise Home/Library would be stuck looking
                // like they're still loading forever instead of falling
                // back to their normal (if inaccurately "empty") state.
                libraryLoaded = true;
                refreshActivePage();
            }
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
        // See isBroadcastNetworkShow()/getBroadcastPrimetimeUTC() and the TV
        // EPISODE TIMING PIPELINE comment above. Kicked off here (not
        // awaited yet) so it resolves alongside the season fetches below
        // rather than adding its own sequential delay - the modal below
        // still opens immediately either way. isBroadcastByNetwork (the
        // network-name check alone, synchronous) is used for the INITIAL
        // releaseDate/nextEpisodeAirDate placeholders below, before the
        // streaming-provider cross-check can resolve, so the modal doesn't
        // have to wait to open - corrected below once the real,
        // validated classification is in, same as every other field that
        // depends on it (see the BUG FIX note further down for why this
        // correction matters, not just the initial value).
        const isBroadcastByNetwork = isBroadcastNetworkShow(showData.networks);
        const timingContextPromise = resolveShowTimingContext(showData);

        currentItem = {
            id: previewId,
            tmdbId: showData.id,
            type: 'tv',
            title: showData.name,
            year: showData.first_air_date ? showData.first_air_date.substring(0, 4) : "N/A",
            poster: showData.poster_path ? `https://image.tmdb.org/t/p/w500${showData.poster_path}` : "",
            backdrop: showData.backdrop_path ? `https://image.tmdb.org/t/p/w780${showData.backdrop_path}` : "",
            description: showData.overview || "No description available.",
            releaseDate: showData.first_air_date ? tmdbDateToISO(showData.first_air_date, isBroadcastByNetwork) : null,
            status: showData.status || '',
            rating: (typeof showData.vote_average === 'number' && showData.vote_average > 0) ? showData.vote_average.toFixed(1) : '',
            numberOfSeasons: (typeof showData.number_of_seasons === 'number') ? showData.number_of_seasons : null,
            numberOfEpisodes: (typeof showData.number_of_episodes === 'number') ? showData.number_of_episodes : null,
            nextEpisodeAirDate: (showData.next_episode_to_air && showData.next_episode_to_air.air_date) ? tmdbDateToISO(showData.next_episode_to_air.air_date, isBroadcastByNetwork) : null,
            isBroadcastNetwork: isBroadcastByNetwork,
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
        let isBroadcast = isBroadcastByNetwork;

        if (showData.seasons && showData.seasons.length > 0) {
            const validSeasons = showData.seasons.filter(s => s.season_number > 0);
            const [seasonsData, timingContext] = await Promise.all([
                Promise.all(validSeasons.map(season => fetchTMDBSeason(tmdbId, season.season_number))),
                timingContextPromise
            ]);
            isBroadcast = timingContext.isBroadcast;
            episodes = buildEpisodesFromSeasons(validSeasons, seasonsData, isBroadcast);
        } else {
            const timingContext = await timingContextPromise;
            isBroadcast = timingContext.isBroadcast;
        }

        // The person may have closed the modal or moved on to something
        // else while the season data was in flight - only apply it if
        // they're still looking at this same preview.
        if (currentItem && currentItem.id === previewId) {
            currentItem.episodes = episodes;
            currentItem.episodesLoading = false;
            // Correct the show-level fields set from the pre-correction
            // isBroadcastByNetwork guess above, now that the real,
            // validated classification is in - see the BUG FIX note above.
            currentItem.releaseDate = showData.first_air_date ? tmdbDateToISO(showData.first_air_date, isBroadcast) : null;
            currentItem.nextEpisodeAirDate = computeNextEpisodeAirDate(showData, isBroadcast);
            currentItem.isBroadcastNetwork = isBroadcast;
            scrollToNextEpisodeOnRender = true;
            updateModalContent();
        }

    } catch (err) {
        console.error("Error opening preview details:", err);
        showToast(err?.message?.startsWith("TMDB") ? err.message : "Unable to load details.", "error");
    }
}

async function importMediaData(id, type, buttonElement) {
    if (!auth || !auth.currentUser) {
        showToast("Please sign in to add items to your library.", "error");
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
            sendAppNotification("Added to Library", { body: `You will be notified when ${movieData.title} releases.` });

        } else {
            const availabilityPromise = fetchWatchAvailability(id, 'tv');
            const showRes = await fetch(`https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_API_KEY}`);
            const showData = await showRes.json();

            if (!showRes.ok || !showData || !showData.id || !showData.name) {
                throw new Error(`TMDB show lookup failed: ${showData?.status_message || showRes.status}`);
            }

            const slug = "tv-" + showData.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            if (state.library.some(s => s.id === slug || s.tmdbId === showData.id)) {
                return;
            }
            // See isBroadcastNetworkShow()/getBroadcastPrimetimeUTC() and the
            // TV EPISODE TIMING PIPELINE comment above - resolveShowTimingContext()
            // resolves the streaming-provider cross-check and the final
            // isBroadcast classification, kicked off in parallel with the
            // season fetches below.
            const timingContextPromise = resolveShowTimingContext(showData);

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
            let isBroadcast = false;

            if (showData.seasons && showData.seasons.length > 0) {
                const validSeasons = showData.seasons.filter(s => s.season_number > 0);
                const [seasonsData, timingContext] = await Promise.all([
                    Promise.all(validSeasons.map(season => fetchTMDBSeason(id, season.season_number))),
                    timingContextPromise
                ]);
                isBroadcast = timingContext.isBroadcast;
                episodes = buildEpisodesFromSeasons(validSeasons, seasonsData, isBroadcast);
            } else {
                const timingContext = await timingContextPromise;
                isBroadcast = timingContext.isBroadcast;
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
                releaseDate: showData.first_air_date ? tmdbDateToISO(showData.first_air_date, isBroadcast) : null,
                status: showData.status || '',
                rating: (typeof showData.vote_average === 'number' && showData.vote_average > 0) ? showData.vote_average.toFixed(1) : '',
                numberOfSeasons: (typeof showData.number_of_seasons === 'number') ? showData.number_of_seasons : null,
                numberOfEpisodes: (typeof showData.number_of_episodes === 'number') ? showData.number_of_episodes : null,
                nextEpisodeAirDate: computeNextEpisodeAirDate(showData, isBroadcast),
                isBroadcastNetwork: isBroadcast,
                isFinished: false,
                isStopped: archivedShow ? !!archivedShow.isStopped : false,
                addedAt: new Date().toISOString(),
                episodes: episodes,
                watchProviders: availability.providers,
                inCinemas: availability.inCinemas,
                watchLink: availability.link,
                contentRating: availability.contentRating
            };

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
            sendAppNotification("Added to Library", { body: `You will be notified for new episodes of ${showData.name}.` });
        }
    } catch (error) {
        console.error("Error adding media:", error);
        showToast(error?.message?.startsWith("TMDB") ? error.message : "Failed to add item.", "error");
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

function getAvailableEpisodes(show) {
    if (!show.episodes) return [];
    return show.episodes.filter(episode => isReleased(episode.releaseDate));
}

function getNextUnwatchedEpisode(show) {
    if (!show.episodes || show.episodes.length === 0) return null;
    const sortedEps = [...show.episodes]
        .filter(ep => isReleased(ep.releaseDate))
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

function getUpcomingItems(filterType = null) {
    const results = [];

    state.library.forEach(item => {
        if (item.type === 'movie' && (!filterType || filterType === 'movie')) {
            if (item.releaseDate && !isReleased(item.releaseDate)) {
                results.push({
                    item: item,
                    type: 'movie',
                    title: item.title,
                    subtitle: 'Movie Release',
                    date: new Date(item.releaseDate)
                });
            }
        } else if (item.episodes && (!filterType || filterType === 'tv')) {
            item.episodes
                .filter(episode => episode.releaseDate && !isReleased(episode.releaseDate))
                .forEach(episode => {
                    results.push({
                        item: item,
                        type: 'tv',
                        title: item.title,
                        subtitle: `S${episode.season} E${episode.number} - ${episode.title}`,
                        date: new Date(episode.releaseDate)
                    });
                });
        }
    });

    return results.sort((a, b) => a.date - b.date);
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

// `upcomingShowIds` is an optional pre-computed Set of show ids that have
// upcoming episodes (see getUpcomingTVShowIds()). Passing it in lets callers
// that need this check across the whole library compute the upcoming list
// ONCE instead of once per show - without it, this falls back to computing
// it fresh (still correct, just slower if called in a per-show loop).
function isTVUpToDate(show, upcomingShowIds = null) {
    if (show.type === 'movie' || show.isStopped) return false;
    const progress = getTVProgress(show);
    const hasUpcoming = upcomingShowIds
        ? upcomingShowIds.has(show.id)
        : getUpcomingItems('tv').some(u => u.item.id === show.id);
    return (
        progress.total > 0 &&
        progress.watched === progress.total &&
        hasUpcoming
    );
}

function isTVFinished(show, upcomingShowIds = null) {
    if (show.type === 'movie') return show.watched;
    if (show.isStopped) return false;
    const progress = getTVProgress(show);
    const hasUpcoming = upcomingShowIds
        ? upcomingShowIds.has(show.id)
        : getUpcomingItems('tv').some(u => u.item.id === show.id);
    return (
        progress.total > 0 &&
        progress.watched === progress.total &&
        !hasUpcoming
    );
}

// Computes the "has an upcoming episode" check for every TV show in one
// single pass over the library/episodes, instead of the old approach where
// isTVUpToDate/isTVFinished each re-scanned the entire library from scratch
// for every single show (an O(n^2) cost that's what made switching to the
// Library tab feel laggy on any library of meaningful size).
function getUpcomingTVShowIds() {
    return new Set(getUpcomingItems('tv').map(u => u.item.id));
}

function getLatestAiredEpisodeDate(show) {
    if (!show.episodes || show.episodes.length === 0) return 0;
    const releasedEps = show.episodes.filter(ep => isReleased(ep.releaseDate));
    if (releasedEps.length === 0) return 0;
    
    return Math.max(...releasedEps.map(ep => new Date(ep.releaseDate || 0).getTime()));
}

function sortTVShowsByLatestAired(shows) {
    return shows.sort((a, b) => getLatestAiredEpisodeDate(b) - getLatestAiredEpisodeDate(a));
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
    saveLastTab(page);

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

    if (page === "library") setLibraryView(subType || currentLibraryView);
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
    if (page === "upcoming") {
        renderUpcomingTab();
        // Upcoming was showing stale release times: opening a show's own
        // details modal already triggers a fresh per-item TMDB/TVmaze
        // refresh (refreshOpenItemFromTMDB), which correctly updates
        // that ONE show - but Upcoming aggregates episodes across the
        // WHOLE library, and every other show's data still only refreshes
        // on the periodic 20-minute cycle otherwise. Since checking
        // Upcoming is specifically when accurate timing matters most,
        // trigger the same full sync used by that periodic cycle right
        // now instead of waiting - but only if it hasn't already run
        // recently (2 minutes), so switching to this tab repeatedly
        // doesn't re-fetch the whole library every single time. Runs in
        // the background; checkLibraryForUpdates() itself calls
        // refreshActivePage() if anything actually changed, so the tab
        // updates in place once fresher data comes back.
        const lastCheck = getLastLibraryCheck();
        if (!lastCheck || (now() - lastCheck) > 2 * 60 * 1000) {
            checkLibraryForUpdates();
        }
    }
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

    const DRAG_THRESHOLD = 10;
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

    document.getElementById("libraryTabTV").classList.toggle("active", view === 'tv');
    document.getElementById("libraryTabMovies").classList.toggle("active", view === 'movies');

    document.getElementById("libraryViewTV").style.display = view === 'tv' ? 'block' : 'none';
    document.getElementById("libraryViewMovies").style.display = view === 'movies' ? 'block' : 'none';

    if (view === 'tv') renderTVLibrarySection();
    if (view === 'movies') renderMovieLibrarySection();
}

/* =========================================================
   1. UPCOMING TAB RENDER
========================================================= */
// Buckets items into Today / Tomorrow / This Week / Later so the list reads
// like a schedule instead of one long undifferentiated feed.
function groupUpcomingByTimeframe(items) {
    const buckets = [
        { label: "Today", items: [] },
        { label: "Tomorrow", items: [] },
        { label: "This Week", items: [] },
        { label: "Later", items: [] }
    ];

    items.forEach(data => {
        const days = daysUntil(data.date);
        if (days <= 0) buckets[0].items.push(data);
        else if (days === 1) buckets[1].items.push(data);
        else if (days <= 7) buckets[2].items.push(data);
        else buckets[3].items.push(data);
    });

    return buckets.filter(bucket => bucket.items.length > 0);
}

// Shows TV episode releases or movie releases for the library, one type
// at a time via currentUpcomingFilter - matching the plain TV Shows/
// Movies split used by Discover and Library, rather than a combined
// feed. Still grouped into Today/Tomorrow/This Week/Later within
// whichever type is selected.
function renderUpcomingTab() {
    const listContainer = document.getElementById("upcomingResultsList");
    if (!listContainer) return;

    const items = getUpcomingItems(currentUpcomingFilter);

    if (!items || items.length === 0) {
        const emptyMessages = {
            tv: "No upcoming episodes scheduled in your library.",
            movie: "No upcoming movie releases scheduled in your library."
        };
        setInnerHTMLIfChanged(listContainer, emptyState("No Upcoming Releases", emptyMessages[currentUpcomingFilter]));
        return;
    }

    const groups = groupUpcomingByTimeframe(items);
    const html = groups.map(group => `
        <div class="upcoming-group">
            <div class="upcoming-group-title">${group.label}</div>
            ${group.items.map(data => createUpcomingCard(data)).join("")}
        </div>
    `).join("");
    setInnerHTMLIfChanged(listContainer, html);
}

// Switches the Upcoming tab's type filter and re-renders. Kept as
// persistent module state (like currentLibraryView) so it survives
// switching tabs and coming back, rather than resetting each time.
function setUpcomingFilter(filter) {
    currentUpcomingFilter = filter;

    document.getElementById("upcomingFilterTV").classList.toggle("active", filter === 'tv');
    document.getElementById("upcomingFilterMovies").classList.toggle("active", filter === 'movie');

    renderUpcomingTab();
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
            }
        } else if (item.episodes) {
            let watchedEps = item.episodes.filter(ep => ep.watched);
            totalWatchedEpisodes += watchedEps.length;
            
            watchedEps.forEach(ep => {
                const match = (ep.runtime || "").match(/(\d+)/);
                const mins = match ? parseInt(match[1], 10) : 45;
                const rewatches = ep.rewatchCount || 0;
                totalMinutes += mins * (1 + rewatches);
            });
        }
    });

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    
    document.getElementById("totalWatchTime").textContent = `${days} days, ${hours} hours, ${minutes} minutes`;

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
        setInnerHTMLIfChanged(container, emptyState("No TV Shows Found", "Your TV show library is empty.", { label: "Browse Discover", onclick: "showPage('discover', 'tv')" }));
        return;
    }

    // Computed once up front and reused for every show below, rather than
    // each show re-scanning the whole library for its own upcoming-episode
    // check - see getUpcomingTVShowIds().
    const upcomingShowIds = getUpcomingTVShowIds();

    const inProgress = sortTVShowsByLatestAired(items.filter(item => {
        if (item.isStopped) return false;
        const p = getTVProgress(item);
        return p.watched > 0 && p.watched < p.total;
    }));

    const upToDate = sortTVShowsByLatestAired(items.filter(item => !item.isStopped && isTVUpToDate(item, upcomingShowIds)));
    const finished = sortTVShowsByLatestAired(items.filter(item => !item.isStopped && isTVFinished(item, upcomingShowIds)));
    const unwatched = sortTVShowsByLatestAired(items.filter(item => {
        if (item.isStopped) return false;
        const p = getTVProgress(item);
        return p.total > 0 && p.watched === 0;
    }));
    // Shows with no released episodes at all yet - kept visible but separate
    // from Unwatched, since there's nothing available to start watching.
    const comingSoon = sortTVShowsByLatestAired(items.filter(item => {
        if (item.isStopped) return false;
        const p = getTVProgress(item);
        return p.total === 0;
    }));
    const stopped = sortTVShowsByLatestAired(items.filter(item => item.isStopped));

    let html = "";

    if (inProgress.length > 0) html += renderCategoryBlock("In Progress", inProgress, upcomingShowIds);
    if (upToDate.length > 0) html += renderCategoryBlock("Up to Date", upToDate, upcomingShowIds);
    if (finished.length > 0) html += renderCategoryBlock("Finished", finished, upcomingShowIds);
    if (unwatched.length > 0) html += renderCategoryBlock("Unwatched", unwatched, upcomingShowIds);
    if (comingSoon.length > 0) html += renderCategoryBlock("Coming Soon", comingSoon, upcomingShowIds);
    if (stopped.length > 0) html += renderCategoryBlock("Stopped Watching", stopped, upcomingShowIds);

    if (!html) {
        html = emptyState("No TV Shows Matching", "No TV shows match your search query.");
    }

    setInnerHTMLIfChanged(container, html);
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
        setInnerHTMLIfChanged(container, emptyState("No Movies Found", "Your movie library is empty.", { label: "Browse Discover", onclick: "showPage('discover', 'movie')" }));
        return;
    }

    const unwatched = items.filter(item => !item.watched && isReleased(item.releaseDate));
    const comingSoon = items.filter(item => !item.watched && !isReleased(item.releaseDate));
    const watched = sortMoviesByWatchedDate(items.filter(item => item.watched));

    let html = "";

    if (unwatched.length > 0) html += renderCategoryBlock("Unwatched", unwatched);
    if (comingSoon.length > 0) html += renderCategoryBlock("Coming Soon", comingSoon);
    if (watched.length > 0) html += renderCategoryBlock("Watched", watched);

    if (!html) {
        html = emptyState("No Movies Matching", "No movies match your search query.");
    }

    setInnerHTMLIfChanged(container, html);
}

function renderCategoryBlock(title, items, upcomingShowIds = null) {
    return `
        <div class="category-block">
            <div class="category-title">
                <span>${escapeHTML(title)}</span>
                <span class="category-count">${items.length}</span>
            </div>
            <div class="library-grid">
                ${items.map(item => createCard(item, upcomingShowIds)).join("")}
            </div>
        </div>
    `;
}

/* =========================================================
   CARDS
========================================================= */
function createCard(item, upcomingShowIds = null) {
    const hasPoster = item.poster && item.poster.trim() !== "";

    let progressBarHTML = '';
    if (item.type !== 'movie') {
        const prog = getTVProgress(item);
        if (prog.total > 0 && prog.watched > 0) {
            let barColor = 'var(--blue)';
            if (item.isStopped) {
                barColor = 'var(--text-muted)';
            } else if (isTVFinished(item, upcomingShowIds)) {
                barColor = 'var(--danger)';
            } else if (isTVUpToDate(item, upcomingShowIds)) {
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

function createUpcomingCard(data) {
    const hasPoster = data.item.poster && data.item.poster.trim() !== "";

    return `
        <div class="upcoming-card" onclick="openDetails('${data.item.id}')">
            <div class="upcoming-poster">
                ${hasPoster ? `
                    <img src="${tmdbThumb(data.item.poster, 'w342')}" alt="${escapeHTML(data.title)}" draggable="false" loading="lazy" decoding="async" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="upcoming-poster-placeholder" style="display: none;">${escapeHTML(data.title)}</div>
                ` : `
                    <div class="upcoming-poster-placeholder">${escapeHTML(data.title)}</div>
                `}
            </div>
            <div class="upcoming-info">
                <div class="upcoming-title">${escapeHTML(data.title)}</div>
                <div class="upcoming-date">${escapeHTML(data.subtitle)}</div>
                <div class="upcoming-date">${formatDate(data.date, null)}</div>
                <div class="upcoming-countdown">${getCountdown(data.date)}</div>
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
            { label: "Browse Discover", onclick: "showPage('discover', null, true)" }
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

// Pointer-based swipe-to-dismiss: dragging a card left or right past the
// threshold triggers an action and lets it fly off; a short drag springs
// back. A vertical drag (scrolling) is left alone.
//
// Direction matters: swiping right always marks the up-next episode/movie
// watched (green). Swiping left removes the item outright (red) - or, for
// TV shows with some watched episodes already, marks it Stopped Watching
// instead (orange) so that watch history isn't lost. Movies never have
// partial watch history to protect here (Continue Watching only shows
// unwatched movies), so a movie's left-swipe is always a plain removal.
function initContinueCardSwipe(container) {
    const threshold = 90;

    const RIGHT_BG_HTML = `<span>Mark Watched</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const STOP_BG_HTML = `<span>Stop Watching</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
    const REMOVE_BG_HTML = `<span>Remove</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
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
            showToast("Could not load trailer.", "error");
            return;
        }

        const trailer = (data.results || []).find(v => v.site === "YouTube" && v.type === "Trailer");

        if (trailer) {
            window.open(`https://www.youtube.com/watch?v=${trailer.key}`, '_blank');
        } else {
            showToast("No official trailer found.", "error");
        }
    } catch (err) {
        console.error("Error playing trailer:", err);
        showToast("Could not load trailer.", "error");
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
// recipient to the specific show/movie/episode instead of just the app's
// home screen. Two shapes:
//   ?share_type=tv|movie&share_id=<tmdbId>              - a show or movie
//   ?share_type=episode&share_id=<showTmdbId>&share_ep=sXeY - one episode
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
    if (!isEpisodeShare && !isItemShare) return false;

    // Strip the params so refreshing or navigating within the app doesn't
    // keep reopening the same shared item.
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);

    if (isEpisodeShare) {
        openSharedEpisode(Number(id), epId);
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
        } catch (err) {
            if (err.name !== 'AbortError') console.error("Share failed:", err);
        }
        return;
    }

    if (navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
            showToast("Link copied to clipboard!", "success");
        } catch (err) {
            console.error("Clipboard write failed:", err);
            showToast("Unable to share.", "error");
        }
        return;
    }

    showToast("Sharing isn't supported on this device.", "error");
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
        } catch (err) {
            if (err.name !== 'AbortError') console.error("Share failed:", err);
        }
        return;
    }

    if (navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
            showToast("Link copied to clipboard!", "success");
        } catch (err) {
            console.error("Clipboard write failed:", err);
            showToast("Unable to share.", "error");
        }
        return;
    }

    showToast("Sharing isn't supported on this device.", "error");
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
        showToast("Couldn't reach TMDB - showing saved info.", "error");
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
            <span onclick="showTimingDebugInfo(null)" style="text-decoration: underline; text-decoration-style: dotted; cursor: pointer;">${releaseDateStr}</span>
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
                <button id="modalAddLibBtn" class="action-button ${isAdded ? '' : 'primary'}" style="width: 100%; ${isAdded ? 'background: var(--surface-2); color: var(--success); border: 1px solid rgba(52, 199, 89, 0.3);' : ''}" onclick="addModalItemToLibrary()" ${isAdded ? 'disabled' : ''}>
                    ${isAdded ? 'In Library' : 'Add to Library'}
                </button>
            </div>
        `;
    } else {
        const nextEp = getNextUnwatchedEpisode(currentItem);
        const nextLabel = nextEp ? `S${nextEp.season} E${nextEp.number}` : 'Up to Date';
        const prog = getTVProgress(currentItem);
        const hasReleasedUnwatched = (currentItem.episodes || []).some(ep => !ep.watched && isReleased(ep.releaseDate));

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
                <button id="modalAddLibBtn" class="action-button ${isAdded ? '' : 'primary'}" style="${isAdded ? 'background: var(--surface-2); color: var(--success); border: 1px solid rgba(52, 199, 89, 0.3);' : ''}" onclick="addModalItemToLibrary()" ${isAdded ? 'disabled' : ''}>
                    ${isAdded ? 'In Library' : 'Add to Library'}
                </button>
            </div>
            ${hasReleasedUnwatched ? `
                <div style="margin-top: 10px;">
                    <button class="action-button" style="width: 100%;" onclick="markAllReleasedEpisodesWatched()">
                        Mark All Released Episodes Watched
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
        container.innerHTML = skeletonRows(5);
        return;
    }

    if (!currentItem.episodes || currentItem.episodes.length === 0) {
        container.innerHTML = `<div style="font-size:13px; color:var(--text-muted); margin-top:20px;">No episode info available.</div>`;
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
                const released = isReleased(ep.releaseDate);
                const dateStr = formatDateWithReleaseTime(ep.releaseDate);
                const watchedText = !released ? "Not Released" : (ep.watched ? "Watched" : "Unwatched");
                const watchedColor = !released ? "var(--text-muted)" : (ep.watched ? "var(--success)" : "var(--danger)");
                const isUpNext = nextEp && nextEp.id === ep.id;

                return `
                    <div class="episode ${isUpNext ? 'episode-up-next' : ''}" data-ep-id="${ep.id}" onclick="openEpisodeDetails('${ep.id}')">
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
                                        ${ep.runtime || '45 min'} &bull; <span onclick="event.stopPropagation(); showTimingDebugInfo('${ep.id}')" style="text-decoration: underline; text-decoration-style: dotted; cursor: pointer;">${dateStr}</span> &bull; <span style="color: ${watchedColor}; font-weight:700;">${watchedText}</span>${ep.watched ? ` &bull; <span class="rewatch-count-tap" onclick="event.stopPropagation(); openRewatchPopup('${ep.id}')">Rewatched \u00d7${ep.rewatchCount || 0}</span>` : ''}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join("")}
        </div>
    `;
    container.innerHTML = html;

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
        showToast("Couldn't save - check your connection and try again.", "error");
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
        showToast("Add this to your library first.", "error");
        return;
    }

    const seasonEps = currentItem.episodes.filter(ep => ep.season === seasonNumber);
    if (seasonEps.length === 0) return;

    const releasedEps = seasonEps.filter(ep => isReleased(ep.releaseDate));
    if (releasedEps.length === 0) {
        showToast("No released episodes in this season yet.", "error");
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
        showToast("Add this to your library first.", "error");
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
    
    const btn = document.getElementById("episodeWatchedToggleBtn");
    if (!currentEpisode.watched && !isReleased(currentEpisode.releaseDate)) {
        btn.textContent = "Not Yet Released";
        btn.disabled = true;
    } else {
        btn.textContent = currentEpisode.watched ? "Mark as Unwatched" : "Mark as Watched";
        btn.disabled = false;
    }

    // Only offer the catch-up shortcut when there's actually an earlier
    // released-but-unwatched episode for it to do anything useful with.
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
    document.getElementById("episodeModalMeta").innerHTML = `
        <span>Season ${currentEpisode.season}</span>
        <span>•</span>
        <span>${currentEpisode.runtime || '45 min'}</span>
        <span>•</span>
        <span onclick="showTimingDebugInfo('${currentEpisode.id}')" style="text-decoration: underline; text-decoration-style: dotted; cursor: pointer;">${formatDateWithReleaseTime(currentEpisode.releaseDate)}</span>
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
        showToast("Add this to your library first.", "error");
        return;
    }
    if (!currentEpisode.watched && !isReleased(currentEpisode.releaseDate)) {
        showToast("This episode hasn't been released yet.", "error");
        return;
    }
    setEpisodeWatched(currentEpisode, !currentEpisode.watched);
    await saveItem(currentItem);
    closeEpisodeModal();
    updateModalContent();
    refreshActivePage();
}

// Marks every released episode up to and including the currently open one
// as watched, for catching up in one tap instead of tapping through each
// episode individually. Never touches unreleased episodes.
async function markWatchedUpToCurrentEpisode() {
    if (!currentItem || !currentEpisode || !currentItem.episodes) return;
    if (!isCurrentItemInLibrary()) {
        showToast("Add this to your library first.", "error");
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
    return currentItem.episodes.filter(ep => ep.season === seasonNumber && isReleased(ep.releaseDate));
}

function getSeasonRewatchCount(seasonNumber) {
    const eps = getSeasonReleasedEpisodes(seasonNumber);
    if (eps.length === 0) return 0;
    return Math.min(...eps.map(ep => ep.rewatchCount || 0));
}

function openMovieRewatchPopup() {
    if (!currentItem || currentItem.type !== 'movie') return;
    if (!isCurrentItemInLibrary()) {
        showToast("Add this to your library first.", "error");
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
        showToast("Add this to your library first.", "error");
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
        showToast("Add this to your library first.", "error");
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
        showToast("Add this to your library first.", "error");
        return;
    }
    if (!currentItem.watched && !isReleased(currentItem.releaseDate)) {
        showToast("This movie hasn't been released yet.", "error");
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
        showToast("Add this to your library first.", "error");
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
        showToast("Add this to your library first.", "error");
        return;
    }
    currentItem.isStopped = !currentItem.isStopped;
    await saveItem(currentItem);
    updateModalContent();
    refreshActivePage();
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
        showToast(`Couldn't save - "${item.title}" wasn't marked as Stopped Watching.`, "error");
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
        showToast(`Couldn't remove "${removedItem.title}" - check your connection and try again.`, "error");
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
        showToast(`Couldn't remove "${removedItem.title}" - check your connection and try again.`, "error");
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
    passwordError.classList.remove("show");
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
    showToast("You're offline - some features won't work until you're back.", "error");
});

// Covers the case where the app is opened while already offline (e.g.
// launched from the home screen with no signal), not just the moment the
// connection drops mid-session.
updateOfflineBanner();

/* =========================================================
   SERVICE WORKER REGISTRATION (PWA installability + notifications)
========================================================= */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("service-worker.js").catch(err => {
            console.warn("Service worker registration failed:", err);
        });
    });
}
