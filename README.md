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
│   └── app.css             index.html's component styles
├── scripts/
│   └── app.js              index.html's application logic
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
- **Firestore** — per-user profile doc (`users/{uid}`) holding `profiles`, `activeProfileId`, `region`, `username`; library items stored per-user; a top-level `usernames/{lowercased-username}` collection enforces unique usernames (see below)
- **TMDB API** — search, metadata, episode/season data, recommendations
- **JustWatch (via TMDB)** — streaming availability by region
- No backend of its own — everything runs client-side against Firebase + TMDB directly

### Firebase plan

Currently on the **free Spark plan**. This is a real constraint on the feature set: Spark dropped Cloud Storage access (Feb 2026), which is why avatars are a curated set of hosted images rather than user uploads — that would need Storage, i.e. the paid Blaze plan. Anything requiring Blaze is intentionally deferred until premium revenue justifies the upgrade (see **Monetization** below).

### Usernames & Firestore security rules

Every account now reserves a unique username: chosen at signup (the Join form's username field) or, for Google sign-in and any pre-existing account from before this was required, via a blocking "Choose a username" screen shown right after sign-in. Reservations live in `usernames/{lowercased-username}` → `{uid, username}` — a separate collection from `users/{uid}` so checking/claiming a name never needs to know who currently owns it.

Uniqueness is enforced two ways, and **both matter**:
1. **Client-side (already shipped)** — a `db.runTransaction()` in `claimUsername()` re-reads the reservation doc and only writes if it's still free (or already owned by the same uid). This is what actually stops two people claiming the same name at the same moment; a plain read-then-write would have a race window. Signup rolls the whole account creation back (`user.delete()`) if the claim loses that race. Deleting an account also deletes its username reservation, freeing the name for reuse.
2. **Firestore security rules (not shipped — needs to be set in the Firebase console)** — the client-side transaction assumes a well-behaved client. A modified/malicious client could bypass `claimUsername()` and write directly to `usernames/{name}`. Add rules along these lines so the *database* also refuses to let anyone overwrite an existing reservation or write one for a uid that isn't their own:

```
match /usernames/{username} {
  allow read: if true;
  allow create: if request.auth != null
    && request.resource.data.uid == request.auth.uid;
  allow update, delete: if request.auth != null
    && resource.data.uid == request.auth.uid;
}
```

Until these are added in the console, uniqueness is real for any normal use of the app but not airtight against a deliberately modified client.

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
- **Unique usernames** — every account reserves a unique, lowercase-only username (see the Firebase plan section above for how uniqueness is enforced). Separate from the freely-editable **display name** shown throughout the UI - see Settings, where both are shown together (`Display Name` / `@username`).

### Deliberately not built

A few things were tried or considered and explicitly ruled out:
- **Calendar/.ics export** — tried in an earlier version, didn't like it, not revisiting.
- **Per-user private ratings** — moving to a combined/community rating (all users' ratings averaged per title) instead.
- **Emoji-reaction popups on marking watched** — a TV Time pain point; deliberately avoided to keep "mark as watched" a single, frictionless tap.

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

---

## Unique usernames + Settings profile header revamp

**1. Every account now reserves a unique username (implemented, client-side enforcement; security rules documented but not applied - see "Usernames & Firestore security rules" above).**

- Email/password signup already had a username field on the Join form (`#authUsername`) but never checked it against anyone else's - two people could register the same name. It's now validated for format (3-20 characters, letters/numbers/underscores only, via `isValidUsernameFormat()`) and actually reserved: `handleSignUp()` does a quick `isUsernameAvailable()` read before creating the Firebase Auth account (fast-fail for the common case), then reserves it for real with `claimUsername()` - a Firestore transaction against a new `usernames/{lowercased-username}` collection, which is what actually closes the race window a plain read-then-write would leave open. If the transaction loses that race (someone else claimed it in the gap between the check and the transaction), signup rolls itself back - the just-created auth account is deleted via `user.delete()` - rather than leaving a half-set-up account with no valid username.
- **Google sign-in never had a username step at all** - it silently took whatever name Google's OAuth profile supplied, with no uniqueness check. New `#chooseUsernameScreen` overlay (same tier/pattern as `#authScreen`/`#verifyScreen` - full-screen, blocking, `z-index: 1000`) is shown by `proceedToApp()` any time a signed-in account doesn't have a `username` on file yet - this covers both first-time Google sign-ins and any account that existed before this feature shipped. Pre-fills a suggestion from the Google display name/email as a starting point, but it's fully editable and goes through the exact same `isUsernameAvailable()`/`claimUsername()` path as signup. Can't be dismissed without submitting a valid, available username (no close button, no tap-outside-close) - the only way out is signing out instead.
- Deleting an account (`deleteAllUserData()`) now also deletes that account's `usernames/{name}` reservation, so the name is freed for someone else to claim rather than being permanently squatted on by a deleted account.
- `saveUserProfile()` only ever writes a `username` field to Firestore when `state.username` is actually set locally - guards against a call site that runs before the profile's loaded from Firestore accidentally writing `username: null` over an already-reserved name.

**2. Settings' profile header now uses the same "hero-card" glass treatment as Home's identity card, instead of a plain flat row.** Previously `.settings-profile-row` was just an unstyled flex row (avatar + name) sitting directly under the "Settings" heading - visually flatter than everywhere else in the app. It's now wrapped in `.hero-card`/`.hero-top`/`.hero-profile` (the exact same classes Home's card uses, dark mode included for free) with a "Your Account" label above the name, matching Home's "Welcome"/time-of-day-greeting treatment above the username. `.settings-profile-row`'s old margin rule was repurposed into a new `.settings-hero-card` class (`margin: 20px 0 28px`) that supplies the spacing `.hero-card` itself doesn't have (Home relies on `.tab-content-wrapper`'s gap instead, which Settings doesn't use). All existing element IDs (`settingsAvatar`, `settingsName`, `settingsEmailSubtitle`) and the avatar-edit-badge pencil button were kept exactly as they were - `app.js` needed no changes for this part.

Ran the established full validation sweep before shipping (JS syntax, CSS brace balance, HTML div balance, no duplicate IDs, every new `onclick` resolves to a real function) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v11` → `v12`) since `app.js`/`app.css`/`index.html` all changed this round.

---

## Bug-fix round (4 requests)

**1. Firebase security rules delivery.** Going forward, any change to Firestore access rules ships as its own standalone `firestore-rules.md` document (full ruleset + rationale), not just described in a reply - see that file for the current recommended rules, including the `usernames` collection rules from the round above. It hasn't been pasted into the live Firebase console yet.

**2 & 3. All search bars - magnifying glass icon and text caret position bugs (real WebKit issue, fixed).** `.search-box input` is `type="search"`, which WebKit gives its own native decorations (a built-in magnifying-glass icon area, a cancel/"x" button) unless `-webkit-appearance: none` is set and the `::-webkit-search-decoration`/`::-webkit-search-cancel-button`/etc. pseudo-elements are explicitly hidden - none of that was ever done here. That native chrome fighting the app's own absolutely-positioned `.search-icon`/`.search-clear-btn` explains both symptoms: the custom icon could end up hidden behind/under the native one, and the caret sat at the wrong vertical position until the first keystroke, because WebKit only finalizes the input's internal box layout (decorations included) once there's actual content. Fixed once on the shared `.search-box input`/`.search-icon`/`.search-clear-btn` rules in `app.css`, which fixes every search bar in the app at once (Discover, Library TV/Movies, Upcoming isn't a search box, Streaming Region picker) since they all share the same classes.

**4. "Always open Home" on login or launch.** Signing in already worked correctly - `proceedToApp()` unconditionally calls `showPage('home')`. The gap was reopening the *installed* PWA while it's already running in the background: `manifest.json`'s `launch_handler.client_mode: "navigate-existing"` reuses the existing window instead of opening a new one, which means no navigation happens and `onAuthStateChanged` never refires (auth state hasn't changed) - so whatever tab was open before stayed open. Fixed with the Launch Handler API's `launchQueue.setConsumer()` (registered in the main `DOMContentLoaded` handler), which is purpose-built for exactly this - it fires on every launch, including a reused-window one, and forces `showPage('home')` each time.

**5. Long-press-to-change-poster firing mid-scroll (real bug, fixed).** `startPosterPress()`/`endPosterPress()` only ever cleared the 600ms long-press timer on `touchend`/`touchcancel`/`mouseup` - never on movement. Scrolling the Library grid with a finger that lingered near a poster for the full 600ms (easy to do at the start of a scroll gesture, or during momentum) would pop the Change Poster picker open mid-scroll. Fixed by tracking the touch's starting position and canceling the pending long-press the moment it moves more than ~10px (`movePosterPress()`, wired to a new `ontouchmove` on each poster) - the same "hold vs. drag" distinction the nav bar's drag-to-switch gesture already makes. Found and fixed the identical latent bug in the season-tab long-press (`toggleEntireSeasonWatched`) while in there - it's a horizontally-scrolling strip with the exact same missing-movement-cancellation pattern, just not yet reported; `moveSeasonPress()` added the same way.

Ran the established validation sweep (JS syntax, CSS brace balance, no duplicate IDs, every new `onclick`/`ontouchmove` resolves) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v12` → `v13`).

