// send-release-notifications.js
//
// Scheduled server-side job - NOT part of the client app, and not
// loaded by index.html. A browser tab can't run on a schedule once
// it's closed, so the "what should be notified about today, and to
// whom" decision has to live somewhere that isn't the browser. This is
// that piece. The client (see the ONESIGNAL NOTIFICATIONS block in
// scripts/app.js) only handles subscribing a device to push and tying
// it to an account - this script is what actually decides to send
// something and calls OneSignal's REST API to do it.
//
// It mirrors getReleasesForDay()/checkTodaysReleases() in scripts/app.js
// as closely as possible - same three notification categories, same
// "New Release" title and body wording, same once-per-day-per-item
// dedup idea - just running server-side against every account instead
// of client-side against just the signed-in one.
//
// ── SETUP (once, before this can run) ──────────────────────────────
//   1. npm install firebase-admin
//   2. Firebase Console -> Project Settings -> Service Accounts ->
//      Generate new private key. This downloads a JSON file - never
//      commit it to the repo. Whatever host runs this script needs its
//      contents available as the FIREBASE_SERVICE_ACCOUNT_JSON
//      environment variable (the raw JSON, as a string).
//   3. OneSignal dashboard -> Settings -> Keys & IDs, once the account
//      and app exist:
//        ONESIGNAL_APP_ID        - same value you put in
//                                   ONESIGNAL_APP_ID in scripts/app.js
//        ONESIGNAL_REST_API_KEY  - a DIFFERENT, secret key - never put
//                                   this one in client-side code, only
//                                   here on the server. Whoever has it
//                                   can send push to your whole audience.
//   4. Run this on a daily schedule, however you're hosting it - it
//      loops every account's OWN timezone internally, so the exact
//      wall-clock time you schedule it at isn't critical, as long as it
//      runs at least once every 24 hours. A Cloud Function on a Cloud
//      Scheduler trigger works if you're already on Firebase's Blaze
//      plan; a free scheduled GitHub Actions workflow (see the example
//      alongside this file) works without needing that upgrade at all,
//      since this script doesn't otherwise need to run inside Firebase.
// ─────────────────────────────────────────────────────────────────────

const admin = require('firebase-admin');

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// Same UTC-calendar-day slicing the client uses for its own
// once-per-day dedup record (see TODAYS_RELEASE_NOTIFIED_KEY in
// app.js) - used here as the key for a small per-user Firestore doc
// instead of localStorage, since there's nothing else to persist it in
// server-side.
function utcDateString(date) {
    return date.toISOString().slice(0, 10);
}

// Same local-calendar-day comparison as daysUntil() in app.js, just for
// an arbitrary IANA timezone (each account's own stored timeZone - see
// saveUserProfile in app.js) instead of always the browser's. This is
// what makes "today" mean the right thing per account rather than
// whatever timezone this script happens to run in.
function isReleasedToday(releaseDateIso, timeZone) {
    if (!releaseDateIso) return false;
    try {
        const releaseLocalDateStr = new Date(releaseDateIso).toLocaleDateString('en-CA', { timeZone });
        const todayLocalDateStr = new Date().toLocaleDateString('en-CA', { timeZone });
        return releaseLocalDateStr === todayLocalDateStr;
    } catch (e) {
        // An unrecognized timeZone string (shouldn't happen - it's
        // always Intl's own resolvedOptions().timeZone from the client)
        // falls back to plain UTC comparison rather than throwing and
        // skipping that account's notifications entirely for the day.
        const releaseLocalDateStr = new Date(releaseDateIso).toISOString().slice(0, 10);
        const todayLocalDateStr = new Date().toISOString().slice(0, 10);
        return releaseLocalDateStr === todayLocalDateStr;
    }
}

// Same exact-instant gate as isReleased() in app.js - a release whose
// local calendar day has arrived but whose real release instant hasn't
// actually passed yet (e.g. a midnight-Pacific streaming release,
// checked from a timezone already past that clock time) shouldn't
// notify a few hours early.
function hasReleased(releaseDateIso) {
    if (!releaseDateIso) return true;
    return new Date(releaseDateIso).getTime() <= Date.now();
}

