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
// It decides what's releasing today and calls OneSignal's REST API to
// notify the right accounts about it - the "what should be notified
// about today, and to whom" logic that has to live somewhere outside
// the browser, since a closed tab can't run on a schedule. The client
// (see the ONESIGNAL NOTIFICATIONS block in scripts/app.js) only ever
// handles subscribing a device to push and tying it to an account -
// there's no client-side equivalent of the logic in this file; the
// app used to also check for releases locally while a tab was open,
// but that path was removed in favor of this being the single source
// of truth for both scheduling and delivery.
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

// .trim() defensively - a stray trailing newline or space is a common,
// easy-to-miss mistake when pasting a secret value into GitHub's own
// secret input field, and would otherwise silently ride along on every
// single request this script ever makes.
const ONESIGNAL_APP_ID = (process.env.ONESIGNAL_APP_ID || '').trim();
const ONESIGNAL_REST_API_KEY = (process.env.ONESIGNAL_REST_API_KEY || '').trim();

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// UTC-calendar-day slicing, used as the key for the small per-user
// Firestore "already notified today" doc (see the notifiedRef usage in
// run() and checkEngagementRemindersForUser below) - there's nothing
// else to persist that dedup state in server-side, since there's no
// browser/localStorage on this side.
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

// Movies and TV episodes releasing "today" in THIS account's own
// timezone, split into the same three categories the push notification
// always covers (there's no per-category selection anymore - a single
// account-level on/off is all that exists now, so every category goes
// out together whenever an account is subscribed).
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

// TMDB titles/descriptions often use "smart" typographic punctuation
// (curly quotes, en/em dashes, an ellipsis character) rather than plain
// ASCII - exactly the class of character that can crash a Node fetch
// call somewhere in the request/response header-handling machinery
// (a well-documented Node/undici gotcha: "Cannot convert argument to a
// ByteString because the character at index X has a value of Y which
// is greater than 255" - this is what silently failed today's send).
// Normalizing to plain ASCII equivalents before it ever reaches
// sendOneSignalPush removes the trigger entirely, rather than hoping it
// never comes up again.
function sanitizeForPush(str) {
    return String(str)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\u2026/g, '...')
        // Anything else outside the safe Latin-1 range is dropped
        // rather than risking this same class of failure again for a
        // different character next time (a title in a non-Latin
        // script, an emoji) - a notification missing an unusual
        // character is far better than one that silently never sends
        // at all, which is what happened today.
        .replace(/[^\x00-\xFF]/g, '');
}

// Targets a specific account via OneSignal's "external_id" alias - see
// oneSignalLogin() in app.js, which is what ties a subscribed device to
// this same id (the Firebase uid) on the client side.
async function sendOneSignalPush(externalId, title, body) {
    const sanitizedTitle = sanitizeForPush(title);
    const sanitizedBody = sanitizeForPush(body);

    try {
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
                headings: { en: sanitizedTitle },
                contents: { en: sanitizedBody }
            })
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`OneSignal send failed (${res.status}): ${text}`);
        }
        return res.json();
    } catch (err) {
        // This exact error ("Cannot convert argument to a ByteString...")
        // was previously assumed to come from an unsanitized title/body -
        // it wasn't; it recurred at the identical character index across
        // several completely different titles even after sanitization
        // was in place, which a varying title's own content couldn't
        // explain (different titles, different lengths, would fail at
        // different positions if the titles themselves were the cause).
        // Logging exactly what was actually sent, rather than guessing
        // again, is what actually pins this down on the next failure.
        if (err.message && err.message.includes('ByteString')) {
            console.error('ByteString error diagnostic - sanitized title length:', sanitizedTitle.length, 'sanitized body length:', sanitizedBody.length, 'title:', JSON.stringify(sanitizedTitle), 'body:', JSON.stringify(sanitizedBody), 'APP_ID length:', ONESIGNAL_APP_ID.length, 'REST_API_KEY length:', ONESIGNAL_REST_API_KEY.length, 'full stack:', err.stack);
        }
        throw err;
    }
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

// Only ever called for an account with nothing releasing today (see the
// call site in run() below). Two independent checks, each with its own
// dedup/cooldown so neither turns into a daily nag: a streak reminder
// (once, only when a real streak is genuinely at risk of breaking) and
// a Continue Watching nudge (only after 3+ days of no activity, with
// its own separate 7-day cooldown). "Today" here is this account's own
// local calendar day (timeZone), not the server's UTC day - watch
// activity itself is recorded in UTC-sliced dates on both the client
// and server (see buildWatchedDatesSet), so a streak's day-to-day
// continuity is still judged consistently either way, but WHICH day
// currently counts as "today" for deciding whether to nag needs to
// match the account's own clock, the same care already given to
// release timing - otherwise this reminder can fire (or stay silent)
// at a time that makes no sense relative to where that person actually
// is, especially far from UTC.
async function checkEngagementRemindersForUser(uid, libraryItems, timeZone) {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone });
    const watchedDates = buildWatchedDatesSet(libraryItems);
    const mostRecentWatch = watchedDates.size > 0 ? [...watchedDates].sort().pop() : null;
    const dayGap = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

    if (mostRecentWatch && mostRecentWatch !== todayStr) {
        const streak = getCurrentWatchStreak(watchedDates);
        if (streak > 0) {
            // A dedicated doc, separate from release-notification
            // tracking (notifiedReleases) - these two used to share the
            // exact same Firestore document and "ids" array, mixing a
            // literal 'streak-reminder' string in among what's meant to
            // be release IDs. Nothing surfaced as an outright crash from
            // that in the simple case (the two paths are mutually
            // exclusive within a single day, by design), but it was
            // fragile and confusing to read, and gave any future change
            // to either concern room to corrupt the other's data.
            const streakRef = db.collection('users').doc(uid).collection('_internal').doc('lastStreakReminder');
            const streakDoc = await streakRef.get();
            const alreadySentToday = streakDoc.exists && streakDoc.data().day === todayStr;

            if (!alreadySentToday) {
                try {
                    await sendOneSignalPush(uid, 'Keep Your Streak Going!', `You're on a ${streak}-day watch streak - watch something today to keep it going.`);
                    await streakRef.set({ day: todayStr });
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

        // Engagement reminders only get a look-in on a day with nothing
        // actually releasing for this account at all - never alongside a
        // real release.
        if (releases.length === 0) {
            await checkEngagementRemindersForUser(uid, libraryItems, timeZone);
            continue;
        }

        // A small doc per account records which release IDs have
        // already been sent today, so the same item never notifies
        // twice if this job happens to run again before the day rolls
        // over (a manual re-run, a retry).
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