---

## Round: username format, analytics fix, Settings polish, nav drag fix, small UX tweaks (6 requests)

**1. Username format tightened to lowercase-only + `.`/`_`.** `USERNAME_REGEX` changed from `[a-zA-Z0-9_]` to `[a-z0-9._]` (dots now allowed, uppercase no longer). Rather than just rejecting uppercase after the fact, both username inputs (Join form's `#authUsername` and `#chooseUsernameInput`) now live-lowercase and strip disallowed characters as you type via a shared `sanitizeUsernameInput()`, wired up in the main `DOMContentLoaded` handler - so it's physically impossible to type an invalid character rather than typing it and then seeing an error. Google-name suggestion pre-fill in `showChooseUsernameScreen()` sanitizes the same way. Added `autocapitalize="none"`/`autocorrect="off"`/`spellcheck="false"` to both fields to stop the mobile keyboard fighting the lowercase-only rule.

**2. Viewing Analytics real bug fixed - "TV Shows" and "Movies" tiles were counting everything in the library, watched or not.** `renderHomeTab()`'s `totalShows`/`totalMovies` only ever filtered by `item.type`, never by watched status - unlike the adjacent "Episodes" tile, which was already correctly filtered to `ep.watched`. A show added to the library but not yet started, or a movie sitting unwatched, was inflating both tiles. Fixed: `totalShows` now requires at least one watched episode; `totalMovies` now requires `item.watched === true` - consistent with what "Episodes" already did and with what "Viewing Analytics" should mean.

**3 & 4. Settings still not matching the main app - two real, separate gaps found and fixed.** (a) Every full-screen `.modal-sheet` (Settings, NovaWrapped, show/episode details) was sitting on a flat frosted white/grey fill instead of the same colorful `--bg-mesh` gradient `<body>` (and therefore Home) actually uses - the glass cards inside matched the app's language, but the surface underneath them never did. `.modal-sheet`'s background now references `var(--bg-mesh)` directly (light and dark), so every full-screen sheet in the app now sits on the exact same backdrop Home does. (b) The redundant "Settings" `<h2>` title above the new hero-card was removed - Home itself has no page title above its own hero-card, so having one here was both extra chrome inconsistent with Home's page structure and, per request 3, unnecessary vertical space. `.modal-content`'s `padding-top` (which existed purely to clear the floating close button) was trimmed from 60px to 52px, and `.settings-hero-card`'s own top margin dropped from 20px to 0 - between removing the title and tightening these two, Settings' content now starts noticeably higher.

**5. Nav bar drag-to-switch - the real "must be fully on the tab" bug, found and fixed.** `finishDrag()` was using `document.elementFromPoint()` at release, which only counts as a hit when the release point is precisely inside a `.nav-button` element's own box - releasing in the small gaps *between* buttons (very easy with a thumb, especially mid-swipe, since there's a real 4px grid gap plus the bar's own padding) fell through to "outside any button" and reverted the drag. Replaced with nearest-button snapping: as long as the release point is anywhere within the nav bar's own bounds at all, it resolves to whichever button's horizontal center is closest, rather than requiring literal pixel-perfect containment. This is how native tab bars actually behave - close enough commits.

**6. Small user-friendliness tweaks:**
- `overscroll-behavior-y: contain` added to `body` - stops a vertical drag at the top/bottom of any page from rubber-banding into the browser's pull-to-refresh/overscroll glow, which read as "still a webpage" rather than an installed app. Scoped to the Y axis only, so the nav bar's own horizontal drag gesture and card swipe-to-remove are unaffected.
- All four search inputs (Discover, both Library sub-tabs, Region picker) got `enterkeyhint="search"`, so the mobile keyboard's action button reads "Search" instead of a generic "Go"/return arrow.
- The auth form's `authEmail`/`authPassword` fields (and `chooseUsernameInput`) never had `autocomplete` values set at all - added `autocomplete="username"`/`"email"`, plus `current-password` vs `new-password` on the shared password field depending on Sign In vs Join mode (switched live in `setAuthMode()`), so password managers can actually offer to save/fill credentials instead of guessing.
- Enter/Return now chains between auth fields (username → email → password on Join, email → password on Sign In) instead of submitting from every field - matches each field's new `enterkeyhint` ("next"/"next"/"go"), so the on-screen keyboard button does the same thing physical Enter does. Only the last field in the active chain actually submits.

Ran the established validation sweep (JS syntax, CSS brace balance, HTML div balance, no duplicate IDs, every new `onclick`/`oninput` resolves) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v13` → `v14`).

---

## Round: display name vs. username split, "nav bar glass" as the app-wide style, live username check (3 requests)

**1. Username and display name split into two separate fields.** Previously the app conflated them - claiming a username also overwrote whatever was in `profiles[0].name`. Now:
- `state.username` is the unique, fixed, lowercase-only handle - unchanged, still reserved via `claimUsername()`.
- `state.profiles[0].name` is a separate, freely-editable **display name**, shown everywhere in the UI (`updateHomeUI()` now reads this as its primary source, falling back to Firebase Auth's own `displayName` only in the brief window before the profile doc has loaded - previously it was the other way around).
- New **Edit Display Name** flow: tapping the name (or its pencil icon) in Settings' hero card opens `#editDisplayNameModal` (same `.confirm-card` pattern as Delete Account), which saves straight to `profiles[0].name` via `saveUserProfile()` - no format restriction beyond non-empty, since it's cosmetic only, not a unique handle.
- Settings now shows both: the display name (large, editable) and a secondary `@username` line underneath (`settingsUsernameSubtitle`), same idea as most social apps.
- At signup/username-claim time, the display name still defaults to the username chosen (a reasonable starting point), but `submitChosenUsername()` (the Google sign-in / legacy-account path) now only applies that default if `profiles[0].name` isn't already set - claiming a username on an account that already had a real display name (e.g. a Google account's actual name) no longer clobbers it.

