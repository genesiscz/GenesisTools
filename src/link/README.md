# link

> **Make `@genesiscz/utils` resolvable for TypeScript files that live outside this checkout.**

---

## The problem

A `.ts` file you write outside this repo cannot import the package:

```ts
import { defineDocument } from "@genesiscz/utils/json2md/document-file";
// Cannot find package '@genesiscz/utils' imported from /…/some/vault/note.ts
```

Bun resolves a bare specifier from the **importing file's** folder, not from the tool's, so no
tool can fix it at call time. It fails identically under `bun note.ts` and under a GenesisTools
command.

## The fix

One `tsconfig.json` carrying a `paths` mapping at an ancestor directory. Bun reads the
**nearest** tsconfig above the importing file and applies its `paths` before any `node_modules`
walk, so a single file answers for every descendant.

```bash
tools link install              # write it under your home directory
tools link install --root DIR   # narrower blast radius
tools link status               # is it installed, and does the import actually resolve
tools link uninstall            # remove it
```

The file it writes:

```json
{
    "compilerOptions": {
        "paths": {
            "@genesiscz/utils": ["/…/GenesisTools/src/utils/index.ts"],
            "@genesiscz/utils/*": ["/…/GenesisTools/src/utils/*"]
        }
    },
    "files": [],
    "include": []
}
```

The empty `files` and `include` matter: without them an editor's TypeScript server treats the
directory as a project root and walks every file beneath it, which at the home directory is the
whole machine. Bun reads only `compilerOptions.paths` and ignores both.

---

## Commands

| Command | What it does |
|---|---|
| `tools link status` | Default. Reports the mapping and whether the import resolves, for the home directory and the current one |
| `tools link install` | Writes `<root>/tsconfig.json` mapping the package at this checkout |
| `tools link uninstall` | Removes the mapping, and the node_modules symlink the earlier mechanism left |

| Option | Applies to | Description |
|---|---|---|
| `--root <dir>` | all | Directory to act on. Defaults to the home directory |
| `--force` | install, uninstall | Act on a mapping pointing at a **different** checkout |

---

## What it will not do

- 🛑 **Never overwrites a file that is not a JSON object.** It is reported and left alone.
- 🛑 **Never repoints another checkout's mapping** without `--force`. Silently moving it would
  move every consumer under that root onto a different tree.
- 🛑 **Never discards the rest of an existing tsconfig.** Only the two keys are written, other
  settings and comments survive, and `uninstall` removes the file only when nothing else is in
  it.

---

## Reading the status table

`MAPPING` and `RESOLVES` are independent on purpose:

| MAPPING | RESOLVES | Means |
|---|---|---|
| `current` | `yes` | Installed and working |
| `absent` | `yes` | A nearer `node_modules` or tsconfig already provides it — a repo that depends on it normally |
| `absent` | `no` | Nothing here; `tools link install` |
| `current` | `no` | The mapping exists but a nearer tsconfig shadows it |
| `other checkout` | either | Points at a different GenesisTools; `--force` to repoint |
| `dangling` | either | Points at a checkout that was moved or deleted; `install` repairs it without `--force` |
| `unreadable` | either | The file is not a JSON object. Not ours to touch |

---

## ⚠️ What installing at the home directory means

Every file under that root that imports `@genesiscz/utils` **and has no tsconfig of its own**
now resolves it. That bound is the whole reason this is safe to do at the home directory: Bun
reads only the nearest tsconfig, so a project carrying its own is never affected, even one
directly beneath the root. What is left in scope is loose scripts and vault documents, which is
the target.

It can still mask a genuinely missing dependency in a project that has no tsconfig. Use
`--root` to narrow it when that matters.

The mapping names the checkout the command was run from. Move that checkout and it goes stale;
`tools link status` reports it as `dangling` and `tools link install` repairs it without
`--force`, because nothing can depend on a path that is not there.

---

## Rejected alternatives, each measured

Bun 1.4.2, macOS, 2026-09-22. None of these is a matter of taste.

| Mechanism | Why not |
|---|---|
| `node_modules` symlink at an ancestor | Works, but an empty or near-empty `node_modules` **disables Bun's auto-install** for every file beneath it. Measured: `picocolors` resolved from `/tmp` and failed from the home directory. That silently breaks loose scripts that used to run |
| Runtime `Bun.plugin` `onResolve` | **Never consulted for a bare specifier.** Positive control: the same plugin's hook fired for a relative specifier in the same process, and `onLoad` fired for real files, while the bare specifier went straight to the node resolver |
| `bun link` | Registers a package for a later `bun link <name>`. Puts nothing on the resolution path by itself |
| Publishing to npm | Works, and hands consumers a **snapshot** while the repo runs live code |
| A loader with an alias option (`jiti`) | Works, and only for imports **we** perform. `bun doc.ts` never calls our loader, so it still fails. Measured both arms |

The last row is the one that decides it: the requirement is that the same file works under
`bun doc.ts` **and** under a GenesisTools command. Only the tsconfig mapping satisfies both.

---

## This is not a new trick

`src/scripts/lib/store.ts` (`ensureStoreScaffold`) already generates a `tsconfig.json` with
`paths` at `~/.genesis-tools/scripts/`, and rewrites it when it no longer points at the current
checkout. That self-healing idea is where this tool's `repaired` outcome came from.

## Related mechanisms, already solving this differently

Two other places answer "code outside the repo needs to reach repo code". Neither is wrong, and
neither should be converted to use this tool:

| Where | Mechanism |
|---|---|
| `src/artifact/lib/vite.ts` (`baseResolve`) | A Vite `resolve.alias` entry. The files are served through a dev server, so the bundler resolves them |
| `src/cmux/lib/capture-installer.ts` (`bundleRuntime`) | A `Bun.build` `onResolve` plugin redirecting one import at BUNDLE time. The output runs standalone with no repo nearby |

⚠️ The build-time `onResolve` above works. The **runtime** one does not, as the table above
records. They are different hooks despite the shared name.

## 🛑 Not a licence to break plugin standalone-ness

`scripts/ci/check-plugin-standalone.ts` fails CI on any `@genesiscz/*` import under
`plugins/**`, because plugin files are copied out of this checkout and run where the repo is
not nearby. Several of them inline small helpers for exactly that reason.

Do **not** use this mapping to justify importing the package there. The rule's value is that a
plugin needs zero setup, and the plugin cache destination is not a path we control.

## Other code that could hit the same failure

- `src/utils/json2md/document-file.ts` (`loadDocumentModule`) — the case this was built for.
- `src/node-repl/lib/worker.ts` — the REPL can `import()` any absolute path. A single-file
  snippet is fine; an external multi-file module whose own imports use the bare specifier
  would hit it.
