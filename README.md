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

**Movie release dates** — still tracked and displayed (details modal, gates "mark watched" until release), computed from TMDB's reported date anchored to the real-world midnight-Pacific streaming convention.

**TV episode timing — dateless.** Episodes still have a real released/not-yet-released gate, same as movies — it's just not backed by any stored date or time. Each episode gets a plain `released` boolean, computed from TMDB's own reported air_date compared to today's calendar date (no timezone anchoring, no display of any date or countdown anywhere). An unreleased episode is visibly dimmed with a "Not Yet Released" label instead of "Unwatched", can't be marked watched (same rejection pattern as an unreleased movie), and doesn't count toward a show's watched-progress total or show up as "next up" in Continue Watching. Because there's no stored instant the way movies get, this is only as current as the last time the show was fetched or background-synced — not a continuously live check. There's also no Upcoming tab and no per-episode clock time at all. This replaced a fairly involved prior system (TVmaze airtimes, then a TMDB-date-plus-broadcast/streaming-convention replacement) that kept surfacing new ways to be subtly wrong; it's been stripped down to this simpler boolean rather than patched further. The one other thing tracked at the show level is `hasNextEpisode`, a plain presence flag from TMDB's `next_episode_to_air` (again, no date attached), used only to distinguish "Up to Date" (more episodes are coming) from "Finished" (they're not) in the Library grid. A real timezone-aware date/time display for TV is planned to be rebuilt later, from scratch.

**Content rating** — PG-13, TV-MA, etc., shown as a badge in the details modal for both movies and TV shows. Fetched from a separate per-region TMDB endpoint (`release_dates` for movies, `content_ratings` for TV), tried in the viewer's own streaming region first, falling back to US.

**Collection/franchise info** — for movies that TMDB has flagged as belonging to a collection (e.g. "Part of The Dark Knight Collection"), shown in the details modal. Movie-only; TV doesn't have an equivalent concept in TMDB.

**Viewing Analytics** (Home) — total watch time (including rewatch passes) and counts of watched movies/shows/episodes.

**Achievements** — computed client-side from library data on every load, not stored as separate synced records; only the small "which ones are unlocked" array is persisted. Bidirectional — unwatching something can revoke an achievement it had unlocked, not just grant new ones. Four free-tier achievements are currently active (10 movies watched, 10 shows completed, a 7-day watch streak, first rewatch logged); a second, larger premium tier exists in code (`PREMIUM_ACHIEVEMENTS`) but isn't switched on.

**Sharing** — deep links for a show/movie (`?share_type=tv|movie&share_id=<tmdbId>`) or a single episode (`?share_type=episode&share_id=<showTmdbId>&share_ep=<sXeY>`). Opening a shared episode link loads the parent show first, then drills into that specific episode.

**Unique usernames & display names** — every account reserves a unique, lowercase-only username (`[a-z0-9._]`, 3–20 characters), chosen at signup or via a blocking "Choose a username" screen for Google sign-in / any pre-existing account without one. Separate from that is a freely-editable **display name**, shown everywhere in the UI instead of the username — both are visible together in Settings (`Display Name` / `@username`). See `firestore-rules.md` for how username uniqueness is actually enforced.

**Settings** — reachable via the button on Home's identity card, which becomes a close (X) button while Settings is open. Covers appearance, streaming region, notifications, achievements, NovaWrapped, sign-out, account deletion, and Privacy & Terms. Structurally matches every other tab (same padding, same section-title sizing, same spacing rhythm) rather than being a visually separate design.

**Streaming region** — a full ISO 3166-1 country picker, auto-detected on first sign-in from the browser's own locale; drives which "where to watch" info TMDB/JustWatch returns.

**Dark mode** — a three-way Light/Dark/Auto toggle in Settings. Saved to `localStorage` (device-level, not synced across devices) and applied before first paint via an inline script in each page's `<head>`, so there's no light-then-dark flash. Auto follows the OS setting live via a `matchMedia` listener.

**Notifications** — opt-in browser notifications for new episodes/movie releases, requested from the same Settings row.

**Avatars** — 8 curated hosted images, assigned at random to a new account and always changeable via the picker in Settings.

**PWA install shortcuts** — long-pressing the installed app's icon offers Discover/Library as direct shortcuts (Home is skipped, since it's already the default landing).

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
- **TV episode date/time display & an Upcoming tab** — deliberately torn out (see "TV episode timing — dateless" above) rather than patched further; the released/unreleased gate itself is still there, just dateless. A real timezone-aware version is planned to be rebuilt from scratch.
- **Lists** — freeform, unstructured collections planned for Home (below Continue Watching) that wouldn't require fully adding a title to the tracked Library. Not built.
- **Premium tier** — `state.isPremiumUser` is a hardcoded `false` placeholder; nothing in the app is actually gated behind it yet, and no payment/billing integration exists. The intent is for premium to unlock things like extra profiles, deeper NovaWrapped detail, and the premium achievement tier above — without making the free tier feel incomplete.
- **Avatar uploads** — would require Firebase Storage, i.e. the paid Blaze plan; deferred until there's a reason to upgrade.
