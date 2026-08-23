# NovaWatch

A mobile-first PWA for tracking TV shows and movies — search, add to a library, mark episodes/movies watched, log rewatches, and get release alerts. Built on Firebase (Auth + Firestore) and the TMDB API, with JustWatch-sourced "where to watch" availability.

Live at `https://www.novawatch.site/`. Mobile-first by design — no desktop/tablet layout is planned.

---

## File structure

```
/ (novawatch.site root)
├── index.html              The app itself — auth, Home/Discover/Library tabs,
│                            Settings, and every modal (including NovaWrapped)
├── manifest.json           PWA manifest — installability, icons, home-screen shortcuts
├── service-worker.js       Offline app-shell caching + notification click handling
├── styles/
│   ├── tokens.css          Shared design tokens (colors, light/dark palette) — the one
│   │                       source both HTML pages link, so they can't drift apart
│   └── app.css             index.html's component styles
├── scripts/
│   └── app.js              index.html's application logic (~6,600 lines, classic script —
│                            not type="module", since the markup calls global functions
│                            directly via inline onclick="...")
└── privacy-terms/
    └── index.html          Privacy Notice & Terms of Service, opened in-app as a full-
                             screen overlay (openPageOverlay('privacy-terms/'))
```

`privacy-terms/index.html` deploys one folder level deeper than `index.html` (i.e. `novawatch.site/privacy-terms/`) and links `styles/tokens.css` as `../styles/tokens.css` to account for that. It also keeps its own copies of a handful of `app.css` component classes (`.analytics-card`, `.section-title`, `.section-header`) so it matches the rest of the app's visual language without linking the full stylesheet, whose global `body`/`h1`/`a` rules are tuned for the app shell specifically.

---

## Tech stack

- **Firebase Auth** — email/password and Google sign-in
- **Firestore** — the only backend; no server of NovaWatch's own
- **TMDB API** — search, metadata, episode/season data, recommendations
- **JustWatch (via TMDB)** — streaming availability by region
- **TVmaze API** — real per-episode broadcast/cable airtimes, used for TV episode release timing (see the TV episode release timing feature entry below). No API key required. Not used for streaming shows - see that entry for why.

### Firebase plan

Currently on the free **Spark** plan. This is a real constraint on the feature set: Spark doesn't include Cloud Storage, which is why avatars are a curated set of 8 hosted images rather than user uploads. Anything that needs Storage stays deferred until there's a reason to move to the paid Blaze plan.

### Data model

- `users/{uid}` — profile doc: `profiles` (array, currently always a single entry), `activeProfileId`, `region`, `username`
- `users/{uid}/library/{itemId}` — each tracked movie/TV show
- `users/{uid}/archivedShows/{slug}` — shows removed from the library but kept for history purposes
- `usernames/{lowercased-username}` — `{uid, username}` reservation docs, used to enforce unique usernames (see below)

**Security rules** live in their own document, `firestore-rules.md`, kept up to date separately from this file — check there for the current recommended ruleset and whether it's actually been applied in the Firebase console yet.

---

## Core features

**Library & search** — TMDB-backed search; add movies/TV shows; mark watched with a single tap (no rating/reaction popup in the way).

**Rewatch tracking** — per-episode for TV, per-title for movies, via a tap-to-manage popup (Add/Remove Rewatch) rather than a one-way counter. Unwatching something clears its rewatch history. A season can also be bulk-rewatched (or have its rewatches cleared) once every released episode in it has been watched at least once — gated behind a long-press on that season's tab, or the "Mark All Released Episodes Watched" button for the whole show at once.

**Opening a TV show's details** — lands on the season containing the next released-but-unwatched episode (`getCurrentSeasonForShow`) and auto-scrolls the episode list straight to that row, rather than opening at the top of Season 1 and leaving the person to hunt for where they left off. A caught-up show lands on the season of its most recently watched episode instead. A show with nothing released and unwatched yet (nothing to scroll to) simply opens at the top, same as it always did.

**Discover → For You** — TMDB `/recommendations` seeded from your library, ranked by cross-seed hit count then TMDB score. Falls back to plain Trending when the library's empty for that content type.

**Continue Watching** (Home) — the next unwatched episode for every in-progress show, plus any unwatched movies. Swipeable: right reveals "mark watched", left reveals "remove" (or "stop watching" for a TV show with progress already logged, which keeps its watch history instead of deleting it). Marking an episode watched this way also shows how many episodes are left in that show, if any.