**2. The bottom nav bar's glass treatment is now the app's main visual language, not a one-off pushed further than everywhere else.** Previously the shared "chrome" tokens (`--glass-chrome-fill`, `--glass-chrome-blur`, `--glass-chrome-border`, `--glass-chrome-shadow`) and `--surface`/`--surface-2`/`--surface-3` were deliberately kept a notch more opaque/bordered than `.bottom-nav`'s own bespoke recipe, out of caution around reintroducing legibility bugs from earlier dark-mode rounds. That caution's been superseded by this request - `tokens.css`'s shared tokens (light and dark) now mirror the nav bar's actual numbers: much lower fill opacity, heavier blur+saturation (`blur(70-72px) saturate(220-280%)`, vs. the old `blur(60-64px) saturate(180-240%)`), and a far softer border (`--glass-border` roughly halved in opacity) instead of a defined ring. Since most of the app's glass surfaces already read from these tokens, the change cascades automatically to `.search-box`, `.toast`, pill buttons, `.auth-input`, and more. The handful of surfaces that hardcode their own values instead of using the tokens were updated by hand to match: `.hero-card`, `.analytics-card`, `.confirm-card`, `.auth-overlay-card`, and `.modal-sheet-compact` (light and dark variants of each). `.hero-card` keeps its own blue tint (a deliberate identity choice, not part of the transparency system) but is now just as translucent as everything else. The nav bar itself (`.bottom-nav`) is untouched - it's still the reference point everything else now matches, not something that needed to change.

