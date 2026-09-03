# NovaWatch — v1.0.0

Launched October 1, 2026.

What's included, top to bottom.

## Tracking & Library

- Search and add TV shows and movies, mark them watched with a single tap.
- Rewatch tracking, per-episode for TV and per-title for movies, via a tap-to-manage popup rather than a one-way counter. A season can be bulk-rewatched once every released episode in it has been watched at least once.
- Library organized into In Progress, Up to Date, Finished, Unwatched, Coming Soon, and Stopped Watching, sorted by each show's real most-recently-aired episode.
- Finished, Unwatched, and Stopped Watching can each be shown or hidden independently in Settings.
- Continue Watching on Home surfaces the next unwatched episode for every in-progress show, plus any unwatched movies, with swipe actions to mark watched or stop watching. A show that's gone quiet for a couple of months gets its own small "Still watching this?" card above the list, with a one-tap way to mark it Stopped Watching instead of it just aging silently.
- Opening a show's details lands on and scrolls straight to the episode you actually need to watch next, rather than the top of Season 1.
- Marking a later episode watched while earlier ones in the same show are still unwatched now asks if you want to catch those up too, instead of silently leaving a gap in your watch history. Finishing a season, or catching a whole show up to date, now shows a small celebration banner too.
- Finishing a movie that's part of a collection nudges toward the next unwatched one from that same collection already in your library, if there is one.
- Discover → For You, recommendations seeded from your library.
- Deep links for sharing a show, movie, or a specific episode.
- Unique usernames alongside a freely editable display name.

## Release Timing

- TV episodes carry a real, timezone-correct release date. Broadcast and cable shows use a real, network-announced airtime; streaming shows use a consistent midnight-Pacific convention, the same one movies use — calibrated to never claim something's released before it verifiably is, anywhere.
- Release info is shown as both a real date and a plain-language countdown together (e.g. "Aug 14, 2026 · In 3 days"), so it's clear at a glance without doing the "how soon is that?" math yourself. A future episode can't be marked watched, doesn't count toward progress anywhere in the app, and shows that same countdown instead of "Unwatched."
- An Upcoming tab lists every not-yet-released episode and movie in the library, organized the same way as the Library tab (a TV Shows/Movies toggle, search, poster grid), bucketed into Today/Tomorrow/This Week/Later.
- A Coming Soon item sitting in the regular Library grid shows its release date and countdown on hover/long-press, so you're not left guessing without opening it — without adding a badge over every poster in the grid.

## Notifications

- Real push, delivered even when the app is fully closed, via OneSignal — the only notification delivery mechanism in the app, a single on/off toggle, no separate path that only works while the app happens to be open.
- Each account is notified once for release day content and, separately, once for an engagement reminder (a streak nudge or a Continue Watching pick) - two different fixed anchor times, not one, so the two don't compete for attention on the same morning check-in. The exact local time either arrives at still depends on that account's own timezone.
- Notifications fire only on the actual release day, checked against the real release instant for that specific viewer — never at the moment metadata merely mentions something coming, and never for episodes that were already out when a show was added.
- Multiple episodes of the same show releasing on the same day are grouped into one line ("Adults - Season 2 Episodes 3-4") instead of repeating the show's name for each one.
- On a day when nothing in your library is releasing, an optional reminder can nudge you about an at-risk watch streak, or about episodes waiting in Continue Watching after a few days away — each with its own separate condition so neither becomes a daily nag.
- OneSignal push is the only notification mechanism in the app - no separate in-app log or history to check.

## Home & Viewing Analytics

- Total watch time, including rewatch passes.
- Current watch streak, shown as a badge — lit while a streak is active, muted when it isn't. Distinct from the all-time-record streak achievement, which never resets.
- Counts of watched movies, shows, episodes, and rewatches.
- 22 achievements, all unlockable by everyone, spanning watching milestones (movies, shows, episodes), streaks, rewatching, library size, timing, and speed. Each one has its own distinct icon so they're easy to tell apart at a glance, from a "Night Owl" moon badge for watching between midnight and 4 AM to a stopwatch for finishing a show within 48 hours of adding it. The unlocked count in Settings updates live as you watch, with no need to open the Achievements list first to see it refresh. Unlocking one now shows a real notification banner with its icon and title, since it's the one kind of update that has no other visible sign anywhere on screen.

## NovaWrapped

