# NovaWatch

A mobile-first PWA for tracking TV shows and movies — search, add to a library, mark episodes/movies watched, log rewatches, and get release alerts. Built on Firebase (Auth + Firestore) and the TMDB API, with JustWatch-sourced "where to watch" availability.

Live at `https://www.novawatch.site/`. Mobile-first by design — no desktop/tablet layout is planned.

---

## File structure

```
/ (novawatch.site root)
├── index.html              The app itself — auth, Home/Discover/Library/Upcoming tabs,
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
- **TVmaze API** — real per-episode airtimes and each show's weekly schedule for TV, where available (see Upcoming below); scoped narrowly to those two things, never used for search, metadata, or anything else

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

**Discover → For You** — TMDB `/recommendations` seeded from your library, ranked by cross-seed hit count then TMDB score. Falls back to plain Trending when the library's empty for that content type.

**Continue Watching** (Home) — the next unwatched episode for every in-progress show, plus any unwatched movies. Swipeable: right reveals "mark watched", left reveals "remove" (or "stop watching" for a TV show with progress already logged, which keeps its watch history instead of deleting it).

**Upcoming** — everything in the library that hasn't released yet, with a countdown and a release date/time, converted to the viewer's own timezone (date and time always come from the same local reference frame, so they can never disagree about which calendar day a moment falls on).

Timing works like this, in order:
1. **A real per-episode airtime from TVmaze is used whenever TVmaze actually has one for that specific show and episode** — for any TV show, not gated by whether it's broadcast, cable, or streaming. This is what correctly handles a hybrid show that airs on a traditional network *and* is also available on a streaming platform (sometimes at a genuinely different time): TVmaze just reports whatever it actually tracks, and that's trusted directly.
2. **That data is validated before being trusted, not assumed correct just because it's well-formed.** TVmaze is looked up via the TheTVDB ID TMDB itself exposes, which can occasionally return the wrong show entirely (a stale or mismatched ID on either side) — so the returned show's name is compared against TMDB's own title, and any TVmaze match that doesn't reasonably line up is rejected outright. Each individual episode's airtime is separately checked against TMDB's own reported air date (rejected if it's off by more than a few days), catching a mismatched episode even within an otherwise correctly-matched show.
3. **When TVmaze has nothing valid for a given episode**, timing falls back to inferred real-world convention instead: midnight Pacific time (DST-aware) for a streaming platform or anything unrecognized, or 8pm Eastern (DST-aware) for a confirmed US broadcast or cable network (NBC, ABC, CBS, FOX, The CW, PBS, plus ~30 cable networks like AMC, FX, USA, TNT, HBO, Showtime). That broadcast/cable classification is itself cross-checked against confirmed watch-provider data for the viewer's own region (the same data the "Watch On" section uses) before being trusted, since TMDB's `networks` field mainly tracks the *producing* network — a cable-produced show distributed internationally through a streaming app can list only the producing network, with the streaming platform never mentioned at all, so a known streaming platform (Netflix, Disney+, Hulu, Max, Apple TV+, Paramount+, Peacock, Amazon, Crunchyroll) confirmed to carry the title overrides the broadcast/cable classification for this fallback.

Movies always use the streaming/Pacific convention, since TVmaze doesn't cover them. Whichever source ends up being used is what actually gates when something leaves Upcoming and starts counting as watchable elsewhere in the app (Continue Watching, marking episodes watched, etc.), not just a rough "today" check. Newly-computed data replaces stale values automatically on the next background sync or the next time the show's own details are opened; visiting the Upcoming tab also triggers a fresh sync if one hasn't run in the last couple of minutes, so switching to it is a reliable way to get current data without waiting.

**Content rating** — PG-13, TV-MA, etc., shown as a badge in the details modal for both movies and TV shows. Fetched from a separate per-region TMDB endpoint (`release_dates` for movies, `content_ratings` for TV), tried in the viewer's own streaming region first, falling back to US.

**Collection/franchise info** — for movies that TMDB has flagged as belonging to a collection (e.g. "Part of The Dark Knight Collection"), shown in the details modal. Movie-only; TV doesn't have an equivalent concept in TMDB.

**Weekly schedule** — for an ongoing TV show with an active broadcast/cable schedule, a line like "New episodes every Thursday at 9:00 PM" in the details modal, converted to the viewer's local time. Sourced from the same TVmaze lookup used for per-episode airtimes, so it doesn't cost an extra request.

**Viewing Analytics** (Home) — total watch time (including rewatch passes) and counts of watched movies/shows/episodes.

**Achievements** — computed client-side from library data on every load, not stored as separate synced records; only the small "which ones are unlocked" array is persisted. Bidirectional — unwatching something can revoke an achievement it had unlocked, not just grant new ones. Four free-tier achievements are currently active (10 movies watched, 10 shows completed, a 7-day watch streak, first rewatch logged); a second, larger premium tier exists in code (`PREMIUM_ACHIEVEMENTS`) but isn't switched on.

**Sharing** — deep links for a show/movie (`?share_type=tv|movie&share_id=<tmdbId>`) or a single episode (`?share_type=episode&share_id=<showTmdbId>&share_ep=<sXeY>`). Opening a shared episode link loads the parent show first, then drills into that specific episode.

**Unique usernames & display names** — every account reserves a unique, lowercase-only username (`[a-z0-9._]`, 3–20 characters), chosen at signup or via a blocking "Choose a username" screen for Google sign-in / any pre-existing account without one. Separate from that is a freely-editable **display name**, shown everywhere in the UI instead of the username — both are visible together in Settings (`Display Name` / `@username`). See `firestore-rules.md` for how username uniqueness is actually enforced.

**Settings** — reachable via the button on Home's identity card, which becomes a close (X) button while Settings is open. Covers appearance, streaming region, notifications, achievements, NovaWrapped, sign-out, account deletion, and Privacy & Terms. Structurally matches every other tab (same padding, same section-title sizing, same spacing rhythm) rather than being a visually separate design.

**Streaming region** — a full ISO 3166-1 country picker, auto-detected on first sign-in from the browser's own locale; drives which "where to watch" info TMDB/JustWatch returns.

**Dark mode** — a three-way Light/Dark/Auto toggle in Settings. Saved to `localStorage` (device-level, not synced across devices) and applied before first paint via an inline script in each page's `<head>`, so there's no light-then-dark flash. Auto follows the OS setting live via a `matchMedia` listener.

**Notifications** — opt-in browser notifications for new episodes/releases, requested from the same Settings row.

**Avatars** — 8 curated hosted images, assigned at random to a new account and always changeable via the picker in Settings.

**PWA install shortcuts** — long-pressing the installed app's icon offers Discover/Library/Upcoming as direct shortcuts (Home is skipped, since it's already the default landing).

**Bottom navigation** — a floating "Liquid Glass" pill bar. Supports both tapping a tab and dragging a finger across the bar to switch tabs, with the pill indicator tracking the finger continuously during a drag and settling into place on release.

---

## NovaWrapped

A "Wrapped"-style yearly recap, gated to release **January 1, 2027** — before that date, tapping its "View" button in Settings shows an error toast rather than opening anything. Lives as a modal (`#novaWrappedModal`), not a separate page, so it shares the same signed-in session's data as the rest of the app instead of loading a second copy of the Firebase SDK.

