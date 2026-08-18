/* =========================================================
   MULTI-LIBRARY
   Every user account can hold up to MAX_LIBRARIES separate libraries
   (e.g. "My Library", "Family Library"), each with its own completely
   independent watch data - adding/watching something in one library
   never affects the same title in another. This file owns that whole
   feature: the Firestore structure, switching/creating/renaming/
   deleting libraries, and the "Choose Your Library" screen + header
   switcher UI.

   FIRESTORE STRUCTURE
   users/{uid}                                account-level doc (unchanged -
                                                profiles/region/isPremiumUser/etc,
                                                plus one new field: activeLibraryId)
   users/{uid}/libraries/{libraryId}           one doc per library - name,
                                                avatarId, createdAt
   users/{uid}/libraries/{libraryId}/items            the actual watch data -
   users/{uid}/libraries/{libraryId}/archivedShows    same shape/purpose as the
                                                       old flat users/{uid}/library
                                                       and users/{uid}/archivedShows
                                                       collections, just nested
                                                       one level deeper under
                                                       whichever library they
                                                       belong to.

   {libraryId} is a normal Firestore auto-id, not "library1"/"library2"/
   "library3" - MAX_LIBRARIES is purely an app-level check before
   createLibrary() is allowed to run, so raising the limit later (or
   removing it) never requires touching the data model.

   WHAT DOESN'T LIVE PER-LIBRARY
   region, isPremiumUser, the account avatar/profile (state.profiles),
   theme, and notification permission are account-level settings, not
   watch data - they intentionally stay shared across every library on
   the account and are untouched by anything in this file.

   GLOBAL CONTENT DEDUPLICATION - PARTIAL, BY DESIGN
   The brief asks for movie/show metadata (title, poster, cast, episode
   lists, etc.) to be stored once as shared "global content" rather than
   duplicated inside every library that adds the same title. This file
   does NOT do that split. Every library item document here is still the
   same fully denormalized shape the app has always used (TMDB metadata
   + this library's watch state together in one doc) - genuinely
   splitting those apart would mean rewriting how virtually every
   rendering function in app.js reads an item (item.title, item.poster,
   item.episodes, etc. - hundreds of call sites), which isn't something
   to do blind, in one pass, against a live app with real user data.
   What IS fully implemented is the part that actually matters most per
   the brief's own "Core Principle": watch data (added/watched/progress/
   rewatches/stopped/etc.) is completely isolated per library, and nothing
   is ever auto-shared between libraries - see items 5 and 7. The
   metadata-deduplication half is a real, clearly-scoped follow-up: add a
   top-level content/{mediaType}_{tmdbId} collection, populate it from
   the existing TMDB-fetch call sites, and change item docs to store a
   reference instead of a full copy - flagged here rather than done
   partially/riskily.
========================================================= */

const MAX_LIBRARIES = 3;

/* =========================================================
   FIRESTORE PATH HELPERS
   Libraries live in their own top-level collection now, not nested
   under a single owning user, so a library can be read/written by more
   than one account once it's shared - see "LIBRARY SHARING" further
   down. Every other piece of the app that needs to read/write library
   data goes through these instead of building the path inline, so
   "which library is active" only has to be correct in one place.
========================================================= */
function getLibrariesCollectionRef() {
    return db.collection("libraries");
}

function getLibraryItemsRef(libraryId) {
    return getLibrariesCollectionRef().doc(libraryId).collection("items");
}

function getLibraryArchivedRef(libraryId) {
    return getLibrariesCollectionRef().doc(libraryId).collection("archivedShows");
}

// Convenience wrappers for the overwhelmingly common case - acting on
// whichever library is currently active. Every existing app.js call
// site that used to hardcode a Firestore path for library data goes
// through these instead, so it automatically always targets the right
// library.
function getActiveLibraryItemsRef() {
    if (!auth || !auth.currentUser || !state.activeLibraryId) return null;
    return getLibraryItemsRef(state.activeLibraryId);
}

function getActiveLibraryArchivedRef() {
    if (!auth || !auth.currentUser || !state.activeLibraryId) return null;
    return getLibraryArchivedRef(state.activeLibraryId);
}

// Holds the unsubscribe function for the currently-active library's
// real-time listener, so switching libraries can tear down the old one
// before attaching a new one - otherwise a stale listener from the
// previous library would keep writing its changes into state.library
// right alongside the new library's own listener.
let activeLibraryUnsubscribe = null;