A Spotify-Wrapped-style yearly recap — a full-screen, tap-through slideshow (the same interaction as Instagram/Snapchat stories), tracking January 1 – December 31 in your own timezone, with a grace period after account creation so bulk-adding existing watch history doesn't count as binge-watching. Total watch time, movies, TV episodes and shows, your most-watched show (with its own poster), your busiest month, and rewatches, each its own vividly-colored slide - only the ones with something real to say, ending on a shareable recap card.

## Settings

- Appearance: Light, Dark, or automatic based on your device.
- Streaming region: a full country picker, auto-detected from your device's location on first sign-in (with a browser-locale fallback), always editable manually afterward — drives which "where to watch" information you see.
- Library Display, with independent per-category control.
- Account: sign-out, account deletion with re-authentication, and Privacy Notice & Terms of Service.

## Account & Privacy

- Email/password and Google sign-in, with email verification and password reset.
- A Terms of Service & Privacy Notice consent step when creating an account.
- Account deletion available directly in the app, and fully removes all associated data — your library, watch history, and saved notification state.

## Design

- A consistent "Liquid Glass" visual language across cards, sheets, buttons, and the floating navigation bar — translucent, blurred surfaces with a soft sheen, sharing one shared set of color and glass tokens rather than each surface inventing its own treatment.
- Full-bleed layout on an installed device: the background extends behind the Dynamic Island, notch, status bar, and home indicator on every device, while actual content stays clear of all of them automatically.
- Text selection and iOS's long-press copy callout are disabled app-wide by default, so it reads as an installed app rather than a page of selectable text — real input fields are unaffected.
- Dark mode throughout, applied before first paint so there's no flash between themes on load.
- An error toast — errors only, not general confirmations — floats above the nav bar using the same glass language, auto-dismissing after a few seconds or on tap. A separate banner at the top of the screen announces achievement unlocks, season/show completions, and collection nudges, since none of those have any other visible sign anywhere on screen. Tapping one takes you straight to what it's about — Achievements for an unlock, the actual show or movie for the other two — instead of every notification acting the same regardless of what it said. Both toasts scale their width to match the nav bar on wider screens, so they stay one consistent family of floating controls instead of the nav growing while they stayed fixed.
- A movie or show's hero photo now stays proportioned properly on wide screens instead of getting cropped tighter and tighter the wider the window gets.
- Home's Viewing Analytics tiles lay out as one row of four on wider screens instead of staying a cramped square, and an empty state (like "You're All Caught Up") stays a comfortable size and centered instead of stretching into a very wide, mostly-empty panel.
- The offline banner pushes the page's own content down while visible, rather than floating on top of it.
- A one-time Add to Home Screen prompt, shown once the app is open and only for someone not already using the installed version — permanently suppressed the moment it can tell the app is actually running standalone.
- Optimized for every screen it's actually opened on, not just a typical phone: a widened, tablet-appropriate layout at 768px and up, a further step up for laptop/desktop-width windows and landscape tablets at 1280px+, and two more steps beyond that for real external monitors and 4K/ultrawide displays so the layout keeps making good use of the space instead of stopping short, tightened spacing and a 2-column library grid on the smallest/narrowest phones, shrunk nav bar and modal imagery when a phone is rotated to landscape, and real hover feedback for anyone using a mouse or trackpad. Phones held normally see none of this - it's the same experience they've always had. On any of those wider screens, a movie/show/settings screen's own text and rows stay capped at a comfortable reading width rather than stretching edge to edge with it, and both Continue Watching and Discover's search results/For You list switch from one stretched column to two (then three on the widest monitors), showing more at once instead of just a wider version of the same row.
- Achievements and Library Display are full-screen, matching every other settings screen, rather than a centered popup card.
- Your identity (avatar, display name, username) appears instantly on load from a local cache, rather than a placeholder that corrects itself a moment later once your account data actually arrives.
- Faster initial load - the app's core scripts no longer block the browser from rendering the page while they download.
- Fixed a real bug where tapping a search box and then switching tabs without typing anything could leave a large empty scrollable gap under a page's content, on any device - worse on whichever tab had the least content. Fixed a second, bigger contributor to the same symptom too - a CSS layout default that let a short page's content area silently reserve extra invisible space below itself.
- Wide desktop and monitor screens now use even more of the available width, with the side margins staying small and consistent no matter how large the display is instead of gradually growing on bigger monitors.
- Refreshed blue accent color throughout the app.

## Platform

- Installable as a PWA on iOS and Android, with home-screen shortcuts to Discover, Library, and Upcoming.
- Offline app-shell caching, so a repeat visit still loads something during a brief connection drop.