Tracks January 1 – December 31 UTC, with a 7-day grace period after account creation excluded (so bulk-adding existing watch history right after signing up doesn't count as binge-watching). Deliberately **excludes rewatches** from its totals, unlike Home's Viewing Analytics, which deliberately *does* count them — that inconsistency between the two is intentional, not a bug.

---

## Design system

`tokens.css` defines the shared "Liquid Glass" visual language — translucent, blurred, low-opacity surfaces with a soft diagonal sheen — used consistently across the whole app (cards, sheets, buttons, the search bars, the bottom nav) rather than each surface inventing its own treatment. A defined corner-radius scale (`--radius-xs` through `--radius-2xl`) assigns a consistent roundness by component role — e.g. every poster thumbnail across every tab uses the same radius, regardless of which screen it appears on.

---

## Not yet built

- **Multi-profiles** — the data model already supports an array of profiles, but there's no UI to add or switch between them; `activeProfileId` is currently always the single default profile.
- **Lists** — freeform, unstructured collections planned for Home (below Continue Watching) that wouldn't require fully adding a title to the tracked Library. Not built.
- **Premium tier** — `state.isPremiumUser` is a hardcoded `false` placeholder; nothing in the app is actually gated behind it yet, and no payment/billing integration exists. The intent is for premium to unlock things like extra profiles, deeper NovaWrapped detail, and the premium achievement tier above — without making the free tier feel incomplete.
- **Avatar uploads** — would require Firebase Storage, i.e. the paid Blaze plan; deferred until there's a reason to upgrade.