/* =========================================================
   INITIAL LOAD (called once from proceedToApp in app.js, before the
   existing profile/library fetch)
========================================================= */
async function initMultiLibrary(uid, displayName) {
    state.libraries = [];
    state.activeLibraryId = null;

    // Finish promoting anything still sitting in the old, per-user
    // users/{uid}/libraries shape (how this feature stored libraries
    // before sharing existed) into the current shared, top-level
    // libraries collection. Safe to run on every sign-in - resolves
    // almost instantly once there's nothing left to promote.
    await migratePerUserLibrariesToShared(uid);

    let librariesSnap = await db.collection("libraries").where("memberIds", "array-contains", uid).get();

    if (librariesSnap.empty) {
        // Still nothing at the top level even after that promotion -
        // either a genuinely brand-new account, or one old enough to
        // predate every version of this feature and still have data
        // sitting in the oldest, flat users/{uid}/library shape. Either
        // way, build the first library directly at the current
        // top-level location rather than starting a separate setup flow.
        await migrateLegacyLibraryData(uid, displayName);
    } else {
        state.libraries = librariesSnap.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

        // A library existing is NOT proof its own creation actually
        // finished - if migrateLegacyLibraryData ever got interrupted
        // (tab closed, connection dropped) between creating a library
        // and finishing the item move, this checks for that leftover
        // data every time from here on and finishes moving it into the
        // first library, rather than leaving it stranded forever.
        await resumeInterruptedLegacyMigration(uid, state.libraries[0].id);
    }

    // Figure out which library should open. Prefer whatever was saved as
    // this account's activeLibraryId (already loaded into state by the
    // profile fetch that runs alongside this in proceedToApp - but read
    // it directly here too as a fallback in case that fetch hasn't
    // landed yet) - falling back to the first library if that id is
    // missing or no longer exists (e.g. it was since deleted, or was a
    // joined library this account has since left).
    let activeId = state.activeLibraryId;
    if (!activeId || !state.libraries.some(l => l.id === activeId)) {
        try {
            const userDoc = await db.collection("users").doc(uid).get();
            const savedActiveId = userDoc.exists ? userDoc.data().activeLibraryId : null;
            if (savedActiveId && state.libraries.some(l => l.id === savedActiveId)) {
                activeId = savedActiveId;
            }
        } catch (err) {
            console.warn("Could not read saved activeLibraryId, defaulting to first library:", err);
        }
    }
    if (!activeId || !state.libraries.some(l => l.id === activeId)) {
        activeId = state.libraries[0] ? state.libraries[0].id : null;
    }
    state.activeLibraryId = activeId;
}

// Batched copy-then-delete from one collection into another, 400 docs at
// a time (Firestore batches top out at 500 ops; each doc here is 1 set +
// 1 delete). Each batch is atomic, so a doc is never deleted from the
// source without its copy having already committed at the destination in
// that same batch - what can happen is the WHOLE OPERATION getting
// interrupted between batches (tab closed mid-migration, connection
// drops), leaving some docs moved and some still sitting at the source.
// Nothing is ever lost either way, just possibly split across both
// locations until whichever migration function next gets a chance to
// finish it.
async function moveCollection(oldRef, newRef) {
    const snap = await oldRef.get();
    if (snap.empty) return;
    const BATCH_LIMIT = 400;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        docs.slice(i, i + BATCH_LIMIT).forEach(doc => {
            batch.set(newRef.doc(doc.id), doc.data());
            batch.delete(doc.ref);
        });
        await batch.commit();
    }
}

// Promotes any library still sitting at the old per-user
// users/{uid}/libraries/{id} path (how this feature stored libraries
// before sharing was added) into the current shared, top-level
// libraries/{id} collection - same id preserved, so any activeLibraryId
// already saved for it stays valid. Existing watch data moves with it;
// the library doc itself is created with this account as owner and sole
// member, sharing off, matching what every library's sharing state was
// implicitly before this concept existed. Uses the SAME id for the new
// top-level doc specifically so this is safe to interrupt and resume:
// re-running it only ever fills in whatever's still missing.
async function migratePerUserLibrariesToShared(uid) {
    try {
        const perUserSnap = await db.collection("users").doc(uid).collection("libraries").get();
        if (perUserSnap.empty) return;

        for (const doc of perUserSnap.docs) {
            const data = doc.data();
            const libraryId = doc.id;
            const topLevelRef = db.collection("libraries").doc(libraryId);

            // Only set the doc's fields if it doesn't already exist -
            // an interrupted first attempt may have already created it
            // (and the owner may have since turned sharing on for it),
            // so blindly re-writing sharingEnabled/inviteCode here on a
            // resumed attempt would silently undo that.
            const existing = await topLevelRef.get();
            if (!existing.exists) {
                await topLevelRef.set({
                    name: data.name,
                    avatarId: data.avatarId,
                    createdAt: data.createdAt || Date.now(),
                    ownerId: uid,
                    memberIds: [uid],
                    sharingEnabled: false,
                    inviteCode: null
                });
            }

            await moveCollection(
                db.collection("users").doc(uid).collection("libraries").doc(libraryId).collection("items"),
                topLevelRef.collection("items")
            );
            await moveCollection(
                db.collection("users").doc(uid).collection("libraries").doc(libraryId).collection("archivedShows"),
                topLevelRef.collection("archivedShows")
            );

            await doc.ref.delete();
        }
    } catch (err) {
        console.error("Promoting per-user libraries to the shared collection failed partway through:", err);
    }
}

// Runs on every sign-in for an account that already has at least one
// library (so migrateLegacyLibraryData() itself was skipped) - checks
// whether the old flat users/{uid}/library or users/{uid}/archivedShows
// collections still have anything in them, and if so, finishes moving it
// into the first library rather than leaving it invisible to the app
// forever. Cheap on every normal load (two 1-doc reads that come back
// empty) - only does real work the rare time it finds something.
async function resumeInterruptedLegacyMigration(uid, targetLibraryId) {
    try {
        const legacyItemsSnap = await db.collection("users").doc(uid).collection("library").limit(1).get();
        if (!legacyItemsSnap.empty) {
            console.warn("Found leftover pre-migration library items - resuming an interrupted migration.");
            await moveCollection(
                db.collection("users").doc(uid).collection("library"),
                getLibraryItemsRef(targetLibraryId)
            );
        }
        const legacyArchivedSnap = await db.collection("users").doc(uid).collection("archivedShows").limit(1).get();
        if (!legacyArchivedSnap.empty) {
            await moveCollection(
                db.collection("users").doc(uid).collection("archivedShows"),
                getLibraryArchivedRef(targetLibraryId)
            );
        }
    } catch (err) {
        console.error("Resuming an interrupted legacy migration failed:", err);
    }
}

