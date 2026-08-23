// OneSignal expects a service worker file named exactly this, at the
// site root, once its SDK is initialized (see ONESIGNAL_APP_ID and
// initOneSignal() in scripts/app.js) - it registers this file itself
// automatically, no separate navigator.serviceWorker.register() call
// needed for it.
//
// NovaWatch already had its own service worker (service-worker.js) for
// offline app-shell caching before OneSignal was added. A page can only
// be controlled by one service worker at a time, so rather than losing
// that offline caching or fighting over control of the page, this file
// combines both: OneSignal's own worker code, plus this app's existing
// one, loaded into the same worker via importScripts. Nothing in
// service-worker.js itself needed to change for this - it's simply
// pulled in here instead of being registered on its own once OneSignal
// is configured (see the conditional registration at the bottom of
// app.js).
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
importScripts('/service-worker.js');
