# NovaWatch

A mobile-first PWA for tracking TV shows and movies — search, add to a library, mark episodes/movies watched, log rewatches, and get release alerts. Built on Firebase (Auth + Firestore) and the TMDB API, with JustWatch-sourced "where to watch" availability.

Live at `https://www.novawatch.site/`.

---

## File structure

```
/ (novawatch.site root)
├── index.html              The app itself (auth, Home/Discover/Library tabs, all modals -
│                            including NovaWrapped, which used to be its own page)
├── manifest.json           PWA manifest (installability, icons)
├── service-worker.js       Offline app-shell caching + notification click handling
├── styles/
│   ├── tokens.css          Shared design tokens - linked by both HTML pages
│   ├── app.css             index.html's component styles
│   └── multi-library.css   Multi-Library feature's styles (switcher, selection screen, modals)
├── scripts/
│   ├── app.js              index.html's application logic
│   └── multi-library.js    Multi-Library feature's logic (see "Multi-Library" below)
└── privacy-terms/
    └── index.html          Privacy Notice & Terms of Service (was privacy-terms.html)
```

**Deployment note:** `privacy-terms/` deploys one folder level *deeper* than `index.html` (i.e. `novawatch.site/privacy-terms/`, vs `index.html` at the domain root). It links `styles/tokens.css` as `../styles/tokens.css` to account for that. If it - or the app itself - ever moves to a different depth, that relative path needs to move with it.

### Why the split

`index.html` used to be a single self-contained ~350KB file with everything inline. It's now ~40KB, with CSS and JS broken out for two reasons:

1. **Caching** — a CSS-only change no longer forces a re-download of unrelated JS, and vice versa.
2. **Consistency** — `tokens.css` being the *one* source of design tokens (colors, dark-mode palette) that all three pages link, instead of each page keeping its own copy, is what actually fixes a bug class that came up repeatedly: pages drifting out of sync with each other (e.g. `privacy-terms.html` at one point referenced a CSS variable it had never actually defined).

`app.js` stays a classic script (not `type="module"`) — the app relies heavily on inline `onclick="..."` attributes throughout the markup calling global functions, which modules don't expose the same way.

---

## Tech stack

- **Firebase Auth** — email/password + Google sign-in
- **Firestore** — per-user profile doc (`users/{uid}`) holding `profiles`, `activeProfileId`, `region`; library items stored per-user
- **TMDB API** — search, metadata, episode/season data, recommendations
- **JustWatch (via TMDB)** — streaming availability by region
- No backend of its own — everything runs client-side against Firebase + TMDB directly

### Firebase plan

Currently on the **free Spark plan**. This is a real constraint on the feature set: Spark dropped Cloud Storage access (Feb 2026), which is why avatars are a curated set of hosted images rather than user uploads — that would need Storage, i.e. the paid Blaze plan. Anything requiring Blaze is intentionally deferred until premium revenue justifies the upgrade (see **Monetization** below).

---

## Core features

- **Search & library** — TMDB-backed search, add movies/TV shows, mark watched (single tap, no friction — deliberately not gated behind a rating/reaction popup)
- **Rewatch tracking** — per-episode for TV, per-title for movies. A tap-to-manage popup (Add/Remove Rewatch) rather than a one-way counter; unwatching something clears its rewatch history. TV also has a season-level bulk option ("rewatch this season" / "clear season rewatches"), gated until every released episode in that season has been watched.
- **Discover → For You** — TMDB `/recommendations` seeded from your top-rated/most-recent library items, ranked by cross-seed hit count then TMDB score. Falls back to plain Trending when your library's empty for that type.
- **Continue Watching** — Home tab surfaces the next unwatched episode per in-progress show plus unwatched movies.
- **Sharing** — deep links for movies/shows (`?share_type=movie|tv&share_id=<tmdbId>`) and individual episodes (`?share_type=episode&share_id=<showTmdbId>&share_ep=<sXeY>`). Opening a shared episode link loads the parent show first, then drills into that specific episode once its episode list has loaded.
- **Achievements** — computed client-side from library data, not stored as separate synced records. Bidirectional: unwatching/un-rewatching something can revoke an achievement, not just earn one. Free tier active now (10 movies, 10 shows, 7-day streak, first rewatch); a premium tier exists in code (`PREMIUM_ACHIEVEMENTS`) but isn't wired up yet.
- **Dark mode** — toggle in Settings, saved to `localStorage` (device-level, not synced across devices), applied before first paint via an inline script in each page's `<head>` to avoid a light-then-dark flash.
- **Avatars** — 8 curated hosted images (not uploads — see the Firebase Spark note above). New accounts get one assigned at random; always changeable via the picker in Settings.
- **Streaming region** — full ISO 3166-1 country list, drives which "where to watch" info TMDB/JustWatch returns.
- **Release-date buffer** — TMDB dates are pinned to 08:00 UTC rather than raw midnight (`tmdbDateToISO()`), giving the periodic background sync a window to have actually pulled fresh data before anything's treated as released.

