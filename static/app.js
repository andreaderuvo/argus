// The entry point, and nothing else: every line of the app lives in a module under /js/.
//
// This file keeps its name because index.html, the service worker, installed PWAs and the
// proxy's address rewriting all know it — and it must never be imported back by a module,
// since whatever imports the entry point runs before the entry point has finished.
import '/js/main.js';