// Runs exactly once per account, the first time initMultiLibrary() finds
// no top-level library at all. Creates the default "My Library" directly
// at the current top-level location and moves every existing item out of
// the oldest, flat users/{uid}/library and users/{uid}/archivedShows
// collections into it, then removes those flat collections so they can't
// be read from again by mistake.
async function migrateLegacyLibraryData(uid, displayName) {
    const defaultLibraryRef = getLibrariesCollectionRef().doc();
    const defaultLibrary = {
        name: displayName ? `${displayName}'s Library` : "My Library",
        avatarId: randomAvatarId(),
        createdAt: Date.now(),
        ownerId: uid,
        memberIds: [uid],
        sharingEnabled: false,
        inviteCode: null
    };
    await defaultLibraryRef.set(defaultLibrary);

    let migrationFailed = false;
    try {
        await moveCollection(
            db.collection("users").doc(uid).collection("library"),
            getLibraryItemsRef(defaultLibraryRef.id)
        );
        await moveCollection(
            db.collection("users").doc(uid).collection("archivedShows"),
            getLibraryArchivedRef(defaultLibraryRef.id)
        );
    } catch (err) {
        // The default library doc itself was already created successfully
        // above, so the account is never left without a library even if
        // the migration copy fails partway - worst case some legacy items
        // are still sitting in the old flat collection, and
        // resumeInterruptedLegacyMigration() above will pick up and
        // finish moving them the next time this account signs in.
        console.error("Legacy library migration failed partway through:", err);
        migrationFailed = true;
    }

    state.libraries = [{ id: defaultLibraryRef.id, ...defaultLibrary }];
    state.activeLibraryId = defaultLibraryRef.id;
    await db.collection("users").doc(uid).set({ activeLibraryId: defaultLibraryRef.id }, { merge: true });

    // This whole migration is silent by design on the happy path (it runs
    // automatically, once, with no setup screen - see the Multi-Library
    // README section) - but that means a failure would otherwise be
    // invisible too, sitting only in the console. Surfacing it here means
    // "why is my library empty" has an actual on-screen answer instead of
    // requiring devtools to notice anything went wrong.
    if (migrationFailed) {
        showToast("Some library data couldn't be moved to the new library system - it's still safe, and will finish moving automatically next time.", "error");
    }
}

/* =========================================================
   FETCHING & LIVE SYNC FOR THE ACTIVE LIBRARY
========================================================= */
// Mirrors the original inline fetch that used to live in proceedToApp's
// libraryPromise - same cache fallback, just pointed at whichever
// library is now active instead of a single flat collection.
async function fetchActiveLibraryItems(uid) {
    const itemsRef = getLibraryItemsRef(state.activeLibraryId);
    let items = [];
    try {
        const snap = await itemsRef.get();
        snap.forEach(doc => { if (doc.exists) items.push(doc.data()); });
    } catch (fetchErr) {
        console.warn("Could not fetch library from server, trying cache:", fetchErr);
        try {
            const cachedSnap = await itemsRef.get({ source: 'cache' });
            cachedSnap.forEach(doc => { if (doc.exists) items.push(doc.data()); });
        } catch (cacheErr) {
            console.error("Cache fetch also failed:", cacheErr);
        }
    }
    return items;
}

// Tears down any previous library's listener (see activeLibraryUnsubscribe
// above), then attaches a fresh one for whichever library is active now.
// Shared by both the initial sign-in load (proceedToApp) and every later
// switchActiveLibrary() call, so there's exactly one place this wiring
// lives instead of two copies that could drift apart.
function subscribeToActiveLibrary(uid) {
    if (activeLibraryUnsubscribe) {
        activeLibraryUnsubscribe();
        activeLibraryUnsubscribe = null;
    }
    const itemsRef = getLibraryItemsRef(state.activeLibraryId);
    activeLibraryUnsubscribe = itemsRef.onSnapshot((snapshot) => {
        let updatedLibrary = [...state.library];

        snapshot.docChanges().forEach((change) => {
            const itemData = change.doc.data();
            if (!itemData || !itemData.id) return;

            const isBrokenStub = !itemData.type
                || itemData.title === undefined
                || itemData.description === undefined
                || (itemData.type !== 'movie' && itemData.episodes === undefined)
                || (itemData.type !== 'movie' && Array.isArray(itemData.episodes) && itemData.episodes.length === 0 && !itemData.numberOfSeasons && !itemData.poster)
                || (itemData.type === 'movie' && !itemData.poster && !itemData.backdrop && !itemData.runtime);
            if (itemData.isPreview || itemData.id.startsWith('preview-') || isBrokenStub) return;

            const index = updatedLibrary.findIndex(i => i.id === itemData.id);

            if (change.type === "added" || change.type === "modified") {
                if (index !== -1) updatedLibrary[index] = itemData;
                else updatedLibrary.push(itemData);
            } else if (change.type === "removed") {
                if (index !== -1) updatedLibrary.splice(index, 1);
            }
        });

        state.library = updatedLibrary;
        refreshActivePage();
    });
}