### Deliberately not built

A few things were tried or considered and explicitly ruled out:
- **Calendar/.ics export** — tried in an earlier version, didn't like it, not revisiting.
- **Per-user private ratings** — moving to a combined/community rating (all users' ratings averaged per title) instead.
- **Emoji-reaction popups on marking watched** — a TV Time pain point; deliberately avoided to keep "mark as watched" a single, frictionless tap.

---

## Multi-Library

Every account can hold up to `MAX_LIBRARIES` (3, defined in `multi-library.js`) completely independent libraries - separate items, watched/unwatched state, episode progress, Continue Watching, rewatch counts, everything. Switching libraries via the header pill or the "Choose Your Library" screen swaps out the entire active dataset; nothing is ever auto-copied between libraries.

**Firestore structure:**

```
users/{uid}                                  account-level doc, unchanged, plus one new
                                              field: activeLibraryId
users/{uid}/libraries/{libraryId}            one doc per library - name, avatarId, createdAt
users/{uid}/libraries/{libraryId}/items            the actual watch data (same doc shape the
users/{uid}/libraries/{libraryId}/archivedShows    old flat users/{uid}/library and
                                                    users/{uid}/archivedShows collections used
                                                    to hold, just nested one level deeper)
```

`{libraryId}` is a normal Firestore auto-id - never `library1`/`library2`/`library3` - so `MAX_LIBRARIES` is purely an app-level check inside `createLibrary()`, not something baked into the data model. Raising or removing the limit later is a one-line change.

region, isPremiumUser, the account avatar (`state.profiles`), theme, and notification permission are account-level settings, not watch data - they intentionally stay shared across every library and are untouched by this feature.

**Existing accounts:** the first time `initMultiLibrary()` finds no `libraries` subcollection yet, it runs a one-time migration (`migrateLegacyLibraryData()`) that creates a default "My Library" and moves every doc out of the old flat `users/{uid}/library` and `users/{uid}/archivedShows` collections into it, then deletes the old flat collections. A brand-new account hits the same code path with nothing to move, which is what "builds on the existing library instead of a separate setup flow" means in practice.

**What's a partial implementation, on purpose:** the brief also asked for movie/show *metadata* (title, poster, cast, episode lists) to live in a separate shared `content/{id}` collection so the same title added to two libraries doesn't store its metadata twice. That part isn't built. Every library item doc here is still the same fully denormalized shape the app has always used (metadata + this library's watch state together). Actually splitting those apart would mean rewriting how virtually every rendering function in `app.js` reads an item - hundreds of call sites (`item.title`, `item.poster`, `item.episodes`, etc.) - which isn't something to do blind, in one pass, against a live app with real user data. What's fully built is the part the brief itself calls out as the *Core Principle*: watch data is completely isolated per library, and nothing is ever auto-shared between libraries (see `deleteLibrary()`, `switchActiveLibrary()`, and every `getActiveLibraryItemsRef()`/`getActiveLibraryArchivedRef()` call site in `app.js`). The metadata-deduplication half is a real, clearly-scoped follow-up (a top-level `content/{mediaType}_{tmdbId}` collection, populated from the existing TMDB-fetch call sites, with item docs storing a reference instead of a full copy) - flagged rather than done partially.

**UI:** a small floating pill ("My Library ▾") pinned to the top of every tab, hidden automatically for accounts with just one library - see `.library-header-bar` in `multi-library.css`. Tapping it opens a dropdown to switch instantly, or jump into the full "Choose Your Library" screen (also reachable via Settings → Libraries), which shows every library's avatar + name plus Add/Edit tiles matching the provided reference design. Deleting a library requires confirmation and is blocked if it's the account's only remaining library.

---

## NovaWrapped

