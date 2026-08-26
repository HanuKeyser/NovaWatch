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

// Same "every calendar day with a watch or rewatch logged" set the
// client builds (see buildWatchedDatesSet in app.js) - watchedAt/
// lastWatchedAt are already stored as UTC-sliced date strings on both
// sides, so this needs no per-account timezone adjustment, unlike the
// release-date checks above.
function buildWatchedDatesSet(libraryItems) {
    const watchedDates = new Set();
    libraryItems.forEach(item => {
        if (item.type === 'movie') {
            if (item.watched && item.lastWatchedAt) watchedDates.add(item.lastWatchedAt.slice(0, 10));
        } else if (Array.isArray(item.episodes)) {
            item.episodes.forEach(ep => {
                if (ep.watched && ep.watchedAt) watchedDates.add(ep.watchedAt.slice(0, 10));
            });
        }
    });
    return watchedDates;
}

// Exact mirror of getCurrentWatchStreak() in app.js.
function getCurrentWatchStreak(watchedDates) {
    if (!watchedDates || watchedDates.size === 0) return 0;
    const sortedDates = [...watchedDates].sort();
    const mostRecent = sortedDates[sortedDates.length - 1];
    const todayStr = utcDateString(new Date());
    const dayGap = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
    if (dayGap(mostRecent, todayStr) > 1) return 0;
    let streak = 1;
    for (let i = sortedDates.length - 1; i > 0; i--) {
        if (dayGap(sortedDates[i - 1], sortedDates[i]) === 1) streak++;
        else break;
    }
    return streak;
}

// Simplified mirror of getContinueWatchingItems() in app.js - just
// whether anything qualifies, since the reminder body doesn't need the
// actual list.
function hasContinueWatchingBacklog(libraryItems) {
    return libraryItems.some(item => {
        if (item.isStopped) return false;
        if (item.type === 'movie') return !item.watched && item.releaseDate && hasReleased(item.releaseDate);
        if (!Array.isArray(item.episodes)) return false;
        return item.episodes.some(ep => !ep.watched && ep.releaseDate && hasReleased(ep.releaseDate));
    });
}

// Mirrors checkEngagementReminders() in app.js - only ever called for an
// account with nothing releasing today (see the call site in run()
// above). Two independent checks, each with its own dedup/cooldown so
// neither turns into a daily nag - see that function's own comment for
// why each condition is what it is.
async function checkEngagementRemindersForUser(uid, libraryItems, todayStr) {
    const watchedDates = buildWatchedDatesSet(libraryItems);
    const mostRecentWatch = watchedDates.size > 0 ? [...watchedDates].sort().pop() : null;
    const dayGap = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

    if (mostRecentWatch && mostRecentWatch !== todayStr) {
        const streak = getCurrentWatchStreak(watchedDates);
        if (streak > 0) {
            const notifiedRef = db.collection('users').doc(uid).collection('_internal').doc('notifiedReleases');
            const notifiedDoc = await notifiedRef.get();
            const notifiedData = notifiedDoc.exists ? notifiedDoc.data() : {};
            const alreadySentToday = notifiedData.day === todayStr && (notifiedData.ids || []).includes('streak-reminder');

            if (!alreadySentToday) {
                try {
                    await sendOneSignalPush(uid, 'Keep Your Streak Going!', `You're on a ${streak}-day watch streak - watch something today to keep it going.`);
                    const ids = (notifiedData.day === todayStr ? notifiedData.ids || [] : []).concat('streak-reminder');
                    await notifiedRef.set({ day: todayStr, ids });
                } catch (err) {
                    console.error(`Failed to send streak reminder to ${uid}:`, err.message);
                }
            }
        }
    }

    if (hasContinueWatchingBacklog(libraryItems)) {
        const daysSinceLastWatch = mostRecentWatch ? dayGap(mostRecentWatch, todayStr) : Infinity;

        if (daysSinceLastWatch >= 3) {
            const reminderRef = db.collection('users').doc(uid).collection('_internal').doc('lastContinueWatchingReminder');
            const reminderDoc = await reminderRef.get();
            const lastReminderDay = reminderDoc.exists ? reminderDoc.data().day : null;
            const daysSinceLastReminder = lastReminderDay ? dayGap(lastReminderDay, todayStr) : Infinity;

            if (daysSinceLastReminder >= 7) {
                try {
                    await sendOneSignalPush(uid, 'Pick Up Where You Left Off', "You've got episodes waiting in Continue Watching.");
                    await reminderRef.set({ day: todayStr });
                } catch (err) {
                    console.error(`Failed to send Continue Watching reminder to ${uid}:`, err.message);
                }
            }
        }
    }
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

        const librarySnapshot = await db.collection('users').doc(uid).collection('library').get();
        const libraryItems = librarySnapshot.docs.map(d => d.data());

        const releases = getTodaysReleasesForUser(libraryItems, timeZone);

        // Same rule as the client (see checkTodaysReleases/
        // checkEngagementReminders in app.js): engagement reminders only
        // get a look-in on a day with nothing actually releasing for
        // this account at all - never alongside a real release.
        if (releases.length === 0) {
            await checkEngagementRemindersForUser(uid, libraryItems, todayStr);
            continue;
        }

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

    console.log(`Done. Sent ${sent} notification(s), skipped ${skipped} (already sent today, or nothing to send).`);
}

run().catch(err => {
    console.error('Release notification job failed:', err);
    process.exit(1);
});