/* =========================================================
   SWITCHING LIBRARIES
========================================================= */
async function switchActiveLibrary(libraryId) {
    if (!auth || !auth.currentUser || libraryId === state.activeLibraryId) {
        closeLibrarySelectionScreen();
        return;
    }
    const uid = auth.currentUser.uid;
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return;

    state.activeLibraryId = libraryId;
    try {
        await db.collection("users").doc(uid).set({ activeLibraryId: libraryId }, { merge: true });
    } catch (err) {
        console.warn("Failed to persist activeLibraryId (will still switch for this session):", err);
    }

    libraryLoaded = false;
    closeLibrarySelectionScreen();
    updateLibrariesSettingsRow();
    showPage('home');

    let cloudLibrary = await fetchActiveLibraryItems(uid);
    let dedupedLibrary = cloudLibrary;
    try {
        dedupedLibrary = dedupeAndCleanLibrary(cloudLibrary, uid);
    } catch (dedupeErr) {
        console.error("Library dedupe/cleanup failed, using library as-is:", dedupeErr);
    }
    state.library = dedupedLibrary;
    libraryLoaded = true;
    refreshActivePage();
    subscribeToActiveLibrary(uid);

    showToast(`Switched to "${library.name}"`, "success");
}

/* =========================================================
   CREATE / RENAME / RE-AVATAR / DELETE
========================================================= */
async function createLibrary(name, avatarId) {
    if (!auth || !auth.currentUser) return false;
    const trimmedName = (name || "").trim();
    if (!trimmedName) {
        showToast("Give your library a name.", "error");
        return false;
    }
    if (state.libraries.length >= MAX_LIBRARIES) {
        showToast(`You can have up to ${MAX_LIBRARIES} libraries.`, "error");
        return false;
    }

    const uid = auth.currentUser.uid;
    const newLibrary = {
        name: trimmedName,
        avatarId: avatarId || randomAvatarId(),
        createdAt: Date.now(),
        ownerId: uid,
        memberIds: [uid],
        sharingEnabled: false,
        inviteCode: null
    };
    const ref = getLibrariesCollectionRef().doc();
    await ref.set(newLibrary);
    state.libraries.push({ id: ref.id, ...newLibrary });

    renderLibrarySelectionScreen();
    await switchActiveLibrary(ref.id);
    return true;
}

async function renameLibrary(libraryId, newName) {
    if (!auth || !auth.currentUser) return false;
    const trimmedName = (newName || "").trim();
    if (!trimmedName) {
        showToast("Give your library a name.", "error");
        return false;
    }
    await getLibrariesCollectionRef().doc(libraryId).set({ name: trimmedName }, { merge: true });
    const library = state.libraries.find(l => l.id === libraryId);
    if (library) library.name = trimmedName;
    renderLibrarySelectionScreen();
    return true;
}

async function updateLibraryAvatar(libraryId, avatarId) {
    if (!auth || !auth.currentUser) return false;
    await getLibrariesCollectionRef().doc(libraryId).set({ avatarId }, { merge: true });
    const library = state.libraries.find(l => l.id === libraryId);
    if (library) library.avatarId = avatarId;
    renderLibrarySelectionScreen();
    return true;
}

// Deletes a library and everything in it (items + archivedShows), but
// never the underlying account, and never any other library. Only the
// library's creator can do this - see isLibraryOwner() and the
// Firestore rules, which enforce the same restriction server-side, not
// just here. Always leaves at least one library behind for THIS
// account - the last remaining library on an account can't be deleted,
// since every account must have somewhere for newly-added content to go
// (a non-owner with only one library - i.e. one they joined - uses
// leaveLibrary() instead, which has no such restriction).
async function deleteLibrary(libraryId) {
    if (!auth || !auth.currentUser) return false;
    const uid = auth.currentUser.uid;
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return false;
    if (library.ownerId !== uid) {
        showToast("Only the creator of a library can delete it.", "error");
        return false;
    }
    if (state.libraries.length <= 1) {
        showToast("You need at least one library.", "error");
        return false;
    }

    await deleteSubcollection(getLibraryItemsRef(libraryId));
    await deleteSubcollection(getLibraryArchivedRef(libraryId));
    await getLibrariesCollectionRef().doc(libraryId).delete();

    state.libraries = state.libraries.filter(l => l.id !== libraryId);

    if (state.activeLibraryId === libraryId) {
        await switchActiveLibrary(state.libraries[0].id);
    } else {
        renderLibrarySelectionScreen();
        updateLibrariesSettingsRow();
    }
    return true;
}

// The non-owner counterpart to deleteLibrary() - removes this account
// from a joined library's memberIds without touching the library or its
// other members at all. Available to anyone who isn't the owner
// (including on their only remaining library, unlike delete - leaving
// your only library just means your account goes back to having none,
// which the next sign-in's migration/init logic already handles the
// same way a brand-new account is handled).
async function leaveLibrary(libraryId) {
    if (!auth || !auth.currentUser) return false;
    const uid = auth.currentUser.uid;
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return false;
    if (library.ownerId === uid) {
        showToast("You created this library - delete it instead of leaving.", "error");
        return false;
    }

    try {
        await getLibrariesCollectionRef().doc(libraryId).update({
            memberIds: firebase.firestore.FieldValue.arrayRemove(uid)
        });
    } catch (err) {
        console.error("Failed to leave library:", err);
        showToast("Couldn't leave that library.", "error");
        return false;
    }

    state.libraries = state.libraries.filter(l => l.id !== libraryId);

    if (state.activeLibraryId === libraryId) {
        if (state.libraries.length > 0) {
            await switchActiveLibrary(state.libraries[0].id);
        } else {
            // Left their only library - initMultiLibrary() will build a
            // fresh default one the same way it does for a brand-new
            // account, next time this runs (sign-in, or a manual retry).
            state.activeLibraryId = null;
            state.library = [];
            await initMultiLibrary(uid, (state.profiles && state.profiles[0]) ? state.profiles[0].name : null);
            if (state.activeLibraryId) await switchActiveLibrary(state.activeLibraryId);
        }
    } else {
        renderLibrarySelectionScreen();
        updateLibrariesSettingsRow();
    }
    return true;
}

