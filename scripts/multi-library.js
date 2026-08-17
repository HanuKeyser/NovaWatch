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
   Every other piece of the app that needs to read/write library data
   goes through these instead of building the path inline, so "which
   library is active" only has to be correct in one place.
========================================================= */
function getLibrariesCollectionRef(uid) {
    return db.collection("users").doc(uid).collection("libraries");
}

function getLibraryItemsRef(uid, libraryId) {
    return getLibrariesCollectionRef(uid).doc(libraryId).collection("items");
}

function getLibraryArchivedRef(uid, libraryId) {
    return getLibrariesCollectionRef(uid).doc(libraryId).collection("archivedShows");
}

// Convenience wrappers for the overwhelmingly common case - acting on
// whichever library is currently active for the signed-in user. Every
// existing app.js call site that used to hardcode
// db.collection("users").doc(uid).collection("library") now calls these
// instead, so it automatically always targets the right library.
function getActiveLibraryItemsRef() {
    if (!auth || !auth.currentUser || !state.activeLibraryId) return null;
    return getLibraryItemsRef(auth.currentUser.uid, state.activeLibraryId);
}

function getActiveLibraryArchivedRef() {
    if (!auth || !auth.currentUser || !state.activeLibraryId) return null;
    return getLibraryArchivedRef(auth.currentUser.uid, state.activeLibraryId);
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

    const librariesSnap = await getLibrariesCollectionRef(uid).get();

    if (librariesSnap.empty) {
        // Brand new account, or an existing account from before this
        // feature existed - either way, build on the account's existing
        // "My Library" data rather than starting a separate setup flow
        // (a fresh account's library is simply empty, so this path
        // handles both cases identically).
        await migrateLegacyLibraryData(uid, displayName);
    } else {
        state.libraries = librariesSnap.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

        // A library doc existing is NOT proof the migration that created
        // it actually finished - if the very first migration ever got
        // interrupted (tab closed, connection dropped, page reloaded)
        // between creating this library and finishing the move, the old
        // fashioned collections here checks for that leftover data every
        // time from here on, and finishes the move into the first
        // library instead of leaving it stranded and unreadable forever.
        await resumeInterruptedLegacyMigration(uid, state.libraries[0].id);
    }

    // Figure out which library should open. Prefer whatever was saved as
    // this account's activeLibraryId (already loaded into state by the
    // profile fetch that runs alongside this in proceedToApp - but read
    // it directly here too as a fallback in case that fetch hasn't
    // landed yet) - falling back to the first library if that id is
    // missing or no longer exists (e.g. it was since deleted).
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
// locations until whichever of migrateLegacyLibraryData() or
// resumeInterruptedLegacyMigration() next gets a chance to finish it.
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
                getLibraryItemsRef(uid, targetLibraryId)
            );
        }
        const legacyArchivedSnap = await db.collection("users").doc(uid).collection("archivedShows").limit(1).get();
        if (!legacyArchivedSnap.empty) {
            await moveCollection(
                db.collection("users").doc(uid).collection("archivedShows"),
                getLibraryArchivedRef(uid, targetLibraryId)
            );
        }
    } catch (err) {
        console.error("Resuming an interrupted legacy migration failed:", err);
    }
}

