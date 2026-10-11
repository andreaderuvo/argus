# Viewers of your own

Argus opens a file with one of its own viewers: markdown rendered, code coloured, PDFs, images,
3D meshes, the rest as text. A **viewer pack** adds another, for the files you say, written by
anyone: a folder with a `viewer.json` and a page.

```
~/.config/argus/viewers/
  csv-table/
    viewer.json
    index.html
```

```json
{
  "name": "csv-table",
  "title": "Table",
  "description": "A CSV as a table you can edit",
  "files": ["*.csv", "*.tsv"],
  "entry": "index.html",
  "edits": true,
  "binary": false,
  "words": { "it": { "Add a row": "Aggiungi una riga" } }
}
```

- `name` is the folder's name: lower-case letters, digits and dashes.
- `files` are patterns on the file's name (`*.csv`, `Makefile`, `*.team.yaml`).
- `edits: true` lets the pack ask Argus to save the file. Without it, a save is refused.
- `binary: true` hands the pack the bytes (an `ArrayBuffer`) instead of the text.
- `words` translates the pack's own strings. The page's language is chosen for it.

Argus ships one, `diff`, which draws `.diff` and `.patch` files and the **Changes** window. A
pack of yours with the same name replaces it. Settings → Files lists every pack, and a folder
that does not read is listed with the reason. The same setting that picks a viewer per
extension offers the packs, so `.log` can go to yours and `.diff` back to plain text.

## What a pack can and cannot do

A pack is somebody else's code, so it never runs in the page that holds your token. It runs in a
frame sandboxed at an opaque origin:

| | |
|---|---|
| the file it was opened on | handed to it |
| saving that file | asked of Argus, which writes it as the ordinary editor does (the jail, *allow write*) |
| a little to remember (≤ 4 KB) | kept by Argus, handed back the next time |
| the page's colours and theme | handed to it, and again when they change |
| Argus's API, your token, cookies, the page around it | no |
| `fetch`, XHR, WebSocket, to anywhere | no (`connect-src 'none'`) |
| scripts, styles, images | from this server only: its own files and `/vendor/` |

## The conversation

Everything goes through `postMessage`, and every message has an `argus` field naming it.

```js
// pack → Argus, when it is listening
parent.postMessage({ argus: 'ready', v: 1 }, '*');

addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.argus === 'open') {
    // m.name, m.path, m.text (or m.bytes), m.mtime, m.editable, m.truncated,
    // m.theme ('dark' | 'light'), m.colors ({bg, panel, line, text, dim, accent, …}),
    // m.state (what you asked to keep), m.words (your strings, in the page's language)
  }
  if (m.argus === 'theme') { /* m.theme, m.colors */ }
  if (m.argus === 'saved') { /* m.mtime, m.size */ }
  if (m.argus === 'error') { /* m.message */ }
});

parent.postMessage({ argus: 'dirty', dirty: true }, '*');     // unsaved work: no reload under it
parent.postMessage({ argus: 'save', text: '…' }, '*');        // edits packs only
parent.postMessage({ argus: 'state', state: { layout: 'wide' } }, '*');
```

`truncated` means the file was too big and the pack has its last part only; `editable` is then
false, because saving a tail would throw the head away.

The source button on the window still shows Argus's own view of the file, so a pack that draws
something wrong never hides it.
