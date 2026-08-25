# Real push notifications (OneSignal) — setup checklist

## Status: App ID connected — client-side is now live

`ONESIGNAL_APP_ID` in `scripts/app.js` is set to your real App ID
(`754197a4-aa86-4c1a-bde1-f287f98547a5`). That flips a real switch:
`isOneSignalConfigured()` now returns `true`, which means -

- The client actually loads and initializes the OneSignal SDK on every
  visit now, not just once configured "later."
- **`app.js` has stopped registering `service-worker.js` directly** -
  OneSignal's SDK registers its own worker (`OneSignalSDKWorker.js`)
  instead, since two separate service worker registrations at the same
  scope fight each other for control (OneSignal's own docs are explicit
  about this: whichever registers can simply replace the other at that
  scope). This is correct, but it makes one thing load-bearing that
  wasn't before:

> **`OneSignalSDKWorker.js` must actually be deployed at your site
> root** (`https://www.novawatch.site/OneSignalSDKWorker.js`) before
> you push this live. It already exists in this file set - just make
> sure whatever deploy step you use actually picks it up. Some
> static-site deploy tools only upload files that are directly
> referenced from `index.html`, and this one isn't (OneSignal's SDK
> requests it directly by convention, not via a `<script>` tag). If
> it's missing at that URL, this build will lose **both** push AND the
> offline app-shell caching it used to have - not just fail to gain
> push. Worth checking, not something to assume.

## On the Firebase Cloud Messaging prompt you saw

Confirmed directly from OneSignal's own documentation (Android Firebase
credentials page): **Firebase/FCM credentials are only required for a
native Android app distributed through Google Play.** Their own words:
*"Android devices can subscribe to your website or PWA without an FCM
Service Account. See Web push setup."*

NovaWatch is a PWA, not a native Android app - it doesn't need this at
all. If your OneSignal dashboard is asking for it, you likely have the
"Google Android" native platform enabled/selected somewhere in that
app's setup alongside (or instead of) "Web" - check **Settings → Push &
In-App**, confirm **Web** is the active platform, and that you're not
also mid-way through a separate native Android setup flow for the same
app. Nothing in this codebase needs FCM.

## What's already built

- **Client-side** (`index.html`, `scripts/app.js`): loads the OneSignal
  Web SDK, initializes it with your real App ID, keeps the "Stay in the
  loop" button in sync with real push subscription state, and ties each
  signed-in device to that account (`oneSignalLogin`/`oneSignalLogout`)
  so a server can target a specific person.
- **`OneSignalSDKWorker.js`**: combines OneSignal's own service worker
  code with NovaWatch's existing one (offline caching) - see the
  load-bearing note above.
- **`send-release-notifications.js`**: the actual "what to send, and to
  whom" logic — a standalone Node script, not loaded by the app itself.
  Reads every account's library and timezone from Firestore, works out
  what's releasing today *in that account's own timezone*, and calls
  OneSignal's API. This is the piece that needed to exist somewhere
  outside the browser, since a closed tab can't run on a schedule. Also
  handles the two engagement reminders (an at-risk streak, a Continue
  Watching nudge after inactivity) on a day with nothing releasing.
- **`.github/workflows/release-notifications.yml`**: one free way to run
  that script hourly, via GitHub Actions. The script itself only
  actually processes each account during the one run each day that
  lands on *its own* local 8am hour (08:00 UTC is the reference anchor,
  adjusted per timezone) — every other run is nearly free for that
  account. Optional — delete it if you'd rather run the script
  elsewhere.
- **Each account's IANA timezone is saved** (`state.timeZone`),
  refreshed every time the profile saves — this is what lets the server
  script determine "today," and the account's own local 8am, correctly
  per person instead of guessing.
- There's a single on/off toggle for notifications, no per-category
  selection — the server script always sends every category once an
  account is subscribed.

## What's still left to do

1. ~~Create the OneSignal account and a Web app inside it.~~ Done.
2. ~~Client App ID wired into `scripts/app.js`.~~ Done.
3. **In the OneSignal dashboard** (Settings → Push & In-App → Web),
   confirm the Site URL is set to exactly `https://www.novawatch.site`
   (no trailing slash, no `www.` mismatch) - this has to match your
   real origin exactly or subscriptions won't register correctly.
4. **Deploy `OneSignalSDKWorker.js` to the site root** - see the
   load-bearing note above. This is the one step most likely to get
   missed.
5. **Server key**: copy the REST API Key (dashboard → Settings → Keys &
   IDs — a *different*, secret value from the App ID, never put this
   one in client-side code) somewhere you'll set it as an environment
   variable, not committed to the repo.
6. **Firebase service account**: Firebase Console → Project Settings →
   Service Accounts → Generate new private key. Also never committed —
   its contents become the `FIREBASE_SERVICE_ACCOUNT_JSON` environment
   variable.
7. **Decide where `send-release-notifications.js` runs on a schedule.**
   The included GitHub Actions workflow is the free option if this repo
   lives on GitHub — add the three secrets it asks for and it just
   works. Otherwise, any host that can run Node on a schedule (a Cloud
   Function + Cloud Scheduler if you're already on Firebase's Blaze
   plan, a cron job on a server you already have, etc.) works the same
   way — the script itself doesn't care where it runs.
8. **Test with one real account** before trusting it broadly: sign in,
   tap "Enable" under notifications, confirm the subscription shows up
   in the OneSignal dashboard (Audience → Subscriptions), then run
   `node send-release-notifications.js` manually once (with the env
   vars set) against a library that has something releasing today.

## One thing worth knowing going in

- **iOS only supports web push for a PWA added to the Home Screen**
  (iOS 16.4+, Safari's "Add to Home Screen" specifically) — a tab open
  in Safari can't receive push at all there. Android and desktop don't
  have this restriction.