// Runs exactly once per account, the first time initMultiLibrary() finds
// no libraries subcollection yet. Creates the default "My Library" and
// moves every existing item out of the old flat users/{uid}/library and
// users/{uid}/archivedShows collections into it, then removes the old
// flat collections so they can't be read from again by mistake.
async function migrateLegacyLibraryData(uid, displayName) {
    const defaultLibraryRef = getLibrariesCollectionRef(uid).doc();
    const defaultLibrary = {
        name: displayName ? `${displayName}'s Library` : "My Library",
        avatarId: randomAvatarId(),
        createdAt: Date.now()
    };
    await defaultLibraryRef.set(defaultLibrary);

    let migrationFailed = false;
    try {
        await moveCollection(
            db.collection("users").doc(uid).collection("library"),
            getLibraryItemsRef(uid, defaultLibraryRef.id)
        );
        await moveCollection(
            db.collection("users").doc(uid).collection("archivedShows"),
            getLibraryArchivedRef(uid, defaultLibraryRef.id)
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
    const itemsRef = getLibraryItemsRef(uid, state.activeLibraryId);
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
    const itemsRef = getLibraryItemsRef(uid, state.activeLibraryId);
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
        closeLibrarySwitcherMenu();
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
    closeLibrarySwitcherMenu();
    closeLibrarySelectionScreen();
    renderLibrarySwitcherPill();
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
        createdAt: Date.now()
    };
    const ref = getLibrariesCollectionRef(uid).doc();
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
    const uid = auth.currentUser.uid;
    await getLibrariesCollectionRef(uid).doc(libraryId).set({ name: trimmedName }, { merge: true });
    const library = state.libraries.find(l => l.id === libraryId);
    if (library) library.name = trimmedName;
    renderLibrarySelectionScreen();
    renderLibrarySwitcherPill();
    renderLibrarySwitcherMenu();
    return true;
}

async function updateLibraryAvatar(libraryId, avatarId) {
    if (!auth || !auth.currentUser) return false;
    const uid = auth.currentUser.uid;
    await getLibrariesCollectionRef(uid).doc(libraryId).set({ avatarId }, { merge: true });
    const library = state.libraries.find(l => l.id === libraryId);
    if (library) library.avatarId = avatarId;
    renderLibrarySelectionScreen();
    renderLibrarySwitcherPill();
    renderLibrarySwitcherMenu();
    return true;
}

// Deletes a library and everything in it (items + archivedShows), but
// never the underlying account, and never any other library. Always
// leaves at least one library behind - the last remaining library on an
// account can't be deleted, since every account must have somewhere for
// newly-added content to go.
async function deleteLibrary(libraryId) {
    if (!auth || !auth.currentUser) return false;
    if (state.libraries.length <= 1) {
        showToast("You need at least one library.", "error");
        return false;
    }
    const uid = auth.currentUser.uid;

    await deleteSubcollection(getLibraryItemsRef(uid, libraryId));
    await deleteSubcollection(getLibraryArchivedRef(uid, libraryId));
    await getLibrariesCollectionRef(uid).doc(libraryId).delete();

    state.libraries = state.libraries.filter(l => l.id !== libraryId);

    if (state.activeLibraryId === libraryId) {
        await switchActiveLibrary(state.libraries[0].id);
    } else {
        renderLibrarySelectionScreen();
        renderLibrarySwitcherMenu();
    }
    return true;
}

// Shared low-level helper: deletes every document in a Firestore
// collection reference, batched (500-op batch limit). Used for both a
// single library's items/archivedShows here, and for every library's
// worth of data during a full account deletion (see
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
// deleting an account - loops every library the account has (not just
// the currently active one) and clears its items + archivedShows, then
// the library doc itself, so "delete my account" really does remove
// every library's data, not just whichever one happened to be open.
async function deleteAllLibrariesData(uid) {
    const librariesSnap = await getLibrariesCollectionRef(uid).get();
    for (const libDoc of librariesSnap.docs) {
        await deleteSubcollection(getLibraryItemsRef(uid, libDoc.id));
        await deleteSubcollection(getLibraryArchivedRef(uid, libDoc.id));
        await libDoc.ref.delete();
    }
}

/* =========================================================
   "CHOOSE YOUR LIBRARY" SCREEN
   A full-screen overlay, same visual weight as #authScreen - shown right
   after sign-in on an account with more than one library, and reachable
   any time afterward via "Manage Libraries" in the header switcher.
========================================================= */
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
    if (backdropEl) {
        const withBackdrop = [...state.library]
            .filter(item => item.backdrop || item.poster)
            .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
        const heroImage = withBackdrop[0] ? (withBackdrop[0].backdrop || withBackdrop[0].poster) : null;
        backdropEl.style.backgroundImage = heroImage ? `url('${heroImage}')` : '';
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
   HEADER SWITCHER ("My Library ▾")
   A small floating pill visible on every tab (see .library-header-bar in
   multi-library.css) - tapping it opens a short dropdown of every
   library on the account plus a link into the full selection screen,
   so switching never requires leaving whatever page you're on.
========================================================= */
function renderLibrarySwitcherPill() {
    const pill = document.getElementById("librarySwitcherPill");
    if (!pill) return;
    const active = state.libraries.find(l => l.id === state.activeLibraryId);
    const label = pill.querySelector(".library-switcher-label");
    if (label) label.textContent = active ? active.name : "Library";

    // Only worth showing once there's an actual choice to make - a
    // single-library account (the common case, at least at first) sees
    // no switcher at all, just "Manage Libraries" reachable from Settings.
    const bar = document.getElementById("libraryHeaderBar");
    if (bar) bar.style.display = state.libraries.length > 1 ? "" : "none";

    const librariesRowSub = document.getElementById("librariesRowSub");
    if (librariesRowSub) {
        librariesRowSub.textContent = `${state.libraries.length} librar${state.libraries.length === 1 ? 'y' : 'ies'}`;
    }
}

function renderLibrarySwitcherMenu() {
    const menu = document.getElementById("librarySwitcherMenu");
    if (!menu) return;
    const items = state.libraries.map(lib => {
        const avatar = AVATAR_OPTIONS.find(a => a.id === lib.avatarId);
        const avatarHTML = avatar
            ? `<img src="${avatar.src}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
            : `<span>${escapeHTML(lib.name.charAt(0).toUpperCase())}</span>`;
        const isActive = lib.id === state.activeLibraryId;
        return `
            <button class="library-switcher-option ${isActive ? 'active' : ''}" onclick="switchActiveLibrary('${lib.id}')">
                <div class="library-switcher-option-avatar">${avatarHTML}</div>
                <span>${escapeHTML(lib.name)}</span>
                ${isActive ? '<svg class="icon icon-small" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>' : ''}
            </button>`;
    }).join('');

    menu.innerHTML = items + `
        <button class="library-switcher-option library-switcher-manage" onclick="closeLibrarySwitcherMenu(); openLibrarySelectionScreen();">
            <span>Manage Libraries</span>
        </button>`;
}

function openLibrarySwitcherMenu() {
    renderLibrarySwitcherMenu();
    const menu = document.getElementById("librarySwitcherMenu");
    const pill = document.getElementById("librarySwitcherPill");
    if (menu) menu.classList.add("open");
    if (pill) pill.classList.add("open");
    document.addEventListener("click", closeLibrarySwitcherMenuOutside, { capture: true });
}

function closeLibrarySwitcherMenu() {
    const menu = document.getElementById("librarySwitcherMenu");
    const pill = document.getElementById("librarySwitcherPill");
    if (menu) menu.classList.remove("open");
    if (pill) pill.classList.remove("open");
    document.removeEventListener("click", closeLibrarySwitcherMenuOutside, { capture: true });
}

function closeLibrarySwitcherMenuOutside(event) {
    const bar = document.getElementById("libraryHeaderBar");
    if (bar && !bar.contains(event.target)) closeLibrarySwitcherMenu();
}

function toggleLibrarySwitcherMenu() {
    const menu = document.getElementById("librarySwitcherMenu");
    if (menu && menu.classList.contains("open")) closeLibrarySwitcherMenu();
    else openLibrarySwitcherMenu();
}

/* =========================================================
   ADD LIBRARY MODAL
========================================================= */
let pendingNewLibraryAvatarId = null;

function openAddLibraryModal() {
    pendingNewLibraryAvatarId = randomAvatarId();
    const input = document.getElementById("addLibraryNameInput");
    if (input) input.value = "";
    renderAddLibraryAvatarPreview();
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

/* =========================================================
   EDIT LIBRARY MODAL (rename / change avatar / delete)
========================================================= */
let editingLibraryId = null;

function openEditLibraryModal(libraryId) {
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return;
    editingLibraryId = libraryId;

    const input = document.getElementById("editLibraryNameInput");
    if (input) input.value = library.name;
    renderEditLibraryAvatarGrid();

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

function renderEditLibraryAvatarGrid() {
    const grid = document.getElementById("editLibraryAvatarGrid");
    if (!grid || !editingLibraryId) return;
    const library = state.libraries.find(l => l.id === editingLibraryId);
    const currentId = library ? library.avatarId : null;
    grid.innerHTML = AVATAR_OPTIONS.map(avatar => `
        <button class="avatar-picker-option ${avatar.id === currentId ? 'selected' : ''}" onclick="selectEditLibraryAvatar('${avatar.id}')" aria-label="Select avatar">
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

function handleDeleteLibraryFromEdit() {
    if (!editingLibraryId) return;
    closeEditLibraryModal();
    openDeleteLibraryConfirm(editingLibraryId);
}

/* =========================================================
   DELETE LIBRARY CONFIRMATION
========================================================= */
let pendingDeleteLibraryId = null;

function openDeleteLibraryConfirm(libraryId) {
    const library = state.libraries.find(l => l.id === libraryId);
    if (!library) return;
    pendingDeleteLibraryId = libraryId;

    const titleEl = document.getElementById("deleteLibraryTitle");
    const messageEl = document.getElementById("deleteLibraryMessage");
    if (titleEl) titleEl.textContent = `Delete "${library.name}"?`;
    if (messageEl) messageEl.textContent = "This will permanently remove this library and its watch history. This action cannot be undone.";

    const modal = document.getElementById("deleteLibraryModal");
    modal.classList.add("open");
    lockBodyScroll("deleteLibraryModal");
}

function closeDeleteLibraryConfirm() {
    document.getElementById("deleteLibraryModal").classList.remove("open");
    unlockBodyScroll("deleteLibraryModal");
    pendingDeleteLibraryId = null;
}

function closeDeleteLibraryConfirmOutside(event) {
    if (event.target.id === "deleteLibraryModal") closeDeleteLibraryConfirm();
}

async function confirmDeleteLibrary() {
    if (!pendingDeleteLibraryId) return;
    const deleted = await deleteLibrary(pendingDeleteLibraryId);
    pendingDeleteLibraryId = null;
    if (deleted) closeDeleteLibraryConfirm();
}
