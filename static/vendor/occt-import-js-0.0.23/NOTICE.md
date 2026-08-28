`occt-import-js.wasm` and `occt-import-js.js` are the OpenCascade Technology (OCCT) geometry
kernel, compiled to WebAssembly by the [occt-import-js](https://github.com/kovacsv/occt-import-js)
project (version 0.0.23), used here to read STEP files in the browser.

Both OCCT itself and the occt-import-js wrapper are **LGPL-2.1**, which is why this folder
carries two licence files (`LICENSE` for the wrapper, `LICENSE.occt` for OCCT) rather than
the single `LICENSE` every other vendored library here has — everything else in
`static/vendor/` is MIT or Apache-2.0.

LGPL-2.1 §6 asks that a program using the library as a shared component let the library be
replaced with a modified version. It is loaded here exactly that way — a plain `fetch()` of
two files at a fixed path, never bundled into `app.js` — so replacing either file with your
own build satisfies that on its own; nothing else is needed to comply.

Source: https://github.com/kovacsv/occt-import-js — a wrapper around
https://dev.opencascade.org/, itself LGPL-2.1.