// Shared low-level helper: deletes every document in a Firestore
// collection reference, batched (500-op batch limit). Used for both a
// single library's items/archivedShows here, and for every OWNED
// library's worth of data during a full account deletion (see
// deleteAllLibrariesData below, called from app.js's deleteAllUserData).
async function deleteSubcollection(ref) {
    const BATCH_LIMIT = 400;
    const snap = await ref.get();
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        docs.slice(i, i + BATCH_LIMIT).forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    }
}

// Called from app.js's deleteAllUserData() as part of permanently
// deleting an account. Loops every library this account is a member of
// (owned or joined - memberIds array-contains this uid) and treats the
// two cases differently: a library this account OWNS is deleted outright
// (items + archivedShows + the library doc itself), same as
// deleteLibrary() above. A library this account only JOINED is left
// completely alone except for removing this account from its
// memberIds - deleting the account must never delete or otherwise touch
// a shared library out from under its other members.
async function deleteAllLibrariesData(uid) {
    const snap = await db.collection("libraries").where("memberIds", "array-contains", uid).get();
    for (const libDoc of snap.docs) {
        const data = libDoc.data();
        if (data.ownerId === uid) {
            await deleteSubcollection(getLibraryItemsRef(libDoc.id));
            await deleteSubcollection(getLibraryArchivedRef(libDoc.id));
            await libDoc.ref.delete();
        } else {
            await libDoc.ref.update({
                memberIds: firebase.firestore.FieldValue.arrayRemove(uid)
            });
        }
    }
}

/* =========================================================
   LIBRARY SHARING
   Gated behind state.librarySharingEnabled - an account-level Settings
   toggle (see Settings > Preferences > Library Sharing) that hides every
   share/join affordance in the app while off, default off. Turning it
   on doesn't share anything by itself - it just makes the per-library
   "Share" toggle and the "Join a Library" option available; each
   library's own sharing is still a separate, explicit choice its owner
   makes in Edit Library.

   A shared library is genuinely one library both accounts see the same
   copy of - not a copy, not a one-way sync. See the Firestore rules in
   the README's Multi-Library section for how membership/joining is
   enforced server-side, not just here.
========================================================= */
function isLibraryOwner(library) {
    return !!(library && auth && auth.currentUser && library.ownerId === auth.currentUser.uid);
}

// Shows/hides every element tagged .library-sharing-gated based on the
// account-level toggle - the per-library Share section in Edit Library,
// and the Join tab in Add Library.
function syncLibrarySharingUI() {
    const enabled = !!state.librarySharingEnabled;
    document.querySelectorAll('.library-sharing-gated').forEach(el => {
        el.style.display = enabled ? '' : 'none';
    });
    const offBtn = document.getElementById('librarySharingOffBtn');
    const onBtn = document.getElementById('librarySharingOnBtn');
    if (offBtn) offBtn.classList.toggle('active', !enabled);
    if (onBtn) onBtn.classList.toggle('active', enabled);
}

async function setLibrarySharingCapability(enabled) {
    state.librarySharingEnabled = enabled;
    try {
        await saveUserProfile();
    } catch (err) {
        console.error("Failed to save library sharing preference:", err);
    }
    syncLibrarySharingUI();
}

// 6 characters, uppercase alphanumeric minus visually ambiguous ones
// (0/O, 1/I/L) - meant to be read off a screen and typed by hand, not
// pasted from a link.
function generateInviteCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// Only the owner can turn sharing on/off for their own library - a
// non-owner member never sees this control at all (see
// renderEditLibraryModal), and this function itself won't act on their
// behalf even if called directly. Turning sharing on reuses any invite
// code the library already has rather than generating a new one each
// time, so a code someone was already given doesn't silently stop
// working the next time sharing gets toggled off and back on.
async function setLibrarySharing(libraryId, enabled) {
    if (!auth || !auth.currentUser) return false;
    const library = state.libraries.find(l => l.id === libraryId);
    if (!isLibraryOwner(library)) return false;

    const updates = { sharingEnabled: enabled };
    if (enabled && !library.inviteCode) {
        updates.inviteCode = generateInviteCode();
    }
    try {
        await getLibrariesCollectionRef().doc(libraryId).update(updates);
    } catch (err) {
        console.error("Failed to update library sharing:", err);
        showToast("Couldn't update sharing for that library.", "error");
        return false;
    }
    Object.assign(library, updates);
    renderEditLibraryModal();
    return true;
}

