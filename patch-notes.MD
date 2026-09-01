# NovaWatch — v1.0.0

What's included, top to bottom.

## Tracking & Library

- Search and add TV shows and movies, mark them watched with a single tap.
- Rewatch tracking, per-episode for TV and per-title for movies, via a tap-to-manage popup rather than a one-way counter. A season can be bulk-rewatched once every released episode in it has been watched at least once.
- Library organized into In Progress, Up to Date, Finished, Unwatched, Coming Soon, and Stopped Watching, each sorted the same way: latest to oldest by release date, one consistent rule across every category rather than each picking its own dimension.
- Favorite any show or movie from its details - one tap in a labeled action row, no separate menu to dig through.
- Custom lists mixing shows and movies freely, plus an automatic Favourites list that's always there without needing to be created. Give any list, including Favourites, its own backdrop image - choose from the real TMDB gallery for anything in the list, not just its saved poster, or long-press a list card to jump straight into that picker - or leave it on auto, which always reflects whatever was added or favorited most recently. Reorder your lists (Favourites included) with simple move buttons. Share a list with a link, the same way sharing a show or episode already works. Every change - adding, removing, renaming, reordering, deleting, a new backdrop - shows up immediately, not after a delay. The Library tab itself now leads with a scrollable row of your lists, then a self-updating 9-title preview each for TV and Movies based on what you're actually watching, with a "View All" into the full library view for everything else.
- Posters that no longer flicker on a library update, tab switch, or modal open.
- Finished, Unwatched, and Stopped Watching can each be shown or hidden independently in Settings.
- Continue Watching on Home surfaces the next unwatched episode for every in-progress show, plus any unwatched movies, with swipe actions to mark watched or stop watching.
- Opening a show's details lands on and scrolls straight to the episode you actually need to watch next, rather than the top of Season 1.
- Search → For You, recommendations seeded from your library.
- Deep links for sharing a show, movie, or a specific episode.
- Unique usernames alongside a freely editable display name.

## Release Timing

- TV episodes carry a real, timezone-correct release date. Broadcast and cable shows use a real, network-announced airtime; streaming shows use a consistent midnight-Pacific convention, the same one movies use — calibrated to never claim something's released before it verifiably is, anywhere.
- A future episode can't be marked watched, doesn't count toward progress anywhere in the app, and shows a countdown instead of "Unwatched."
- An Upcoming tab lists every not-yet-released episode and movie in the library, organized the same way as the Library tab (a TV Shows/Movies toggle, search, poster grid), bucketed into Today/Tomorrow/This Week/Later.

## Notifications

- Real push, delivered even when the app is fully closed, via OneSignal — the only notification delivery mechanism in the app, a single on/off toggle, no separate path that only works while the app happens to be open.
- Each account is notified once for release day content and, separately, once for an engagement reminder (a streak nudge or a Continue Watching pick) - two different fixed anchor times, not one, so the two don't compete for attention on the same morning check-in. The exact local time either arrives at still depends on that account's own timezone.
- Notifications fire only on the actual release day, checked against the real release instant for that specific viewer — never at the moment metadata merely mentions something coming, and never for episodes that were already out when a show was added.
- On a day when nothing in your library is releasing, an optional reminder can nudge you about an at-risk watch streak, or about episodes waiting in Continue Watching after a few days away — each with its own separate condition so neither becomes a daily nag.
- OneSignal push is the only notification mechanism in the app - no separate in-app log or history to check.

## Home & Viewing Analytics

- Total watch time, including rewatch passes.
- Current watch streak, shown as a badge — lit while a streak is active, muted when it isn't. Distinct from the all-time-record streak achievement, which never resets.
- Counts of watched movies, shows, episodes, and rewatches.
- Achievements for library and viewing milestones — 13 in total, including a handful of unique ones beyond just bigger-number versions of the basics: watching something between midnight and 5am, something released 25+ years ago, within 3 days of its release, 5+ episodes of one show in a day, a movie and an episode on the same day, a 100+ title library, 3+ custom lists, 10+ favorites, and sharing anything at all.

## NovaWrapped

