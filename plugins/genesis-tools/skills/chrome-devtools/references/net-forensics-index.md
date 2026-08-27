# Network and wire-level forensics: index

Split by topic so only the needed part is read. Source: a 2026-05-26 research braindump;
these copies are canonical for agents.

| Symptom | File | Section |
|---|---|---|
| `(unknown)` Type, odd Size/Initiator | `net-panel-symptoms.md` | 1, 1.3, 1.4 |
| `(canceled)` · `(blocked:other)` · `(failed)` · XHR status 0 | `net-panel-symptoms.md` | 1.2 |
| Live panel and exported HAR disagree | `net-panel-symptoms.md` | 1.5 |
| Response body missing/empty with Preserve log on | `net-panel-symptoms.md` | 2.1-2.3 |
| **Token/OAuth POST body vanished** (navigation aborted it) | `net-panel-symptoms.md` | 2.6 |
| Opaque / CORB-stripped cross-origin response | `net-panel-symptoms.md` | 2.5 |
| Need more capture: panel settings, columns, experiments | `net-capture-settings.md` | 3.1-3.5 |
| Start a raw capture (`chrome://net-export/`, `net-internals`) | `net-capture-settings.md` | 3.6-3.7 |
| Brave Shields / fingerprinting altering requests | `net-capture-settings.md` | 3.9 |
| What HAR does not capture at all | `net-export-recipes.md` | 4 |
| Grep a net-export log for one URL's lifecycle | `net-export-recipes.md` | 5.2-5.3 |
| Find the numeric net error behind a cancel | `net-export-recipes.md` | 5.4 |
| OAuth token endpoint end-to-end checklist | `net-export-recipes.md` | 5.6 |

Two facts to carry into every investigation:

- Chrome withholds body bytes from DevTools until viewed; navigation destroys the copy.
- Anything below HTTP is invisible to both the panel and HAR — only net-export has it.