A "Wrapped"-style yearly recap, gated to release **January 1, 2027**. Originally its own separate page; migrated into `index.html` as a modal (see `#novaWrappedModal` and `openNovaWrappedModal()`) since it always needed the same signed-in session's Firestore data as everything else - being separate meant loading a whole second copy of the Firebase SDK just to read data the main app already had in memory. Before the release date, tapping the Settings row's "View" button doesn't open the modal at all - it shows an error toast ("Available 1 January 2027 @ 00:00 UTC") and returns; the release gate is checked at the top of `openNovaWrappedModal()`, before the modal is ever shown, rather than being rendered as content inside it.

Tracks Jan 1–Dec 31 UTC, with a 7-day grace period after account creation excluded from tracking (new users tend to bulk-add existing watch history rather than watching in real time). Deliberately **excludes rewatches** from its totals — only the original watch counts. This is the opposite of the Home tab's Viewing Analytics, which deliberately *does* count rewatches (`runtime × (1 + rewatchCount)`). If you're touching either calculation, don't accidentally make them consistent with each other — that inconsistency is intentional.

---

## Monetization (planned, not yet built)

Free/premium split, designed to stay entirely on the free Spark plan for now:

- **Always free:** the core tracking loop (search, add, mark watched), dark mode.
- **Premium bundle (not yet gated — `state.isPremiumUser` is a hardcoded `false` placeholder):** extra profiles beyond the first, deeper NovaWrapped detail/sharing, the avatar picker, the premium achievement tier.
- **Explicitly deferred until Blaze:** avatar upload (needs Cloud Storage).

The goal for premium is that it feels like genuine added value (personalization/depth), not the core experience held hostage — free should feel complete on its own.

---

## Roadmap

Confirmed build order was multi-profiles → dark mode, but dark mode, achievements, and the avatar picker ended up built first at the user's explicit request. **Multi-profiles is still the next big structural piece** — everything in the premium bundle above (extra profiles, per-profile avatars/achievements) depends on it existing.

**Lists (planned, not built):** custom, freeform collections (e.g. "Future Watch", "Movie Night") that don't require adding a title to the tracked Library. An earlier pass tried giving Lists a home inside the Library tab (renamed "My Stuff") via a Library/Lists segmented control — reverted at the user's request, since switching between Library and Lists there felt like one navigation layer too many. Current plan: Lists will live on the **Home** tab, as its own section underneath Continue Watching, once the feature itself is built. Library keeps its original name and structure (TV Shows/Movies only) in the meantime.

**Upcoming type filter (implemented, revised):** first pass added an All/TV Shows/Movies 3-way filter above the Upcoming schedule; reverted to a plain 2-way TV Shows/Movies split at the user's request, matching Discover/Library exactly (no combined "All" view - defaults to TV Shows). Also fixed long TV episode subtitles wrapping to a second line and making TV rows look bulkier than movie rows - `.upcoming-date` now truncates to one line with an ellipsis, same as everywhere else in the app. `getUpcomingItems()` already accepted a `filterType` argument that wasn't exposed in the UI - `setUpcomingFilter()` in `app.js` wires it up.

**Bottom nav visual rework (implemented, revised):** pushed further toward genuine "Liquid Glass" across three rounds - very low fill opacity so background content actually shows through, strong blur+saturation to stay legible at that opacity, a full capsule shape instead of the app's usual card radius, a top-left radial highlight and a soft top-edge glow standing in for light catching curved glass, a slow low-contrast animated diagonal sheen (respects `prefers-reduced-motion`), and refined nav buttons - thinner icon strokes, tighter label tracking, a soft colored glow behind the active icon instead of a flat color swap. Scoped to `.bottom-nav`/`.nav-indicator`/`.nav-button` in `app.css`.

Two real bugs found and fixed in the third round, both introduced by the second round's changes:
1. `.bottom-nav` had `overflow: hidden` (added to clip the shimmer pseudo-element to the pill shape) combined with `position: fixed` and `backdrop-filter` - a known WebKit/Safari rendering trap that can make an element vanish or stop repainting, especially mid-scroll. Fixed by giving the shimmer its own `border-radius: inherit` instead, so the parent no longer needs `overflow: hidden` at all.
2. The "borderless" look from round two still visually read as bordered, because the edge highlight used a full-perimeter `inset 0 0 0 1px` box-shadow ring - which renders identically to an actual border regardless of which CSS property produces it. Replaced with directional (top-glow, bottom-glow) shadows only, never a uniform ring, on both `.bottom-nav` and `.nav-indicator`.

If nav visibility or tab-switching problems persist after this fix, they're not reproducible from the code alone (showPage/setLibraryView/updateNavIndicator were all traced and are structurally sound - no duplicate IDs, no duplicate function definitions, no other overflow+backdrop-filter+fixed combinations anywhere else in `app.css`) - would need specifics (which tab, what happens on tap, any console error) to dig further.

