// purge-deleted-accounts.js
//
// Permanently deletes accounts whose 30-day recovery window has expired.
//
// Deleting an account in NovaWatch is a SOFT delete: app.js stamps the
// profile with deletedAt/purgeAfter and signs the person out, but destroys
// nothing. That is what makes recovery possible - the Firebase Auth account
// stays alive so they can sign back in, and the library is left untouched.
// This job is the other half: without it, "deleted" accounts would sit in
// Firestore forever and the deletion would never actually happen.
//
// Runs on the same GitHub Actions + service-account setup as
// send-release-notifications.js, so it needs no Blaze plan and no new
// infrastructure. See release-notifications.yml.
//
// Safe to run repeatedly and safe to miss a day: it works off the stored
// purgeAfter timestamp, not off when it happens to run.

const admin = require("firebase-admin");

const GRACE_DAYS = 30;
// Never purge this account regardless of what's stamped on it - matches
// PROTECTED_USERNAME in app.js and the Firestore rule. Belt and braces:
// the client blocks the deletion from starting, but if a deletedAt ever
// got onto this account by any route, this refuses to act on it.
const PROTECTED_USERNAME = "novawatch";

function initAdmin() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.error("FIREBASE_SERVICE_ACCOUNT_JSON is not set.");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

async function deleteSubcollection(db, uid, name) {
  const BATCH_LIMIT = 400;
  const snap = await db.collection("users").doc(uid).collection(name).get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

async function purge() {
  initAdmin();
  const db = admin.firestore();
  const now = new Date();

  // Only accounts that have actually been marked. A missing deletedAt
  // means a live account and is never touched.
  const snap = await db.collection("users").where("deletedAt", "!=", null).get();

  if (snap.empty) {
    console.log("No accounts pending deletion.");
    return;
  }

  let purged = 0;
  let waiting = 0;

  for (const doc of snap.docs) {
    const uid = doc.id;
    const data = doc.data() || {};

    if ((data.username || "").toLowerCase() === PROTECTED_USERNAME) {
      console.log(`Skipping protected account ${uid}.`);
      continue;
    }

    // Prefer the stored deadline. Falling back to deletedAt + GRACE_DAYS
    // covers accounts marked before purgeAfter existed, so no one is
    // purged early because of a missing field.
    const deadline = data.purgeAfter
      ? new Date(data.purgeAfter)
      : new Date(new Date(data.deletedAt).getTime() + GRACE_DAYS * 86400000);

    if (isNaN(deadline.getTime())) {
      // An unparseable date must not be treated as "expired" - that would
      // delete someone's account because of a bad string.
      console.warn(`Skipping ${uid}: unreadable purge date (${data.purgeAfter || data.deletedAt}).`);
      continue;
    }

    if (deadline > now) {
      waiting++;
      continue;
    }

    try {
      const lib = await deleteSubcollection(db, uid, "library");
      const arch = await deleteSubcollection(db, uid, "archivedShows");
      try {
        await deleteSubcollection(db, uid, "_internal");
      } catch (err) {
        // Same reasoning as app.js: a cleanup collection failing must not
        // abort the deletion it's a small part of.
        console.warn(`Couldn't clear _internal for ${uid}:`, err.message);
      }

      // Release the reserved username now, not at soft-delete time - it
      // had to stay claimed through the grace period so a restore
      // wouldn't find its own name taken by someone else.
      if (data.username) {
        try {
          await db.collection("usernames").doc(String(data.username).toLowerCase()).delete();
        } catch (err) {
          console.warn(`Couldn't release username for ${uid}:`, err.message);
        }
      }

      await db.collection("users").doc(uid).delete();

      // Auth account last. If anything above fails we still want the
      // account signed-in-able so the data isn't orphaned behind a
      // deleted login.
      try {
        await admin.auth().deleteUser(uid);
      } catch (err) {
        if (err.code === "auth/user-not-found") {
          console.log(`Auth user ${uid} already gone.`);
        } else {
          throw err;
        }
      }

      purged++;
      console.log(`Purged ${uid} (${lib} library, ${arch} archived).`);
    } catch (err) {
      // One bad account must not stop the rest of the run.
      console.error(`Failed to purge ${uid}:`, err.message);
    }
  }

  console.log(`Done. Purged ${purged}, still within grace period: ${waiting}.`);
}

purge()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Purge run failed:", err);
    process.exit(1);
  });