async function joinLibraryByCode(code) {
    if (!auth || !auth.currentUser) return false;
    const uid = auth.currentUser.uid;
    const trimmedCode = (code || "").trim().toUpperCase();
    if (!trimmedCode) {
        showToast("Enter an invite code.", "error");
        return false;
    }
    if (state.libraries.length >= MAX_LIBRARIES) {
        showToast(`You can have up to ${MAX_LIBRARIES} libraries.`, "error");
        return false;
    }

    try {
        const snap = await db.collection("libraries")
            .where("inviteCode", "==", trimmedCode)
            .where("sharingEnabled", "==", true)
            .limit(1)
            .get();

        if (snap.empty) {
            showToast("That code isn't valid, or sharing has been turned off for that library.", "error");
            return false;
        }

        const libDoc = snap.docs[0];
        const data = libDoc.data();
        if (data.memberIds.includes(uid)) {
            showToast("You're already in that library.", "error");
            return false;
        }

        await libDoc.ref.update({ memberIds: firebase.firestore.FieldValue.arrayUnion(uid) });
        state.libraries.push({ id: libDoc.id, ...data, memberIds: [...data.memberIds, uid] });

        renderLibrarySelectionScreen();
        await switchActiveLibrary(libDoc.id);
        showToast(`Joined "${data.name}"!`, "success");
        return true;
    } catch (err) {
        console.error("Failed to join library:", err);
        showToast("Couldn't join that library.", "error");
        return false;
    }
}


let libraryScreenEditMode = false;

function openLibrarySelectionScreen() {
    libraryScreenEditMode = false;
    renderLibrarySelectionScreen();
    const modal = document.getElementById("libraryScreen");
    modal.classList.add("open");
    lockBodyScroll("libraryScreen");
}

function closeLibrarySelectionScreen() {
    const modal = document.getElementById("libraryScreen");
    if (!modal) return;
    modal.classList.remove("open");
    unlockBodyScroll("libraryScreen");
}

function closeLibraryScreenOutside(event) {
    if (event.target.id === "libraryScreen") closeLibrarySelectionScreen();
}

function toggleLibraryScreenEditMode() {
    libraryScreenEditMode = !libraryScreenEditMode;
    renderLibrarySelectionScreen();
}

