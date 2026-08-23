# NovaWatch — Patch Notes

## v1.0.0 (pre-launch)

Everything below is still part of getting to the v1.0.0 launch — nothing here has shipped as a separate release yet.

### New: Upcoming tab
- A 4th bottom-nav tab. Same structure as Library — a TV Shows/Movies segmented toggle, the same search box, the same poster-grid cards (including long-press to change poster) — just bucketed by Today/Tomorrow/This Week/Later instead of watch status.
- Shows **every** not-yet-released episode per show, not just the next one.
- Read-only — nothing to mark watched on something that hasn't released yet.

### New: real TV episode release dates, timezone-correct
- TV episodes carry a real release instant again (this had been fully removed in an earlier version after repeated accuracy problems).
- **Broadcast/cable shows** get a real, network-announced airtime from TVmaze, converted DST-aware to the viewer's own timezone.
- **Streaming shows** (or anything TVmaze doesn't have) use the same midnight-Pacific convention movies already used — deliberately the *latest* common release time, so a date can under-promise (show "not released yet" a few hours early on some platforms) but never over-promise (claim something's out before it verifiably is, anywhere).
- Verified with direct timezone tests: a 6PM Pacific Wednesday release correctly lands as Thursday for a South African viewer; a DST-transition-week date correctly used the real seasonal offset instead of a hardcoded fallback.
- A future episode can no longer be marked watched, doesn't count toward progress anywhere (Library, Continue Watching, achievements), and shows a countdown instead of "Unwatched" in the episode list and details modal.

### New: notification overhaul
- Notifications now only fire on the actual release day, checked against the episode/movie's real release instant — never at the moment TMDB/TVmaze data merely mentions something coming.
- Removed every "you'll be notified..." confirmation notification (enabling notifications, adding a movie, adding a show) — pure noise, now just a toast/button-state change instead.
- New **Notification Types** screen (Settings) — New Episodes, Show Premieres, and Movie Releases can each be turned off independently.
- Every notification now shares one title, "New Release" — the body carries the specifics ("Show Name - Season X Episode X release").
- Fixed a backgrounded-tab reliability gap: returning to a backgrounded tab now immediately re-checks for releases instead of waiting on a timer that mobile browsers throttle heavily.

### New: Library Display (Settings)
- Independently show/hide the Finished, Unwatched, and Stopped Watching Library categories. On (green) by default.

### New: Viewing Analytics additions (Home)
- **Current watch streak** — a small badge under Total Watch Time, lit while a streak (consecutive days with a watch/rewatch logged) is active, muted when it isn't. Distinct from the all-time-record streak achievement, which never resets.
- **Rewatches** — total rewatch count, now shown as its own tile (was already tracked internally, never surfaced).

### New: smarter region auto-detection
- Region auto-detect now tries the browser's real Geolocation API first (reverse-geocoded to a country), falling back to the old locale-string guess for every failure case. The manual region picker is unchanged.

### Fixed
- Movie details modal and episode details modal were calling `formatDateWithReleaseTime()`/`formatDate()` — neither existed, so opening either would throw. Both now exist.
- Notification Types and Library Display modals only rendered *after* closing Settings — a z-index stacking bug (they were missing from the override list that lets modals-opened-from-Settings render above Settings itself).
- Library's "No TV/Movies Found" empty state incorrectly claimed the library was empty when a search query simply matched nothing — now shows the correct "no matches" message instead.
- The on/off toggle buttons (Notification Types, Library Display, the notification-permission button) were missing the app's signature glass-sheen layer and glow shadow that every other colored button has — now share one proper `.pill-on`/`.pill-off`/`.pill-neutral` treatment.
- Removed a duplicate function definition introduced mid-session (`getLatestAiredEpisodeDate` was accidentally defined twice).

### Changed
- TV Library sort: now based on each show's real most-recently-aired episode (previously a "most recently watched" substitute, from when episodes didn't carry real dates), newest first.
- Upcoming's card titles clamp to 1 line instead of 2.
- Opening a TV show's details lands on and auto-scrolls to the next episode you need to watch (already existed, verified working — not new this release).
- Settings reorganized into three sections: Preferences, Notifications, Library.
- Text selection and iOS's long-press copy callout are now disabled app-wide by default (real `<input>`/`<textarea>` fields are unaffected).

### Docs
- Removed the "Not yet built" roadmap section from the README — kept it to what's actually in the code.
- Fixed a stale line count and a stale button label ("Mark All Released Episodes Watched" → "Mark All Episodes Watched") in the README.
- Privacy Notice & Terms updated to disclose TVmaze, BigDataCloud (region auto-detection), and the location permission prompt.

### New: Terms & Privacy consent at signup
- A required "I agree to the Terms of Service & Privacy Notice" checkbox, linking to the real Privacy/Terms page, shown when creating an account (email/password Join, and Google sign-in while in Join mode). Not shown on a routine returning-user sign-in.

### Fixed (this round)
- Audited every SVG icon in the app for sizing/color issues - none found. The handful of icons that don't use the shared `.icon` class (the Google "G" logo, toast icons, swipe-action icons) all have their own correct, deliberate sizing already; nothing was rendering broken or oversized.

### New: real push notifications (OneSignal) — now live client-side
- Client-side OneSignal Web SDK integration - subscribes a device to push and ties it to the signed-in account (`oneSignalLogin`/`oneSignalLogout`), keeps the "Stay in the loop" button in sync with real subscription state.
- **`ONESIGNAL_APP_ID` is now the real App ID** - the client-side integration is live, not just scaffolded. This also means `app.js` now registers `OneSignalSDKWorker.js` (via OneSignal's own SDK) instead of registering `service-worker.js` directly - see `PUSH_NOTIFICATIONS_SETUP.md` for why that makes deploying `OneSignalSDKWorker.js` to the site root load-bearing now, not optional.
- `OneSignalSDKWorker.js` - combines OneSignal's service worker with this app's existing one, so offline caching isn't lost.
- `send-release-notifications.js` - a standalone server-side script (not loaded by the app) that decides what to send and calls OneSignal's REST API. Mirrors `getReleasesForDay()`'s categories and wording, computed per account in that account's own real timezone (not the server's). Still needs its own credentials (REST API key, Firebase service account) before it can run - see the setup doc.
- Notification preferences and each account's IANA timezone now sync to Firestore (previously localStorage-only) - needed so the server-side script can read them.
- `.github/workflows/release-notifications.yml` - one free way to run the script daily; optional, not the only option.
- Confirmed directly from OneSignal's own docs: Firebase/FCM credentials are only required for native Android apps distributed via Google Play - not needed for NovaWatch (a PWA). See the setup doc if your OneSignal dashboard is asking for it anyway.
- See `PUSH_NOTIFICATIONS_SETUP.md` for what's left before this is fully live end-to-end.