**3. Small user-friendliness tweaks:**
- Live "is this username available?" feedback added to the Choose Username screen (`wireUsernameAvailabilityCheck()`) - debounced 500ms after typing stops, shows "Checking availability...", then a green "Username is available" or red "Username is already taken" line. Purely informational - `claimUsername()`'s transaction at actual submit time is still what enforces it, since availability can change again in the gap between typing and submitting. Scoped to this screen only for now, not the Join form's own username field, which doesn't have a status slot in its current compact two-column layout - the submit-time check there is unchanged.
- `.settings-name-edit` (the new tappable display-name row in Settings) is a small pencil-icon affordance - worth a look if it ever feels hard to tap precisely on a small screen, since its hit area is currently just the text+icon's own bounds.

Ran the established validation sweep (JS syntax, CSS/tokens.css brace balance, HTML div balance, no duplicate IDs, every `onclick`/`oninput` resolves to a real function) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v14` → `v15`).

---

## Round: screenshot bug fixes, badge removal, image loading speed, poster radius unification (6 requests)

**1. Two real UI bugs found from the screenshots.**
- The new Edit Display Name modal (added last round) was using `.confirm-icon-badge` bare, which defaults to `var(--red-gradient)` - the same red/danger styling Delete Account uses. Editing your own display name isn't a destructive action, so it shouldn't get the same alarming red glow. Fixed by adding the `.rewatch-icon-badge` modifier class the codebase already had for exactly this ("make it blue instead of red") - same pattern the Rewatch Count popup already used.
- The search bar screenshot showed the text caret rendering below the visible pill instead of centered inside it. Root cause: an earlier round's search-bar fix had added `line-height: 50px` to match a fixed `height: 50px` - forcing a line-height that large relative to the 14px font size is exactly the kind of override that pushes a text caret outside an input's visible box in some browsers, and that's what was happening here. Removed both `height` and the forced `line-height`; `.search-box input` now reaches the same ~50px total height through padding alone (`padding: 15px 46px 15px 48px`, border-box), which centers a single line of text/caret using the browser's own normal line-height instead - the reliable cross-browser technique, rather than fighting the caret's own layout with an oversized explicit one.

**2. All "badge" overlays removed.** The red "NEW" pill on Library poster cards (`.new-episode-badge`, shown for a show with a released-but-unwatched recent episode) and the blue "UP NEXT" pill in the episode list (`.episode-up-next-badge`) are both gone, along with the now-unused `hasRecentUnwatchedEpisode()` helper. The episode list's subtle highlight background for the up-next row (`.episode-up-next`) stays - that's a background tint, not a badge. Left the small circular icon containers alone (avatar edit pencil, the icon atop confirm dialogs) since those are functional icon buttons/decorations, not status/label chips - a different kind of UI element from what "badge" meant here.

**3. Image loading speed.** Added a `tmdbThumb(url, size)` helper that swaps a TMDB image URL's size segment - every poster/still that's actually stored on an item is kept at its original larger size (w500/w780, since that same URL is also used in bigger contexts like the details modal), but small on-screen thumbnails now request an appropriately smaller TMDB size instead of downloading the full stored size and scaling it down in the browser:
  - Library grid / Discover carousel posters (`~126px` wide): w500 → w342
  - Continue Watching posters (`80px` wide): w500 → w342
  - Episode stills (`116×65px`): w780 → w300 - this one was the most oversized by far
  - Also added `decoding="async"` to every image tag that was missing it (lets the browser decode off the main thread instead of blocking on it), and `loading="lazy"` to the avatar picker grid's thumbnails. The always-visible Home/Settings avatar was deliberately left non-lazy (it's small, above-the-fold, and shown immediately on load - lazy-loading it would only delay something that should appear instantly) but still got `decoding="async"`.

**4. Poster corner radius unified across every tab.** `.poster` (Library/Discover carousel, 20px via `--radius-lg`), `.search-card-poster` (Discover's "For You" grid, was a hardcoded 14px), `.continue-poster` (Home's Continue Watching, was a hardcoded 16px), and `.upcoming-poster` (Upcoming tab, was also a hardcoded 14px) were all genuinely different corner radii for the exact same conceptual element - a poster thumbnail. `tokens.css`'s own radius scale already documented `--radius-lg` as the intended value for "posters, continue-card" - these three rules just never actually used the token. All four now use `var(--radius-lg)`, so a poster thumbnail is now the same shape everywhere it appears, tab to tab. (`.search-card`/`.upcoming-card` - the row *containers* those posters sit inside - already matched each other at `--radius-md`, so no change was needed there.)

Ran the established validation sweep (JS syntax, CSS/tokens.css brace balance, HTML div balance, no duplicate IDs, every `onclick`/`oninput` resolves, no dangling references to the removed badge code) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v15` → `v16`).