function renderLibrarySelectionScreen() {
    const grid = document.getElementById("libraryScreenGrid");
    if (!grid) return;

    // Hero image: the most recently added item in whichever library is
    // currently loaded into state.library, same "recently added" sort
    // app.js already uses elsewhere (addedAt, newest first). Falls back
    // to the plain brand gradient (see .library-screen-backdrop in
    // multi-library.css) once there's nothing to pull a photo from -
    // clearing the inline style lets that CSS fallback show through.
    const backdropEl = document.getElementById("libraryScreenBackdrop");
    const logoEl = document.getElementById("libraryScreenLogo");
    if (backdropEl) {
        const withBackdrop = [...state.library]
            .filter(item => item.backdrop || item.poster)
            .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
        const heroImage = withBackdrop[0] ? (withBackdrop[0].backdrop || withBackdrop[0].poster) : null;
        backdropEl.style.backgroundImage = heroImage ? `url('${heroImage}')` : '';
        // The fallback logo only makes sense over the plain gradient - a
        // real photo covers it entirely either way, but hiding it outright
        // avoids it being visible for an instant through a photo that's
        // semi-transparent at the edges (posters/backdrops sometimes are).
        if (logoEl) logoEl.style.display = heroImage ? 'none' : '';
    }

    const cards = state.libraries.map(lib => {
        const avatar = AVATAR_OPTIONS.find(a => a.id === lib.avatarId);
        const avatarHTML = avatar
            ? `<img src="${avatar.src}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
            : `<span>${escapeHTML(lib.name.charAt(0).toUpperCase())}</span>`;
        const isActive = lib.id === state.activeLibraryId;
        const onclick = libraryScreenEditMode
            ? `openEditLibraryModal('${lib.id}')`
            : `switchActiveLibrary('${lib.id}')`;
        return `
            <button class="library-card ${isActive ? 'active' : ''}" onclick="${onclick}">
                <div class="library-card-avatar">${avatarHTML}</div>
                <div class="library-card-name">${escapeHTML(lib.name)}</div>
            </button>`;
    }).join('');

    const addTile = state.libraries.length < MAX_LIBRARIES ? `
        <button class="library-card library-card-utility" onclick="openAddLibraryModal()">
            <div class="library-card-avatar library-card-icon">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
            </div>
            <div class="library-card-name">Add</div>
        </button>` : '';

    const editTile = `
        <button class="library-card library-card-utility ${libraryScreenEditMode ? 'active' : ''}" onclick="toggleLibraryScreenEditMode()">
            <div class="library-card-avatar library-card-icon">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
            </div>
            <div class="library-card-name">${libraryScreenEditMode ? 'Done' : 'Edit'}</div>
        </button>`;

    grid.innerHTML = cards + addTile + editTile;
}

/* =========================================================
   SETTINGS "LIBRARIES" ROW
   The only entry point into switching/managing libraries now - see
   openLibrarySelectionScreen() below. There is no longer a persistent
   switcher on Home/anywhere else in the main app; this row's subtitle
   is the only on-screen indication of which library is active.
========================================================= */
function updateLibrariesSettingsRow() {
    const librariesRowSub = document.getElementById("librariesRowSub");
    if (librariesRowSub) {
        librariesRowSub.textContent = `${state.libraries.length} librar${state.libraries.length === 1 ? 'y' : 'ies'}`;
    }
}

/* =========================================================
   ADD LIBRARY MODAL
   Two modes: Create (the only option while library sharing is off) and
   Join (only shown once state.librarySharingEnabled is on - see
   .library-sharing-gated). addLibraryMode tracks which is active;
   switching modes doesn't reset whatever was already typed in the
   other one, so an accidental tap doesn't lose input.
========================================================= */
let pendingNewLibraryAvatarId = null;
let addLibraryMode = 'create';

function openAddLibraryModal() {
    pendingNewLibraryAvatarId = randomAvatarId();
    addLibraryMode = 'create';
    const nameInput = document.getElementById("addLibraryNameInput");
    if (nameInput) nameInput.value = "";
    const codeInput = document.getElementById("joinLibraryCodeInput");
    if (codeInput) codeInput.value = "";
    renderAddLibraryAvatarPreview();
    syncAddLibraryModalMode();
    const modal = document.getElementById("addLibraryModal");
    modal.classList.add("open");
    lockBodyScroll("addLibraryModal");
}

function closeAddLibraryModal() {
    document.getElementById("addLibraryModal").classList.remove("open");
    unlockBodyScroll("addLibraryModal");
}

function closeAddLibraryModalOutside(event) {
    if (event.target.id === "addLibraryModal") closeAddLibraryModal();
}

function setAddLibraryMode(mode) {
    addLibraryMode = mode;
    syncAddLibraryModalMode();
}

function syncAddLibraryModalMode() {
    const createTab = document.getElementById("addLibraryModeCreate");
    const joinTab = document.getElementById("addLibraryModeJoin");
    const createPane = document.getElementById("addLibraryCreatePane");
    const joinPane = document.getElementById("addLibraryJoinPane");
    if (createTab) createTab.classList.toggle("active", addLibraryMode === 'create');
    if (joinTab) joinTab.classList.toggle("active", addLibraryMode === 'join');
    if (createPane) createPane.style.display = addLibraryMode === 'create' ? '' : 'none';
    if (joinPane) joinPane.style.display = addLibraryMode === 'join' ? '' : 'none';
}

function renderAddLibraryAvatarPreview() {
    const el = document.getElementById("addLibraryAvatarPreview");
    if (!el) return;
    const avatar = AVATAR_OPTIONS.find(a => a.id === pendingNewLibraryAvatarId);
    el.innerHTML = avatar
        ? `<img src="${avatar.src}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
        : '';
}

function shuffleNewLibraryAvatar() {
    pendingNewLibraryAvatarId = randomAvatarId();
    renderAddLibraryAvatarPreview();
}

async function submitAddLibrary() {
    const input = document.getElementById("addLibraryNameInput");
    const name = input ? input.value : "";
    const created = await createLibrary(name, pendingNewLibraryAvatarId);
    if (created) closeAddLibraryModal();
}

async function submitJoinLibrary() {
    const input = document.getElementById("joinLibraryCodeInput");
    const code = input ? input.value : "";
    const joined = await joinLibraryByCode(code);
    if (joined) closeAddLibraryModal();
}

/* =========================================================
   EDIT LIBRARY MODAL (rename / change avatar / sharing / delete or
   leave)
   Only a library's owner can rename it, change its avatar, or manage
   its sharing - a non-owner member sees all of that read-only, plus a
   "Leave Library" action in place of "Delete Library". Mirrors the
   Firestore rules exactly (see the README's Multi-Library section) -
   this is the UI reflecting what's actually allowed, not a separate
   set of restrictions.
========================================================= */
let editingLibraryId = null;

function openEditLibraryModal(libraryId) {
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return;
    editingLibraryId = libraryId;
    renderEditLibraryModal();

    const modal = document.getElementById("editLibraryModal");
    modal.classList.add("open");
    lockBodyScroll("editLibraryModal");
}

function closeEditLibraryModal() {
    document.getElementById("editLibraryModal").classList.remove("open");
    unlockBodyScroll("editLibraryModal");
    editingLibraryId = null;
}

function closeEditLibraryModalOutside(event) {
    if (event.target.id === "editLibraryModal") closeEditLibraryModal();
}

function renderEditLibraryModal() {
    const library = state.libraries.find(l => l.id === editingLibraryId);
    if (!library) return;
    const owner = isLibraryOwner(library);

    const input = document.getElementById("editLibraryNameInput");
    if (input) {
        input.value = library.name;
        input.disabled = !owner;
    }
    renderEditLibraryAvatarGrid();

    const ownerNotice = document.getElementById("editLibraryOwnerNotice");
    if (ownerNotice) ownerNotice.style.display = owner ? 'none' : '';

    const saveBtn = document.getElementById("editLibrarySaveBtn");
    if (saveBtn) saveBtn.style.display = owner ? '' : 'none';

    // The sharing section needs BOTH gates: owner-only (a non-owner
    // member never sees or controls another account's sharing setting)
    // AND the account-level capability toggle (Settings > Preferences >
    // Library Sharing) - this render can run while that's off, so it
    // has to check it directly rather than relying only on the
    // .library-sharing-gated class, which syncLibrarySharingUI() only
    // re-applies when the toggle itself changes, not on every modal open.
    const sharingSection = document.getElementById("editLibrarySharingSection");
    const showSharing = owner && !!state.librarySharingEnabled;
    if (sharingSection) sharingSection.style.display = showSharing ? '' : 'none';
    if (showSharing) {
        const sharingOffBtn = document.getElementById("editLibrarySharingOffBtn");
        const sharingOnBtn = document.getElementById("editLibrarySharingOnBtn");
        if (sharingOffBtn) sharingOffBtn.classList.toggle("active", !library.sharingEnabled);
        if (sharingOnBtn) sharingOnBtn.classList.toggle("active", !!library.sharingEnabled);
        const codeRow = document.getElementById("editLibraryInviteCodeRow");
        const codeText = document.getElementById("editLibraryInviteCode");
        if (codeRow) codeRow.style.display = library.sharingEnabled ? '' : 'none';
        if (codeText) codeText.textContent = library.inviteCode || '';
    }

    const deleteBtn = document.getElementById("editLibraryDeleteBtn");
    if (deleteBtn) {
        const label = deleteBtn.querySelector(".settings-row-title");
        if (label) label.textContent = owner ? "Delete Library" : "Leave Library";
    }
}

function renderEditLibraryAvatarGrid() {
    const grid = document.getElementById("editLibraryAvatarGrid");
    if (!grid || !editingLibraryId) return;
    const library = state.libraries.find(l => l.id === editingLibraryId);
    const currentId = library ? library.avatarId : null;
    const owner = isLibraryOwner(library);
    grid.innerHTML = AVATAR_OPTIONS.map(avatar => `
        <button class="avatar-picker-option ${avatar.id === currentId ? 'selected' : ''}" ${owner ? `onclick="selectEditLibraryAvatar('${avatar.id}')"` : 'disabled'} aria-label="Select avatar">
            <img src="${avatar.src}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">
        </button>
    `).join('');
}

async function selectEditLibraryAvatar(avatarId) {
    if (!editingLibraryId) return;
    await updateLibraryAvatar(editingLibraryId, avatarId);
    renderEditLibraryAvatarGrid();
}

async function submitEditLibrary() {
    if (!editingLibraryId) return;
    const input = document.getElementById("editLibraryNameInput");
    const name = input ? input.value : "";
    const saved = await renameLibrary(editingLibraryId, name);
    if (saved) closeEditLibraryModal();
}

function setEditLibrarySharing(enabled) {
    if (!editingLibraryId) return;
    setLibrarySharing(editingLibraryId, enabled);
}

function copyEditLibraryInviteCode() {
    const library = state.libraries.find(l => l.id === editingLibraryId);
    if (!library || !library.inviteCode) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(library.inviteCode)
            .then(() => showToast("Invite code copied.", "success"))
            .catch(() => showToast(`Invite code: ${library.inviteCode}`, null));
    } else {
        showToast(`Invite code: ${library.inviteCode}`, null);
    }
}

function handleDeleteLibraryFromEdit() {
    if (!editingLibraryId) return;
    const library = state.libraries.find(l => l.id === editingLibraryId);
    if (!library) return;
    closeEditLibraryModal();
    if (isLibraryOwner(library)) {
        openDeleteLibraryConfirm(editingLibraryId);
    } else {
        openLeaveLibraryConfirm(library.id);
    }
}

/* =========================================================
   DELETE / LEAVE LIBRARY CONFIRMATION
   Same confirm dialog serves both - which one a given library shows is
   already decided upstream by handleDeleteLibraryFromEdit() (owner sees
   delete, everyone else sees leave), so this just renders whichever
   text/action was asked for.
========================================================= */
let pendingLibraryAction = null; // { id, mode: 'delete' | 'leave' }

function openDeleteLibraryConfirm(libraryId) {
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return;
    pendingLibraryAction = { id: libraryId, mode: 'delete' };

    const titleEl = document.getElementById("deleteLibraryTitle");
    const messageEl = document.getElementById("deleteLibraryMessage");
    const confirmBtn = document.getElementById("deleteLibraryConfirmBtn");
    if (titleEl) titleEl.textContent = `Delete "${library.name}"?`;
    if (messageEl) messageEl.textContent = "This will permanently remove this library and its watch history. This action cannot be undone.";
    if (confirmBtn) confirmBtn.textContent = "Delete";

    const modal = document.getElementById("deleteLibraryModal");
    modal.classList.add("open");
    lockBodyScroll("deleteLibraryModal");
}

function openLeaveLibraryConfirm(libraryId) {
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return;
    pendingLibraryAction = { id: libraryId, mode: 'leave' };

    const titleEl = document.getElementById("deleteLibraryTitle");
    const messageEl = document.getElementById("deleteLibraryMessage");
    const confirmBtn = document.getElementById("deleteLibraryConfirmBtn");
    if (titleEl) titleEl.textContent = `Leave "${library.name}"?`;
    if (messageEl) messageEl.textContent = "You'll lose access to this library's watch data unless you're invited back. The library and its other members are unaffected.";
    if (confirmBtn) confirmBtn.textContent = "Leave";

    const modal = document.getElementById("deleteLibraryModal");
    modal.classList.add("open");
    lockBodyScroll("deleteLibraryModal");
}

function closeDeleteLibraryConfirm() {
    document.getElementById("deleteLibraryModal").classList.remove("open");
    unlockBodyScroll("deleteLibraryModal");
    pendingLibraryAction = null;
}

function closeDeleteLibraryConfirmOutside(event) {
    if (event.target.id === "deleteLibraryModal") closeDeleteLibraryConfirm();
}

async function confirmDeleteLibrary() {
    if (!pendingLibraryAction) return;
    const { id, mode } = pendingLibraryAction;
    const ok = mode === 'leave' ? await leaveLibrary(id) : await deleteLibrary(id);
    pendingLibraryAction = null;
    if (ok) closeDeleteLibraryConfirm();
}