// Mirrors getReleasesForDay(0) in app.js - movies and TV episodes
// releasing "today" in THIS account's own timezone, split into the
// same three categories the Notification Types preferences use.
function getTodaysReleasesForUser(libraryItems, timeZone) {
    const results = [];

    libraryItems.forEach(item => {
        if (item.type === 'movie') {
            if (item.releaseDate && isReleasedToday(item.releaseDate, timeZone) && hasReleased(item.releaseDate)) {
                results.push({
                    category: 'movieReleases',
                    releaseId: `movie:${item.id}`,
                    title: item.title,
                    subtitle: 'Movie Release'
                });
            }
        } else if (Array.isArray(item.episodes)) {
            item.episodes.forEach(ep => {
                if (!ep.releaseDate || !isReleasedToday(ep.releaseDate, timeZone) || !hasReleased(ep.releaseDate)) return;
                const isPremiere = ep.season === 1 && ep.number === 1;
                results.push({
                    category: isPremiere ? 'showPremieres' : 'newEpisodes',
                    releaseId: `tv:${item.id}:${ep.id}`,
                    title: item.title,
                    subtitle: `Season ${ep.season} Episode ${ep.number} release`
                });
            });
        }
    });

    return results;
}

// Targets a specific account via OneSignal's "external_id" alias - see
// oneSignalLogin() in app.js, which is what ties a subscribed device to
// this same id (the Firebase uid) on the client side.
async function sendOneSignalPush(externalId, title, body) {
    const res = await fetch('https://api.onesignal.com/notifications', {
        method: 'POST',
        headers: {
            'Authorization': `Key ${ONESIGNAL_REST_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            app_id: ONESIGNAL_APP_ID,
            target_channel: 'push',
            include_aliases: { external_id: [externalId] },
            headings: { en: title },
            contents: { en: body }
        })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OneSignal send failed (${res.status}): ${text}`);
    }
    return res.json();
}

async function run() {
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
        throw new Error('ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY must both be set as environment variables.');
    }

    const usersSnapshot = await db.collection('users').get();
    const todayStr = utcDateString(new Date());
    let sent = 0;
    let skipped = 0;

    for (const userDoc of usersSnapshot.docs) {
        const uid = userDoc.id;
        const userData = userDoc.data() || {};
        // Accounts that existed before this field was added default to
        // UTC rather than being skipped entirely - the date could be off
        // by up to a day for them until they next open the app (which
        // refreshes it), which is still far better than never notifying
        // that account at all.
        const timeZone = userData.timeZone || 'UTC';
        const prefs = userData.notificationPrefs || { newEpisodes: true, showPremieres: true, movieReleases: true };

        const librarySnapshot = await db.collection('users').doc(uid).collection('library').get();
        const libraryItems = librarySnapshot.docs.map(d => d.data());

        const releases = getTodaysReleasesForUser(libraryItems, timeZone);
        if (releases.length === 0) continue;

        // Same once-per-day-per-item dedup idea as the client's
        // TODAYS_RELEASE_NOTIFIED_KEY, just kept in Firestore here
        // instead of localStorage (nothing else to persist it in
        // server-side) - a small doc per account records which release
        // IDs have already been sent today.
        const notifiedRef = db.collection('users').doc(uid).collection('_internal').doc('notifiedReleases');
        const notifiedDoc = await notifiedRef.get();
        const notifiedData = notifiedDoc.exists ? notifiedDoc.data() : {};
        const alreadyNotifiedToday = (notifiedData.day === todayStr) ? (notifiedData.ids || []) : [];
        const newlyNotified = [...alreadyNotifiedToday];

        for (const release of releases) {
            if (!prefs[release.category]) { skipped++; continue; }
            if (alreadyNotifiedToday.includes(release.releaseId)) { skipped++; continue; }

            try {
                await sendOneSignalPush(uid, 'New Release', `${release.title} - ${release.subtitle}`);
                newlyNotified.push(release.releaseId);
                sent++;
            } catch (err) {
                console.error(`Failed to notify ${uid} about ${release.releaseId}:`, err.message);
            }
        }

        if (newlyNotified.length !== alreadyNotifiedToday.length) {
            await notifiedRef.set({ day: todayStr, ids: newlyNotified });
        }
    }

    console.log(`Done. Sent ${sent} notification(s), skipped ${skipped} (already sent today or turned off).`);
}

run().catch(err => {
    console.error('Release notification job failed:', err);
    process.exit(1);
});
