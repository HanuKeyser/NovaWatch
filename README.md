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
- **PWA install shortcuts** — declined.
- **Calendar/.ics export** — tried in an earlier version, didn't like it, not revisiting.
- **Per-user private ratings** — moving to a combined/community rating (all users' ratings averaged per title) instead.
- **Emoji-reaction popups on marking watched** — a TV Time pain point; deliberately avoided to keep "mark as watched" a single, frictionless tap.

---

## NovaWrapped

A "Wrapped"-style yearly recap, gated to release **January 1, 2027**. Originally its own separate page; migrated into `index.html` as a modal (see `#novaWrappedModal` and `openNovaWrappedModal()`) since it always needed the same signed-in session's Firestore data as everything else - being separate meant loading a whole second copy of the Firebase SDK just to read data the main app already had in memory. Before the release date, opening it shows a countdown card instead of stats; the Settings row's "View" button works either way - the release gate lives inside the modal's content, not the entry point.

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

Other things flagged as ideas but not committed to a slot: all-time/lifetime stats page, a "time to finish" estimator, custom watch statuses (Plan to Watch/On Hold/Dropped), a household activity view (once profiles exist), Discover genre/mood filters, home/lock-screen widgets (would require going native).

---

## A note on scale

This file has grown a lot in one sitting (`app.js` alone is ~5,500 lines). A few things worth watching as it keeps growing:
- The `openDetails()` mishap (a routine edit briefly deleted its own function declaration, caught by a syntax check before shipping) is a preview of the kind of mistake that gets more likely as a single file gets larger. If a feature area gets substantial enough (achievements, sharing, the sync logic), consider whether it's ready to be its own module.
- `privacy-terms/index.html` keeps its own copies of a handful of component classes it borrows from `app.css`'s visual language (`.analytics-card`, `.section-title`, `.settings-section-title`, `.section-header` - used to give it the same "stack of cards with labels" structure as Settings and NovaWrapped, instead of the one-big-document-card layout it used to have). That's a deliberate, contained exception - full `app.css` isn't linked there because its global `body`/`h1`/`a` rules are tuned for the app shell and risk leaking onto this page's own layout in ways that are hard to verify without live testing. If any of those four classes change in `app.css`, this page's copies need updating too. `tokens.css` (the actual colors/palette) staying singular is what matters most - that's what caused the real sync bugs earlier.
