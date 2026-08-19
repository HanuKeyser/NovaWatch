// NovaWatch service worker
//
// Scope intentionally kept small:
//   - Makes the app installable (browsers require a fetch handler + manifest).
//   - Caches the app shell (this HTML page, plus its own CSS/JS - see below)
//     so a repeat visit still loads something if the network briefly drops.
//   - Handles taps on notifications so they focus/open the app.
//
// It deliberately does NOT cache TMDB/Firebase API responses or images —
// that data changes constantly and should always come from the network.
//
// NOTE: this alone does not enable "notify me even when the app/tab is
// fully closed" — true closed-app push requires a backend push service
// (e.g. Firebase Cloud Messaging) sending to this worker. What this DOES
// enable is registration.showNotification() working reliably while the
// service worker is active (e.g. app open in a background tab).

const CACHE_NAME = "novawatch-shell-v32";

self.addEventListener("install", (event) => {
    // self.registration.scope is the actual folder this worker controls
    // (e.g. https://www.novawatch.site/) rather than a hardcoded "/",
    // so this keeps working whether the app lives at the domain root or
    // in a subfolder.
    const appShellUrl = self.registration.scope;
    // The HTML used to be a single self-contained file - now that its CSS
    // and JS live in their own files, the offline fallback below only
    // works if those come along too. Without this, a network failure
    // would still serve the cached HTML shell, but that shell references
    // external files this worker never cached, leaving the page unstyled
    // and non-functional instead of the working fallback it used to be.
    const urlsToCache = [
        appShellUrl,
        appShellUrl + "styles/tokens.css",
        appShellUrl + "styles/app.css",
        appShellUrl + "scripts/app.js"
    ];
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const isShellAsset = [
        "styles/tokens.css",
        "styles/app.css",
        "scripts/app.js"
    ].some((path) => event.request.url.endsWith(path));

    // Only ever serve from cache as a fallback when the network fails - for
    // navigation requests (the HTML shell itself) or this app's own CSS/JS
    // (cached above, so the shell doesn't come back unstyled and
    // non-functional when offline) - never for API calls, images, or
    // anything else.
    if (event.request.mode !== "navigate" && !isShellAsset) return;

    event.respondWith(
        fetch(event.request).catch(() =>
            event.request.mode === "navigate"
                ? caches.match(self.registration.scope)
                : caches.match(event.request)
        )
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
                if ("focus" in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(self.registration.scope);
        })
    );
});
