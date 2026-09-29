# Jev browser goal-loop benchmark

`bun src/jev/scripts/browser-benchmark.ts [--runs N] [--task search|checkout|settings] [--out file.json]`

A HEADLESS Chrome on a throwaway profile drives three multi-step tasks on fixture pages served on
127.0.0.1, with the real Jev evaluator. Success is checked in code from the final URL; Jev's own
"done" is never taken as proof (it was wrong in both directions below). Each result names the
SHA-256 of the files that decide, the browser, and what the task cost. It spends real Jev requests.

The live guard check for the page driver itself (no model) is
`bun src/chrome-devtools/scripts/dom-guards.ts`.

## 2026-09-28 23:01 — first measured baseline

Chrome/153.0.8010.53, 3 runs per task, load average 11 to 16 during the run (wall time on this
machine is noisy; the Jev time is most of each step). Sources: `in-page.ts` c8f96db0f33e001a,
`dom/page.ts` 59686bf0055381f3, `loop/browser.ts` 7cfce0a5f0ff80d6, `loop/run.ts` 5239329dff64c0d1,
`observe.ts` d2a54f66ab3ce8df, `decisions.ts` 6eb2ca90a2b7b4b5.

| Task | Passed | Wall ms (3 runs) | Jev ms | Jev calls | Tokens in/out |
| --- | --- | --- | --- | --- | --- |
| search: fill, submit, open the Blue Kettle result | 3/3 | 2019 / 2036 / 2139 | 1086 / 1120 / 1202 | 4 | 3695 / 549 |
| checkout: pick Express, accept terms, continue | 3/3 | 2048 / 2108 / 2364 | 1095 / 1144 / 1406 | 4 | 4274 / 591 |
| settings: open Privacy, block trackers, save | 3/3 | 1929 / 2217 / 2335 | 1140 / 1395 / 1506 | 4 | 3988 / 582 |

Each page read is one in-page script: 11 ms median on a 2000-link page (dom-guards).

### What the benchmark found on its first runs (all fixed before this baseline)

1. **A form submit cost 30.4 s.** The act's settle call lost its context to the navigation; the
   agent retried it in a fresh isolated world, and that evaluate neither answered nor failed until
   Chrome gave up. Now every agent call has a 5 s deadline, each input registers its load waiter
   before it is sent, and `settle` never retries: a lost context there IS the navigation. The
   search task went from 32 779 ms to 2 216 ms. dom-guards now submits a form (26 ms).
2. **The option a list already showed was offered again.** After Express was selected, Jev split
   0.45 / 0.39 between the terms checkbox and Express, and nothing passed the gate. Selected options
   are no longer rows.
3. **`done` beat a confident act.** On the privacy page Jev answered Save 0.97 and done 0.85; the
   fan-out checked done first and stopped unsaved. A concrete act admitted more confidently than
   done now wins.
4. **The right target at 0.77 abstained.** "I accept the terms" was correct but under the 0.8 gate
   in one run of three. A reversible act (risk score below 0.5) now needs 0.6 with a 0.25 margin;
   anything that sends, navigates, deletes or buys keeps 0.8.

The settings task ends `stopped:no_certain_act` on the saved page in every run: the goal is met
(the code check passes), but Jev does not call it done. That is why the outcome is checked in code.