---

## Round: Edit Display Name spacing, search bar caret bug (round 2) (2 requests)

**1. Edit Display Name modal spacing fixed - a real layout gap found from the screenshot.** `.confirm-card` (the shared modal shell for Delete Account, Edit Display Name, etc.) is a plain block container, not a flex layout - it has no automatic `gap` between its children the way `.auth-form` (the sign-in screen) does. The username input's wrapper (`.auth-field`) had 24px of space above it (from `.confirm-message`'s own `margin-bottom`) but nothing at all below it, so it sat flush against the Cancel/Save buttons - a lopsided, cramped-looking gap. Fixed with a scoped `.confirm-card .auth-field { margin-bottom: 20px; }` rule, deliberately scoped to `.confirm-card` only so the already-correctly-spaced auth screen (which gets its rhythm from `.auth-form`'s flex gap instead) isn't touched.

**2. Search bar caret bug - still broken after the previous fix, so reconsidered from scratch rather than patched again.** Two rounds in a row tried to fix this by resetting CSS on a `type="search"` input (first `-webkit-appearance`/hiding native decorations, then removing a `line-height` override) - neither held up on a real device. The actual issue: `type="search"` gets special, WebKit-internal layout handling on iOS that CSS resets don't reliably override, even with `-webkit-appearance: none` applied - that's why the bug kept resurfacing after each attempted fix targeted a different symptom of the same root cause. Rather than trying a third CSS-only patch, all four search inputs (`onlineSearchInput`, `tvLibrarySearchInput`, `movieLibrarySearchInput`, `regionSearchInput`) were switched from `type="search"` to plain `type="text"` with `inputmode="search"` added - this sidesteps the whole class of bug at the source instead of continuing to fight WebKit's internal rendering for it. `inputmode="search"` alone is what gives the on-screen keyboard its "search" return key; nothing about the visible search UI changes, since the app's own `.search-icon`/`.search-clear-btn` were always the only rendered affordances anyway, never any native ones. The now-moot `::-webkit-search-decoration` etc. pseudo-element rules (only relevant to `type="search"`) were removed as dead CSS rather than left behind confusingly.

Ran the established validation sweep (JS syntax, CSS brace balance, HTML div balance, no duplicate IDs, no JS logic depending on the search inputs' `type` attribute) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v16` → `v17`).

---

## Round: Settings modal completely reworked to match the rest of the app

Settings previously lived in its own distinct structural world from every other tab - a generic `.modal-header-nav`/`.close-button` floating corner button (shared with every other modal in the app, from Delete Account to the poster picker), `.modal-content` with a hand-tuned `padding-top: 52px` to clear that floating button, a `.settings-hero-card` margin override, and section headers using a `.settings-section-title` modifier at `15px` - nearly a third smaller than the `21px` Home/every other tab uses for the exact same role ("Viewing Analytics" vs. "Preferences"). None of that matched the actual tab pages it sits alongside.

**Reworked to structurally mirror Home exactly:**
- **The floating close button is gone.** Settings' hero-card now uses `.settings-entry-btn` - the *exact same* button Home's hero-card uses to open Settings in the first place - in the exact same position (top-right of `.hero-top`, via the same `justify-content: space-between` layout), just showing an X and calling `closeSettingsSheet()` instead of a gear calling `openSettingsSheet()`. Same size, same blue-glass styling, same spot on screen - it reads as that one button switching roles for the context it's in, which is what "the settings button should turn into the close button" meant.
- **Padding now matches every other tab exactly.** A new `.settings-page-content` class carries the identical `padding: 36px 18px 20px` every `.page` (Home/Discover/Library/Upcoming) uses - deliberately a *new* class rather than reusing `.page` itself, since `showPage()` does `querySelectorAll(".page").forEach(remove "active")` globally on every tab switch; sharing that class would have permanently hidden Settings' content (via `.page`'s own `display: none` default) the moment any tab changed elsewhere in the app while Settings happened to be open - a real bug caught before shipping, not a hypothetical one.
- **Section titles now match Home's exactly.** Removed the `.settings-section-title` modifier entirely - "Preferences"/"NovaWatch"/"Account"/"About" are now the same `21px`/800-weight `.section-title` as "Viewing Analytics"/"Continue Watching" on Home, not a smaller variant.
- **Section spacing now matches Home's exactly.** Removed `.settings-section`'s own `margin-bottom: 24px` in favor of wrapping everything in the same `.tab-content-wrapper` (flex column, `gap: 26px`) Home itself uses - identical rhythm between sections, not a separately-tuned value that happened to be close.
- **The hero-card itself is unchanged in content** (avatar edit, display name edit, `@username` line) - only its outer spacing (the removed `.settings-hero-card` margin override, no longer needed now that `.tab-content-wrapper`'s gap supplies it) and its top-right button changed.

Ran the established validation sweep (JS syntax, CSS brace balance, HTML div balance, no duplicate IDs, every `onclick` resolves, confirmed no JS references the removed `.modal-header-nav`/`.modal-content` structure) - all clean, plus the `.page`-class collision specifically checked and avoided as described above. Bumped `service-worker.js`'s `CACHE_NAME` (`v17` → `v18`).

---

## Round: search bar caret audit, scroll freezing fix (3 requests)

**1. Every search bar caret audited - all four confirmed fixed.** Checked for any `type="search"` input, `.search-box` usage, or dynamically-created search input anywhere in the codebase that might have been missed in the previous round's `type="text"` + `inputmode="search"` switch. All four (`onlineSearchInput`, `tvLibrarySearchInput`, `movieLibrarySearchInput`, `regionSearchInput`) were already converted and confirmed consistent - no stragglers. Also checked the other text inputs in the app (email/password/username fields) for the same class of bug (an explicit `line-height` forced to match a fixed `height`) - none of them have it; `.auth-input` relies on the browser's own default line-height within a fixed height, which is the normal, safe pattern and was never affected by this specific bug.

**2. Scrolling freeze/stutter - a real, concrete bug found and fixed.** None of the app's scrollable containers had `-webkit-overflow-scrolling: touch` set. Without it, iOS Safari falls back to a much less performant, non-hardware-accelerated scrolling implementation for any *inner* scrollable element (the page/body itself always scrolls natively regardless, but a `div` with `overflow-y: auto`/`overflow-x: auto` does not get that same treatment for free) - this is a well-documented, classic cause of exactly "freezes for a moment, then catches up" scrolling on iOS. Added to every scrollable container in the app: `.modal-sheet` (the shared full-screen sheet behind Settings, show/episode details, Achievements, NovaWrapped, and every picker modal - one fix covering all of them), `.region-picker-content .region-options-list` (the full country list), `.auth-overlay-card` (sign-in/choose-username screens), `.watch-on-providers` (the horizontal streaming-provider row in the details modal), and `.season-selector` (the horizontal season tab strip).

**3. No other concrete bugs found this pass.** Went looking specifically for scroll-triggered event listeners, `IntersectionObserver`/`MutationObserver` usage, and anything doing expensive synchronous work on a timer that could compound the freeze symptom - found none: the two `setInterval`s in the app (a 5-minute "did today roll over" check and the 20-minute background TMDB sync) are both lightweight and already properly guarded against overlapping runs, and neither does unguarded synchronous DOM work. The `-webkit-overflow-scrolling` gap above was the concrete, fixable bug this pass turned up.

Ran the established validation sweep (JS syntax, CSS brace balance, HTML div balance, no duplicate IDs) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v18` → `v19`).

---

## Round: search bar caret (round 3), season long-press text selection, mark-all-released button, upcoming release time (5 requests)

**1. Search bar caret - reconsidered again after a screenshot showed it still broken.** Two earlier attempts (removing a forced `line-height`, then switching `type="search"` to `type="text"`) were both sound fixes for real, separate issues, but the bug looked identical afterward each time - which pointed at something neither attempt touched: `backdrop-filter` applied directly to the `<input>` element itself. That's a known category of WebKit bug on iOS - a text-editable element that needs its own compositing layer for a blur effect can end up with the native caret rendered against stale/incorrect layer coordinates. Restructured `.search-box`: the glass fill/blur/border/shadow now live on the non-interactive wrapper `div`, and the `<input>` itself has a fully transparent background - it never gets `backdrop-filter` applied to it, on any state. Focus styling moved from `.search-box input:focus` to `.search-box:focus-within` accordingly (light and dark). **This is a genuinely hard bug that's now had three different fixes attempted** - if it's still not resolved after this, the next thing to check would be whether it's actually a native iOS text-cursor affordance (a "precision cursor" drag handle iOS shows for touch text editing) rather than a CSS bug at all, since that can't be suppressed from page CSS.

**2. Season button long-press selecting text - real bug found and fixed.** `.season-button` had `user-select: none` but was missing `-webkit-touch-callout: none` - on iOS, `user-select: none` alone doesn't fully suppress the long-press text-selection callout for an element whose visible content *is* text (a season number/label, exactly what these buttons are); `-webkit-touch-callout` is the separate property that actually stops it. This exact fix already existed for posters (`.poster`, `.continue-poster`, etc.) from an earlier round - it just hadn't been applied here yet. Added the same fix to `.continue-card` too (Home's Continue Watching row) as a preventive measure, since it has the same missing-property gap and the same text-content-plus-touch-gesture profile.

**3. Season selector "looks like it's in a block" - could not address this pass.** The message referenced an image, but only the search bar screenshot actually came through this round - nothing about the season selector's current look was visible to work from. Happy to take another look once that image comes through.

**4. New "Mark All Released Episodes Watched" button added to the show details modal.** Sits below the existing action rows (Stop Watching / Add to Library), only rendered when there's actually something to mark (at least one released-but-unwatched episode) - a no-op button once a show's already caught up would just be clutter. `markAllReleasedEpisodesWatched()` mirrors `toggleEntireSeasonWatched()`'s existing conventions exactly (same `setEpisodeWatched()`/`saveItem()` calls, same "released episodes only, unaired ones untouched" rule) but scoped to the whole show instead of one season, and unlike the season version, only ever marks forward to watched - a whole-show catch-up action isn't the natural place to also offer a whole-show *un*-watch. Acts immediately without a confirmation step, consistent with every other watch-marking action in the app (watched status is always reversible per-episode afterward).

**5. Upcoming tab now shows a release time alongside the date, converted to the person's own local time.** New `formatReleaseTime()` sits next to the existing `formatDate()` - deliberately does *not* pin to UTC the way the date formatter does (that pin is intentional, so the calendar day TMDB reported never drifts for someone in a very negative UTC offset), since showing local time is the entire point here. Added to both TV episode and movie cards in the Upcoming tab. Worth flagging: the 08:00 UTC anchor this converts isn't a real, TMDB-sourced premiere time - TMDB only ever reports a release *date*, never a time - it's a synthetic buffer `tmdbDateToISO()` picked so the periodic background sync has a window to actually run before something's treated as released. Displaying it converted to local time is what was asked for, but it's approximate, not a minute-accurate premiere time.

Ran the established validation sweep (JS syntax, CSS brace balance, HTML div balance, no duplicate IDs, every `onclick` resolves including the new button's) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v19` → `v20`).

---

## Round: season selector "looks like it's in a block" (follow-up screenshot)

**Real cause found via the screenshot's own comparison point.** Every `.season-button` (and `.season-rewatch-button`) carried its own full glass treatment - background, border, backdrop-filter, *and* `box-shadow: var(--glass-shadow-sm)` - each. With several sitting directly adjacent in a row, their individual shadows visually merged into one continuous shadowed band underneath the whole strip, which is exactly what "looks like it's in a block" was describing. The app already has a clean, proven pattern for this exact kind of control - `.segmented-toggle` (Light/Dark/Auto, TV/Movies) - which never had this problem, because it works the other way around: *one* shared background/border container for the whole strip, with individual buttons fully transparent except when active.

Restructured `.season-selector` to match that pattern: the shared trough background/border/padding moved from being absent (nothing there before) onto `.season-selector` itself (`background: var(--surface-2)`, `border: 1px solid var(--glass-border-subtle)`, `border-radius: 999px`, `padding: 4px`), and `.season-button` was stripped down to `background: transparent; border: none; box-shadow: none` - it now only gets a visible fill (the blue gradient) when `.active`. No more per-pill shadow to merge with its neighbors', so the row now reads as several buttons inside one shared strip - the same visual language `.segmented-toggle` already uses - rather than a stack of individually-shadowed chips whose shadows blur together into a slab. `.season-rewatch-button` (the circular refresh icon at the end) was left as-is - it's a separate, secondary action sitting outside the trough, not part of the row of identical shadow-casting siblings that caused the problem, so it's fine to keep its own distinct floating-button shadow.

Ran the established validation sweep (JS syntax, CSS brace balance, no JS reading the removed border/backdrop-filter properties) - all clean. Bumped `service-worker.js`'s `CACHE_NAME` (`v20` → `v21`).