A Spotify-Wrapped-style yearly recap — a full-screen, tap-through slideshow (the same interaction as Instagram/Snapchat stories), tracking January 1 – December 31 in your own timezone, with a grace period after account creation so bulk-adding existing watch history doesn't count as binge-watching. Total watch time, movies, TV episodes and shows, your most-watched show (with its own poster), your busiest month, and rewatches, each its own high-contrast grayscale slide - only the ones with something real to say, ending on a shareable recap card. Visible arrows now sit alongside the tap zones for anyone who doesn't already know the tap-to-advance convention, and the progress bar across the top is tappable to jump straight to any slide instead of only stepping one at a time. The landing screen's title picked up the same gradient the "View My Wrapped" button already had, tying the two together into one considered identity.

## Settings

- Appearance: Light, Dark, or automatic based on your device.
- Streaming region: a full country picker, auto-detected from your device's location on first sign-in (with a browser-locale fallback), always editable manually afterward — drives which "where to watch" information you see.
- Library Display, with independent per-category control.
- Account: sign-out, account deletion with re-authentication, and Privacy Notice & Terms of Service.

## Account & Privacy

- Email/password and Google sign-in, with email verification and password reset.
- A Terms of Service & Privacy Notice consent step when creating an account.
- Account deletion available directly in the app.

## Design

- A consistent "Liquid Glass" visual language across cards, sheets, buttons, and the floating navigation bar — translucent, blurred surfaces with a soft sheen, sharing one shared set of color and glass tokens rather than each surface inventing its own treatment. Several large surfaces (confirm dialogs, the sign-in card, Home's analytics and hero cards, every modal sheet) previously used their own slightly different hardcoded blur values instead of that shared tier - all unified now.
- Fully monochrome — black, white, and neutral gray only, everywhere in the app's own UI (buttons, gradients, NovaWrapped's slides, the page background). Danger and success are told apart by weight now instead of hue (danger darkest, success lightest), backed up by the icon/label the way it already was. Real photos (posters, backdrops, avatars) and the "Sign in with Google" button's official logo are the only exceptions, for reasons covered in the README. Also swept for shades that should genuinely match but had drifted slightly apart - the two "primary action" button glow shadows had ended up at two barely-different grays, since they'd originally come from two different blues, and are now one shared value.
- Real support for mouse and larger screens, not just touch - every clickable element gets a pointer cursor now, not just the handful of classes that had it before, and the main card types get a genuine hover lift, scoped so touch devices never trigger it. The two TV Shows/Movies toggles (Search, Upcoming) are draggable now too, the same gesture the bottom nav already supported. A real gap between phone and tablet widths (roughly 600-768px) that used to leave dead space down both sides is closed too.
- Every modal in the app is full-screen, for one consistent feel throughout - no more mix of full-screen and smaller centered-card styles.
- Text selection and iOS's long-press copy callout are disabled app-wide by default, so it reads as an installed app rather than a page of selectable text — real input fields are unaffected.
- Dark mode throughout, applied before first paint so there's no flash between themes on load - genuinely dark now too, not just dark navy.
- An error toast — errors only, not general confirmations — floats above the nav bar using the same glass language, auto-dismissing after a few seconds or on tap.
- The offline banner pushes the page's own content down while visible, rather than floating on top of it.
- A one-time Add to Home Screen prompt, shown once the app is open and only for someone not already using the installed version — permanently suppressed the moment it can tell the app is actually running standalone.
- Widened, tablet-appropriate layout at 768px and up, with no change at all to the phone experience below that width.
- Achievements and Library Display are full-screen, matching every other settings screen, rather than a centered popup card.
- Your identity (avatar, display name, username) appears instantly on load from a local cache, rather than a placeholder that corrects itself a moment later once your account data actually arrives.
- The sign-in screen has more visual presence now - a much larger logo and bigger type, reading as a considered full page rather than a compact form.
- Faster initial load - the app's core scripts no longer block the browser from rendering the page while they download.

## Platform

- Installable as a PWA on iOS and Android, with home-screen shortcuts to Search, Library, and Upcoming.
- Offline app-shell caching, so a repeat visit still loads something during a brief connection drop.
