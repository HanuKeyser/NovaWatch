# NovaWatch — v1.0.0

What's included, top to bottom.

## Tracking & Library

- Search and add TV shows and movies, mark them watched with a single tap.
- Rewatch tracking, per-episode for TV and per-title for movies, via a tap-to-manage popup rather than a one-way counter. A season can be bulk-rewatched once every released episode in it has been watched at least once.
- Library organized into In Progress, Up to Date, Finished, Unwatched, Coming Soon, and Stopped Watching, sorted by each show's real most-recently-aired episode.
- Finished, Unwatched, and Stopped Watching can each be shown or hidden independently in Settings.
- Continue Watching on Home surfaces the next unwatched episode for every in-progress show, plus any unwatched movies, with swipe actions to mark watched or stop watching.
- Opening a show's details lands on and scrolls straight to the episode you actually need to watch next, rather than the top of Season 1.
- Discover → For You, recommendations seeded from your library.
- Deep links for sharing a show, movie, or a specific episode.
- Unique usernames alongside a freely editable display name.

## Release Timing

- TV episodes carry a real, timezone-correct release date. Broadcast and cable shows use a real, network-announced airtime; streaming shows use a consistent midnight-Pacific convention, the same one movies use — calibrated to never claim something's released before it verifiably is, anywhere.
- A future episode can't be marked watched, doesn't count toward progress anywhere in the app, and shows a countdown instead of "Unwatched."
- An Upcoming tab lists every not-yet-released episode and movie in the library, organized the same way as the Library tab (a TV Shows/Movies toggle, search, poster grid), bucketed into Today/Tomorrow/This Week/Later.

## Notifications

- Two delivery paths: notifications fire locally while the app is open or was recently backgrounded, and real push delivery reaches a device even when the app is fully closed.
- Notifications fire only on the actual release day, checked against the real release instant for that specific viewer — never at the moment metadata merely mentions something coming, and never for episodes that were already out when a show was added.
- On a day when nothing in your library is releasing, an optional reminder can nudge you about an at-risk watch streak, or about episodes waiting in Continue Watching after a few days away — each with its own separate condition so neither becomes a daily nag.
- Every category — new episodes, show premieres, movie releases, streak reminders, Continue Watching reminders — can be turned on or off independently in Settings, synced to your account so the preference follows you across devices.

## Home & Viewing Analytics

- Total watch time, including rewatch passes.
- Current watch streak, shown as a badge — lit while a streak is active, muted when it isn't. Distinct from the all-time-record streak achievement, which never resets.
- Counts of watched movies, shows, episodes, and rewatches.
- Achievements for library and viewing milestones.

## NovaWrapped

A yearly recap, tracking January 1 – December 31 in your own timezone, with a grace period after account creation so bulk-adding existing watch history doesn't count as binge-watching.

## Settings

- Appearance: Light, Dark, or automatic based on your device.
- Streaming region: a full country picker, auto-detected from your device's location on first sign-in (with a browser-locale fallback), always editable manually afterward — drives which "where to watch" information you see.
- Notification Types and Library Display, each with independent per-category control.
- Account: sign-out, account deletion with re-authentication, and Privacy Notice & Terms of Service.

## Account & Privacy

- Email/password and Google sign-in, with email verification and password reset.
- A Terms of Service & Privacy Notice consent step when creating an account.
- Account deletion available directly in the app.

## Design

- A consistent "Liquid Glass" visual language across cards, sheets, buttons, and the floating navigation bar — translucent, blurred surfaces with a soft sheen, sharing one shared set of color and glass tokens rather than each surface inventing its own treatment.
- Full-bleed layout on an installed device: the background extends behind the Dynamic Island, notch, status bar, and home indicator on every device, while actual content stays clear of all of them automatically.
- Text selection and iOS's long-press copy callout are disabled app-wide by default, so it reads as an installed app rather than a page of selectable text — real input fields are unaffected.
- Dark mode throughout, applied before first paint so there's no flash between themes on load.

## Platform

- Installable as a PWA on iOS and Android, with home-screen shortcuts to Discover, Library, and Upcoming.
- Offline app-shell caching, so a repeat visit still loads something during a brief connection drop.