**TV episode release timing** — every episode carries a real release instant again, timezone-correct for every viewer. This was fully removed at one point (see the git history of this file for that saga) after a long series of attempts kept surfacing new edge cases. Brought back deliberately differently: rather than one formula trying to cover every show, each episode is anchored one of two ways -
- **Broadcast/cable shows** — a real, network-announced local airtime from TVmaze, when TVmaze lists the show under a real `network` (not a `webChannel`). Converted DST-aware via the same `getTimezoneAnchorUTC` helper movies already used, just pointed at the network's own timezone instead of always Pacific.
- **Everything else** (streaming, or no TVmaze match at all) — the same midnight-Pacific streaming convention movies use. Deliberately the *latest* time in the range real streaming platforms actually use (official Netflix/Disney+ policy; most others release earlier in the evening PT), so this can under-promise (show "not released yet" for a few extra hours on an early-release platform) but never over-promise (claim something's out before it verifiably is, anywhere).

Only the calendar DATE this produces is meant to be trusted per viewer timezone - not the exact hour. `isReleased()` does an exact-instant comparison (not a calendar-day one), so a not-yet-released episode can't be marked watched, doesn't count toward Library/Continue Watching progress, and shows a countdown instead of "Unwatched" in the episode list and details modal. TVmaze resolution (`resolveTVmazeShow`) is cached per show on `tvmazeId` so a show only gets searched for once; a show TVmaze doesn't have just stays on the streaming default, same as every show did before this feature existed - never a hard failure. Movies are unaffected — same convention as before.

**Content rating** — PG-13, TV-MA, etc., shown as a badge in the details modal for both movies and TV shows. Fetched from a separate per-region TMDB endpoint (`release_dates` for movies, `content_ratings` for TV), tried in the viewer's own streaming region first, falling back to US.

**Collection/franchise info** — for movies that TMDB has flagged as belonging to a collection (e.g. "Part of The Dark Knight Collection"), shown in the details modal. Movie-only; TV doesn't have an equivalent concept in TMDB.

**Viewing Analytics** (Home) — total watch time (including rewatch passes) and counts of watched movies/shows/episodes.

**Achievements** — computed client-side from library data on every load, not stored as separate synced records; only the small "which ones are unlocked" array is persisted. Bidirectional — unwatching something can revoke an achievement it had unlocked, not just grant new ones. Four free-tier achievements are currently active (10 movies watched, 10 shows completed, a 7-day watch streak, first rewatch logged); a second, larger premium tier exists in code (`PREMIUM_ACHIEVEMENTS`) but isn't switched on.

**Sharing** — deep links for a show/movie (`?share_type=tv|movie&share_id=<tmdbId>`) or a single episode (`?share_type=episode&share_id=<showTmdbId>&share_ep=<sXeY>`). Opening a shared episode link loads the parent show first, then drills into that specific episode.

**Unique usernames & display names** — every account reserves a unique, lowercase-only username (`[a-z0-9._]`, 3–20 characters), chosen at signup or via a blocking "Choose a username" screen for Google sign-in / any pre-existing account without one. Separate from that is a freely-editable **display name**, shown everywhere in the UI instead of the username — both are visible together in Settings (`Display Name` / `@username`). See `firestore-rules.md` for how username uniqueness is actually enforced.

**Settings** — reachable via the button on Home's identity card, which becomes a close (X) button while Settings is open. Covers appearance, streaming region, notifications (including Notification Types and Library Display sub-screens), achievements, NovaWrapped, sign-out, account deletion, and Privacy & Terms. Structurally matches every other tab (same padding, same section-title sizing, same spacing rhythm) rather than being a visually separate design.

**Streaming region** — a full ISO 3166-1 country picker, still fully manual and editable at any time; auto-detected on first sign-in via the browser's real Geolocation API (reverse-geocoded to a country through a free client-side lookup) when available and granted, falling back to a locale-string guess for every failure mode - no geolocation support, permission denied, a timed-out/failed lookup, or an unsupported country. Drives which "where to watch" info TMDB/JustWatch returns.

**Dark mode** — a three-way Light/Dark/Auto toggle in Settings. Saved to `localStorage` (device-level, not synced across devices) and applied before first paint via an inline script in each page's `<head>`, so there's no light-then-dark flash. Auto follows the OS setting live via a `matchMedia` listener.

**Notifications** — opt-in browser notifications for new episodes, show premieres, and movie releases, requested from the same Settings row. Only ever fires on the actual release day (an exact per-item day check against the item's real release instant, deduplicated so the same item never re-notifies the same day) - never at the moment TMDB/TVmaze data merely mentions something, and never for episodes that were already out when a show was added, since a freshly-added show's full episode list is already in hand at add time. Every category shares one notification title, "New Release" — the body carries the specifics ("Show Name - Season X Episode X release" for TV, "Movie Name - Movie Release" for movies). A separate "Notification Types" row lets each category (New Episodes / Show Premieres / Movie Releases) be turned off independently, stored device-side the same way the theme preference is. No "you'll be notified..." confirmation notifications anywhere - enabling notifications or adding an item only ever shows a toast/button-state change, not a notification whose entire content is announcing a future notification. The "Stay in the loop" button itself, and every other on/off-style status in the app (Notification Types, Library Display), share one green (on/enabled) / red (off/blocked) visual language - a device that can't support notifications at all shows a neutral muted state instead of red, since that's a device limitation, not something the person chose to turn off.

**Library Display** (Settings) — Finished, Unwatched, and Stopped Watching (the three TV Library categories that hide content the person is done with, hasn't started, or chose to stop, one way or another) can each be shown or hidden independently - on (green) by default, off (red) once the person turns one off - stored device-side the same way notification preferences are. Purely a display filter - hiding a category never touches the underlying watched/stopped data, it just skips rendering that category block.

**Avatars** — 8 curated hosted images, assigned at random to a new account and always changeable via the picker in Settings.

**PWA install shortcuts** — long-pressing the installed app's icon offers Discover/Library/Upcoming as direct shortcuts (Home is skipped, since it's already the default landing).

**Upcoming** (4th bottom-nav tab) — every not-yet-released movie and TV episode from the library (every queued-up episode per show, not just the next one). Same structure as Library: a TV Shows/Movies segmented toggle (`setUpcomingView`), each sub-view rendered with the exact same category-block/poster-grid card component Library uses (including the same long-press-to-change-poster gesture, since these are already-tracked library items), just bucketed by Today/Tomorrow/This Week/Later instead of watch status. Each card adds one single-line caption under the title (season/episode + countdown, or just the countdown for movies) since an upcoming item needs its release status spelled out in a way an already-added Library item doesn't. Tapping a card opens the usual details modal.

**Bottom navigation** — a floating "Liquid Glass" pill bar, 4 tabs (Home/Discover/Library/Upcoming). Supports both tapping a tab and dragging a finger across the bar to switch tabs, with the pill indicator tracking the finger continuously during a drag and settling into place on release. The indicator measures whichever button is active at render time, so it isn't hardcoded to any particular tab count.

**Change-aware list rendering** — Library, Continue Watching, and the episode list inside a show's details modal only touch the DOM when their content has genuinely changed, rather than rebuilding on every periodic background sync (or every time the modal refreshes) regardless. Rebuilding unconditionally was destroying and recreating every poster/thumbnail/episode-still image element each time, which read as flashing even though nothing had actually changed.

---

## NovaWrapped

A "Wrapped"-style yearly recap, gated to release **January 1, 2027** — before that date, tapping its "View" button in Settings shows an error toast rather than opening anything. Lives as a modal (`#novaWrappedModal`), not a separate page, so it shares the same signed-in session's data as the rest of the app instead of loading a second copy of the Firebase SDK.

Tracks January 1 – December 31 UTC, with a 7-day grace period after account creation excluded (so bulk-adding existing watch history right after signing up doesn't count as binge-watching). Deliberately **excludes rewatches** from its totals, unlike Home's Viewing Analytics, which deliberately *does* count them — that inconsistency between the two is intentional, not a bug.

---

## Design system

`tokens.css` defines the shared "Liquid Glass" visual language — translucent, blurred, low-opacity surfaces with a soft diagonal sheen — used consistently across the whole app (cards, sheets, buttons, the search bars, the bottom nav) rather than each surface inventing its own treatment. A defined corner-radius scale (`--radius-xs` through `--radius-2xl`) assigns a consistent roundness by component role — e.g. every poster thumbnail across every tab uses the same radius, regardless of which screen it appears on.

Text selection and iOS's long-press copy/selection callout are disabled app-wide by default (meant to feel like an installed app, not a page of selectable text) - real `<input>`/`<textarea>` fields explicitly re-enable both, so typing, selecting, and copying what the person actually types (search bars, display name, etc.) still works normally.