**Glassmorphism pass across the rest of the app (implemented):** the shared `--glass-chrome-*` tokens (sheets/toasts/pill controls/circular buttons) and `--surface`/`--surface-2`/`--surface-3` got a moderate translucency/blur increase in `tokens.css` to feel consistent with the nav bar's stronger treatment - kept deliberately less extreme than the nav bar itself, since these also back text-heavy surfaces (modals, achievement lists) that depend on the exact opacity values behind several rounds of past dark-mode contrast fixes; pushed further without visual verification risked reintroducing those bugs. Left dark mode's chrome/surface tokens untouched for the same reason - not requested and higher risk. Light mode's base background (`--bg-mesh`) changed from a flat white/grey mesh (deliberately colorless in the original design) to a soft multi-tone mesh (blue/peach/lavender/mint corner tints over a cool near-white base, `#F3F4F9`) so glass surfaces have actual color to refract instead of white-on-white - updated everywhere that hardcoded the old `#F0F2F6` base (the `theme-color` meta tag on both `index.html` and the privacy-terms page, `manifest.json`'s `background_color`/`theme_color`, and the avatar-edit badge's page-matching ring color).

The same full-perimeter-ring-reads-as-a-border issue found on the nav bar (bug #2 above) turned out to still be present in the *shared* `--glass-chrome-shadow` token itself (both light and dark), so every consumer of it still looked bordered even after the nav bar was fixed - removed there too, plus the matching literal borders on `.toast` and the ring on `.search-type-btn.active`, and the same border+ring combo on `.continue-card` (Home's Continue Watching cards, the next most visible glass surface after nav). `.search-box input` deliberately keeps its border - that one does real work as a focus-state indicator on a form field, not just decoration, so it stayed.

Other things flagged as ideas but not committed to a slot: all-time/lifetime stats page, a "time to finish" estimator, custom watch statuses (Plan to Watch/On Hold/Dropped), a household activity view (once profiles exist), Discover genre/mood filters.

---

## Multi-Library feature (new)

Implemented the Multi-Library feature end to end - see the "Multi-Library" section above for the full writeup (schema, migration, UI, and the one deliberately partial piece). Summary of what changed:

- **New files:** `scripts/multi-library.js` (all of the feature's logic) and `styles/multi-library.css` (all of its styling) - kept separate from `app.js`/`app.css` rather than merged in, at the user's request.
- **`app.js`:** every call site that used to hardcode `db.collection("users").doc(uid).collection("library")` (or `"archivedShows"`) now goes through `getActiveLibraryItemsRef()`/`getActiveLibraryArchivedRef()` instead, so it automatically follows whichever library is active. `proceedToApp()` now calls `initMultiLibrary()` first. `deleteAllUserData()` now wipes every library on the account, not just one.
- **`index.html`:** header switcher pill ("My Library ▾", auto-hidden for single-library accounts), the "Choose Your Library" screen matching the provided reference design, Add/Edit/Delete-library modals, and a Libraries row in Settings.
- **`service-worker.js`:** cache list updated to include both new files, bumped to v12.
- Ran the full validation sweep (JS syntax, CSS brace balance, HTML tag balance, no duplicate IDs, every `onclick`/CSS class/CSS variable resolves) across every changed file - all clean.

---

## App Store plans reversed - Capacitor removed

NovaWatch will stay a website/PWA for the foreseeable future - the Capacitor native-wrapper integration (added in an earlier round, never actually built into iOS/Android projects or submitted anywhere) has been fully removed:

- **`scripts/app.js`:** removed `isNativeApp()` and every native-only branch it gated - `checkNotificationPermissionState()`, `requestNotificationPermission()`, and `sendAppNotification()` are back to plain Web Notifications API code, unbranched. Also removed `nextLocalNotificationId`, which existed only to id native `LocalNotifications.schedule()` calls.
- **`package.json` and `capacitor.config.json`: deleted entirely.** Both files existed solely for Capacitor (dependencies, dev dependencies, `cap:*` scripts, `webDir`/plugin config) - nothing else in the project used them, so there's no reduced version to keep.
- **README:** removed the "Capacitor (native app wrapper)" section in full, and the "home/lock-screen widgets (would require going native)" idea from the not-yet-committed list in Roadmap, since that idea depended on exactly the native wrapper just removed.

If native ever comes back onto the roadmap, the reasoning and API details that were here (no-bundler mechanism, Local Notifications plugin usage, the App Store/Play Store cost note) aren't preserved - they'd need researching fresh at that point.

---

## Dead-code sweep + README correction

**Removed genuinely unused code**, confirmed zero references anywhere (`app.js`, `index.html`, `privacy-terms/index.html`) before deleting:
- `getTheme()`'s superseded duplicate: `setTheme()` was defined twice in `app.js` - a stale two-way (light/dark only) version left in place from before the Light/Dark/Auto rework, silently shadowed by the real three-way version defined right after it. Removed the dead copy.
- `getLastTab()` - read `novawatch_last_tab` from `localStorage` but was never called anywhere; the app always lands on Home regardless. `saveLastTab()` (which writes that key on every tab switch) is still called and was left in place, since removing a write half of a pair isn't the same "unused code" as removing a function nobody calls - just annotated as currently write-only.
- Seven CSS rules in `app.css` with zero matching usage anywhere: `.tab-nav-footer`, `.footer-browse-button` (+ its `:active` state), `.horizontal-row`, `.spinner-container`, `.home-card`, `.home-row`, `.auth-footer-sep`.

**Left alone on purpose:** `--surface-3` in `tokens.css` is unused (0 references), but it's one rung of a deliberate `--surface`/`--surface-2`/`--surface-3` depth scale defined in parallel across both light and dark blocks, not a leftover from a removed feature - reserved for future use rather than deleted.

Bumped `service-worker.js`'s `CACHE_NAME` (since `app.js`/`app.css` both changed) and re-ran the full validation sweep (JS syntax, CSS brace balance, HTML tag balance, no duplicate IDs, every `onclick` resolves, every CSS class/variable resolves) - all clean.

**Corrected a real README inaccuracy:** the "Deliberately not built" list still said PWA install shortcuts were declined, but they were reversed and implemented in the 7-request round documented further down this same file (`manifest.json`'s `shortcuts` array, `openShortcutTabFromURL()` in `app.js`) - removed the stale bullet so the two sections stop contradicting each other. Also updated the `app.js` line-count estimate below (was ~5,500, actually ~6,000).

---

## Latest round (real fix for the drag bug + full-app audit)

**Nav drag: found the actual root cause of "reverts to the original tab" / "lands on the wrong tab."** The previous round's fix (calling `showPage()` directly instead of `.click()`) addressed a real but different bug (a native-click race). The two symptoms reported this round trace to something else: `pointermove` only ever detected which button the finger was over via a `requestAnimationFrame`-throttled `elementFromPoint()` check. Two failure modes followed directly from that: (1) a fast flick-and-release could complete before that throttled check ever fired even once, leaving the target button unset at release - falling into the "snap back to the original tab" branch even though the pill had visually reached the new one; (2) when it did fire, the result could lag up to one animation frame behind the actual final finger position - enough, for a fast swipe, to resolve to the wrong button. Fixed by removing the throttled hit-test from `pointermove` entirely (it's now purely a visual position update, no hit-testing at all) and doing exactly one fresh, synchronous `elementFromPoint()` call at the exact release coordinates in `finishDrag()` - there's no longer any stale or unset state for the release decision to be wrong from. Also added a timeout-based auto-reset for the click-suppression flag from the previous round's fix, so it can never get stuck `true` forever and silently swallow some later, unrelated tap if the browser never fires the click it was meant to catch.

**Full-app audit.** Ran the complete structural validation sweep (JS syntax, CSS/JSON validity, HTML structure on both HTML files, no duplicate IDs, every `onclick` resolves, every CSS class/variable referenced actually resolves) - all clean. Went further this round: cross-referenced every one of the app's 157 top-level functions against every call site in both `app.js` and `index.html` to find anything orphaned. Found and removed two genuinely dead functions - `getCurrentTheme()` (superseded by `getSavedThemeMode()` when Auto theme was added, but never deleted) and `renderGrid()` (superseded by callers that now call `createCard()` directly with additional context - like `upcomingShowIds` - its generic signature didn't support). Manually re-verified every major user-facing feature's core function still exists and is correctly named: watched-marking, library removal/stopping, achievements, theme (including the OS-listener and toggle sync), notifications (both native and web paths), region auto-detect, NovaWrapped's gate, sharing, all tab-switching (tap and drag), the Continue Watching swipe gesture, and the TMDB refresh sync - all present and wired.

---

The previous round's `.episode` fix (border-bottom -> box-shadow, on the theory that a partial border on a rounded element was misrendering as a full ring under WebKit compositing) turned out to still show a border, per user report - same for `.search-card` and `.upcoming-card`. Rather than continue refining a rendering theory that clearly wasn't fully correct (or wasn't the whole story), all three now have `border: none; box-shadow: none;` explicitly - no separator, no divider line, nothing left that could possibly render as a border regardless of the exact mechanism. Certainty over cleverness this time. Also swept the rest of `app.css` for every remaining use of `--glass-border-subtle` (6 left) to check none of them were the same bug in disguise - confirmed all 6 are unrelated, legitimate elements (full intentional borders on `.category-count`/`.segmented-toggle`, or flat non-rounded divider lines between Settings rows and the auth screen's "OR" divider) - none are rounded list-cards, so none share the pattern that actually caused this.

---

**1. Discover's search-card poster now matches Upcoming's poster exactly** (66x94, 14px radius, same shadow - was 80x116 @ 16px). `createUpcomingCard()` already renders TV and Movie entries identically (confirmed by reading the code - both use `data.item.poster`, the show/movie's own poster, not an episode still, so there was no actual TV/Movie mismatch within Upcoming to fix). The real gap was between Upcoming's cards and Discover's `.search-card` - unified on the poster dimensions/radius while keeping each's own necessarily-different content (Discover needs the add button + description; Upcoming needs the countdown + date).

**2. Nav drag: found and fixed the actual "takes a few tries to stick" bug.** `finishDrag()` was calling `draggedOverButton.click()` to trigger navigation - but after `nav.setPointerCapture()`, a browser's native click-synthesis isn't guaranteed to target the same element the drag logic resolved to, creating a race where a second, conflicting click could silently fire right after and revert the navigation. Fixed by deriving the target page directly from the button's id (`nav${Page}` -> `showPage(page)`) instead of relying on `.click()` at all, plus a capture-phase listener that explicitly swallows whatever click follows a drag as a safety net.

Also, per explicit request: the pill's background dropped to near-zero opacity (both themes) - fully transparent, relying on blur/refraction alone rather than any white tint - and the settle transition switched from a plain ease-out to a spring/bounce curve (`cubic-bezier(0.34, 1.56, 0.64, 1)`), now the actual CSS default so both tap-driven and drag-driven navigation share the same premium feel rather than only the drag borrowing a different one. Also throttled the drag's `elementFromPoint()` hit-test to once per animation frame via `requestAnimationFrame` (a real DOM hit-test is meaningfully more expensive than the plain transform update, and `pointermove` can fire 60+ times/sec) - the pill's visual position still updates on every single event, only the "which button is this over" check is throttled, so this is a pure smoothness/performance fix with no change in responsiveness.

One behavioral note: dragging into Discover no longer auto-focuses the search input the way tapping it does (`showPage('discover', null, true)` vs the drag's derived `showPage('discover')`) - deliberate, since popping the keyboard immediately after a drag gesture seemed more likely to feel jarring than helpful, but flagging it as a real difference in case that's wrong.

---

**1. The white border fix from the previous round targeted the wrong component.** `.poster img`/`.upcoming-poster img` (grid poster tiles) got fixed, but the screenshots showed `.search-card` (Discover's list-style search/recommendation rows) and `.upcoming-card` (Upcoming's list rows) - never touched. Root cause, on closer look: both had `border-radius` combined with only a partial `border-bottom` (not a full border) - a known category of WebKit rendering quirk where, under GPU compositing (triggered by `backdrop-filter`, which is everywhere in this app), a single-edge border on a rounded element can paint as a full outline around all four corners instead of just the specified edge. Fixed by replacing `border-bottom` with an equivalent `box-shadow: 0 1px 0 0 var(--glass-border-subtle)` on both - a box-shadow offset doesn't interact with `border-radius` the same way, so it can't misrender as a ring. Swept the rest of `app.css` for the same `border-radius` + partial-border combination and found one more instance sharing it - `.episode` (episode list rows in the details modal) - fixed identically, along with its `.episode-up-next` override (was `border-bottom-color: transparent`, now `box-shadow: none`).

**2. Nav bar drag animation reworked for genuinely continuous motion.** The previous round's "smoother" fix only repositioned the pill when the finger crossed into a *new* button, with a short eased transition on that jump - meaning between crossings, the pill sat completely still, then jumped, which is why it didn't read as "being moved." Replaced with true 1:1 continuous tracking: the pill's position now updates on every single `pointermove`, following the raw finger x-coordinate directly with `transition: none` (zero lag) for the entire drag, keeping a fixed width throughout. The eased "settle" transition (the CSS-defined default) only kicks in once, on release, animating the pill into its final confirmed button's exact position/width. `positionNavIndicatorAt()` is still used for the tap-driven case and the release settle - only the drag's own positioning logic changed.

---

## 7-request round (PWA shortcuts, movie swipe, notifications, theme auto-detect, drag nav v1)

1. **PWA install shortcuts (implemented)** - `manifest.json`'s `shortcuts` array now has Discover/Library/Upcoming (Home skipped - it's already the default landing). Reverses an earlier explicit decision to skip this feature; flagged to the user as a heads-up, not blocked on it. Each shortcut links to `/?shortcut=<tab>`; `openShortcutTabFromURL()` in `app.js` reads that param right after the normal Home landing (same pattern as the existing `share_type` deep links) and strips it via `history.replaceState` so a refresh doesn't keep re-jumping.
2. **Movie swipe-to-remove on Home's Continue Watching (implemented)** - one-line change. `leftAction` for movie cards changed from `''` (no distinct left action - movies previously shared the single "mark watched" behavior in both swipe directions) to `'remove'`. `finishDrag()`'s dispatch already handled `'remove'` generically via `removeLibraryItemById()` (which was already type-agnostic, with its own movie-specific toast message), so no other JS changes were needed. Movies in this list are always unwatched by definition, so there's no watch history to protect the way TV's `'stop'` path protects it - always a plain removal.
3. **NovaWrapped Settings icon (implemented)** - swapped from `NovaWatch_App_Icon.png` to `NovaWatch_Favicon_Icon.png`.
4. **"Everything should still fit" (audited, nothing broken found)** - full sweep after this session's changes: JS syntax valid, CSS braces balanced, HTML structurally sound (proper parse, no duplicate IDs), every `onclick` resolves to a real function, every CSS class actually used resolves to a real rule (a handful of initial false positives - `cinema-chip`, `has-text` - turned out to be compound selectors my first regex pass didn't catch; `hero`/`updated`/`wrap`/`overlay-close-button` are defined in the privacy-terms page's own embedded stylesheet, not the shared one), every CSS custom property referenced is still defined. Also specifically checked the new 3-way theme toggle (previous item) fits in the Settings row - `.settings-row-text` has `min-width: 0` so it shrinks and the subtitle wraps gracefully rather than overflowing if a narrow device runs short on space.
5. **Theme now tracks the OS setting properly, plus a real Auto option (implemented)** - the app already fell back to `prefers-color-scheme` for anyone who'd never explicitly picked a theme, so it should already have opened in dark mode on a phone set to dark, for a first-time visitor. What it couldn't do was let someone *return* to following the OS after having picked Light or Dark once - that explicit choice always won from then on, with no way back short of clearing storage. Added a third **Auto** option to the Settings Appearance toggle (`.theme-toggle-mini` now 3 buttons: Light/Dark/Auto). `'auto'` is stored explicitly (not just "no saved value") so the UI can show it as selected; `setupOSThemeListener()` registers a `matchMedia` change listener that live-updates the site if the phone's OS theme changes while a tab is open and Auto is active, and correctly stops acting the moment an explicit Light/Dark choice is made instead. Both inline head scripts (`index.html` and the privacy-terms page) updated to treat `'auto'` and "never chosen" identically - both fall through to the OS check.
6. **Capacitor (answered, no code change at the time)** - explained Ionic's open-source native runtime and what it would take to wrap the app for App Store/Play Store distribution. Later reversed: NovaWatch will stay a website/PWA for the foreseeable future, so the Capacitor integration this led to was removed - see "App Store plans reversed" above.
7. **Drag-to-switch nav bar (implemented)** - `initNavBarDragToSwitch()` in `app.js`: a finger can land anywhere on the bar and drag across: the pill live-follows via `document.elementFromPoint()` hit-testing during `pointermove`, snapping button-to-button (not free-floating between them), and commits navigation only on `pointerup` by calling that button's own `.click()` - reusing its existing `onclick="showPage(...)"` rather than duplicating that logic. A plain tap (movement under a 10px threshold, or more vertical than horizontal) is left completely untouched, so ordinary single-tap navigation behaves exactly as before. Refactored `updateNavIndicator()`'s positioning math out into a shared `positionNavIndicatorAt(btn)` helper so both the tap-driven indicator and the new drag preview use the same code path instead of duplicating the width/transform calculation. `.bottom-nav` given `touch-action: none` so the browser doesn't fight the horizontal drag by trying to scroll/pull-to-refresh instead. Not visually tested - this is exactly the kind of gesture-feel work that's genuinely hard to get right blind; worth an actual on-device check before considering it done.

---

---

## Bug-fix + polish round (5 requests)

**1. A previously-watched season disappearing (real bug, found and fixed).** Root cause was in `refreshItemFromTMDBInternal()`'s per-season TMDB fetch: each season was fetched independently, and if any single one failed (transient network error, rate limit - anything), it silently resolved to `null` and that season was just skipped when building the merged episode list. Since the merged list then wholesale-replaced `item.episodes` as long as *any* season succeeded, one bad fetch for one season out of several was enough to permanently wipe that season's episodes - watched history included - on the very next background sync, with no error surfaced anywhere. Not the user's error. Fixed two ways: each season fetch now retries once before giving up, and if it still fails, that season falls back to its existing (untouched) episodes instead of being dropped - worst case one season's data is a sync cycle stale, watched history is never lost.

**2. Appearance settings layout reworked.** Was a cramped inline row (icon + title + subtitle all competing with a 3-button toggle on one line). Restructured into a stacked row - label/icon on top, then a full-width toggle below - reusing the app's existing `.segmented-toggle`/`.segmented-btn` component (same one Library/Discover/Upcoming already use) instead of the bespoke `.theme-toggle-mini` component, which was removed. New `.settings-row-stacked`/`.settings-row-top` CSS classes for this pattern, reusable for any future settings row whose control needs more room than fits inline.

**3. NovaWrapped "View" button now blocks entry outright before the release date**, showing an error toast ("Available 1 January 2027 @ 00:00 UTC") instead of opening the modal to a countdown card - reverses the earlier "let people peek at a countdown" decision. `renderNovaWrappedComingSoon()` and its `.coming-soon-*` CSS (light + dark) were removed as dead code, since `openNovaWrappedModal()` now gates before the modal-opening code ever runs.

**4. Nav bar drag-to-switch animation smoothed.** The gesture (added in the previous round) was snapping the pill instantly between buttons (`transition: none` during drag) rather than gliding - fixed by using a short eased transition during the drag instead, so crossing into a new button animates smoothly rather than teleporting; a fast swipe across several buttons still reads as one continuous glide since a new target retargets the in-progress transition rather than restarting it. Added a subtle `.dragging` lift (deeper shadow) while actively held, settling back to normal on release. The transition resets to the slower default settle animation before the release-triggered navigation fires, so the final snap into the confirmed tab still uses the originally-tuned timing.

**5. White border/ring around Discover and Upcoming poster images (both themes) - fixed.** No explicit `border` or ring `box-shadow` existed on `.poster`/`.upcoming-poster` themselves (already checked for the same "ring reads as border" pattern found and fixed elsewhere this session - not present here). Best-supported explanation: a known CSS rendering quirk where `overflow: hidden` + `border-radius` on a container doesn't always perfectly clip a `cover`-fit child image at certain zoom/DPI levels, leaving a hairline sub-pixel gap at the rounded corners where the container's own background shows through - and since both containers use `var(--surface-2)` (a white-based color in both light and dark mode), that gap reads as a faint white ring regardless of theme. Fixed by giving `.poster img`/`.upcoming-poster img` their own `border-radius: inherit`, so the image clips itself to match rather than relying solely on the parent's clip.

---

This file has grown a lot in one sitting (`app.js` alone is ~6,000 lines). A few things worth watching as it keeps growing:
- The `openDetails()` mishap (a routine edit briefly deleted its own function declaration, caught by a syntax check before shipping) is a preview of the kind of mistake that gets more likely as a single file gets larger. If a feature area gets substantial enough (achievements, sharing, the sync logic), consider whether it's ready to be its own module.
- `privacy-terms/index.html` keeps its own copies of a handful of component classes it borrows from `app.css`'s visual language (`.analytics-card`, `.section-title`, `.settings-section-title`, `.section-header` - used to give it the same "stack of cards with labels" structure as Settings and NovaWrapped, instead of the one-big-document-card layout it used to have). That's a deliberate, contained exception - full `app.css` isn't linked there because its global `body`/`h1`/`a` rules are tuned for the app shell and risk leaking onto this page's own layout in ways that are hard to verify without live testing. If any of those four classes change in `app.css`, this page's copies need updating too. `tokens.css` (the actual colors/palette) staying singular is what matters most - that's what caused the real sync bugs earlier.
