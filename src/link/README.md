# tools link

`tools link` makes `@genesiscz/utils` importable from TypeScript files that live outside the
GenesisTools checkout: a json2md document module in a notes folder, a loose script, a codemod. It
writes one `tsconfig.json` with a `paths` mapping into a folder you choose (your home directory by
default), and checks that Bun really resolves the import through it.

## Quick start

```bash
tools link                                  # same as `tools link status`: is it mapped, does it resolve
tools link install                          # map the package for every file under your home directory
tools link install --root /Volumes/Data/notes  # map one folder (a folder outside home needs this)
tools link status --root /Volumes/Data/notes   # check one folder only
tools link uninstall                        # remove the home-directory mapping
```

## The problem it solves

A `.ts` file outside this repo cannot import the package:

```ts
import { defineDocument } from "@genesiscz/utils/json2md/document-file";
// Cannot find package '@genesiscz/utils' imported from /…/some/vault/note.ts
```

Bun resolves a bare specifier from the folder of the **importing file**, not from the folder of the
tool that runs it. So no tool can fix it at call time, and the file fails the same way under
`bun note.ts` and under a GenesisTools command.

The fix is one `tsconfig.json` with a `paths` mapping in an ancestor folder. Bun reads the
**nearest** tsconfig above the importing file and applies its `paths` before any `node_modules`
walk, so one file serves every file beneath it.

## Commands

| Command | What it does |
|---|---|
| `tools link status` | The default. Shows the mapping and whether the import resolves |
| `tools link install` | Writes `<root>/tsconfig.json`, or merges the mapping into it |
| `tools link uninstall` | Removes the mapping, and the symlink of the first version |

| Flag | On | Default | What it does |
|---|---|---|---|
| `--root <dir>` | status | home and current folder | Report this one folder only |
| `--root <dir>` | install, uninstall | home | The folder whose `tsconfig.json` it edits |
| `--force` | install, uninstall | off | Act on a mapping that names another checkout |
| `-v, --verbose` | `tools link` | off | Verbose logging |
| `--readme` | `tools link` | | Print this README and exit |

A relative `--root` is resolved against the current folder.

### status

`tools link status` changes nothing. Without `--root` it reports two rows: your home directory and
the current folder. Each row has four columns:

- `ROOT`: the folder, always as an absolute path.
- `MAPPING`: what that folder's own `tsconfig.json` says about the package.
- `RESOLVES`: whether a bare `@genesiscz/utils` import really resolves from that folder.
- `POINTS AT`: the package folder the mapping resolves to (`…/src/utils`), or a dash when there is no mapping.

A header line `package link  @genesiscz/utils → <package dir>` names the package folder of the running checkout. `current`
is compared with that folder.

`MAPPING` and `RESOLVES` are independent on purpose. A repo with its own `node_modules` resolves
with no mapping at all, and a mapping can exist while the import still fails.

| MAPPING | RESOLVES | Meaning |
|---|---|---|
| `current` | `yes` | Installed and working |
| `current` | `no` | Mapped, but Bun still fails here. See Troubleshooting |
| `absent` | `yes` | Something else serves it: an ancestor mapping, or a `node_modules` |
| `absent` | `no` | Nothing serves it. Run `tools link install`, or read the warning |
| `other checkout` | either | Names another GenesisTools that exists. `--force` repoints it |
| `dangling` | either | Names a moved or deleted checkout. `install` repairs it |
| `unreadable` | either | Not a JSON object, or does not parse. Never edited |

`absent` with `yes` is the normal state of the current-folder row when the home mapping serves
it, and of a repo that depends on the package normally.

When a nearer `tsconfig.json` hides a mapping above it, `status` names that file below the table
and prints the install that fixes it (see [The one way it fails](#the-one-way-it-fails-a-nearer-tsconfig)).

A mapping with a relative target is read correctly: the target is resolved against `baseUrl`, or
against the folder of the config when there is no `baseUrl`. So the GenesisTools checkout's own
`tsconfig.json`, which maps `./src/utils`, reads as `current` when you run `status` from the checkout's root with
that checkout's own `tools`. From a subfolder such as `src/`, the current-folder row reads that folder's
`tsconfig.json` and shows `absent`. A worktree's `./tools` reads the main checkout as `other checkout`.

### install

`tools link install` maps the package under `--root` (default: your home directory). It edits only
`<root>/tsconfig.json`, and only the two `paths` keys. It prints one line for the outcome:

| It prints | Meaning | Exit |
|---|---|---|
| `Wrote …` | No config was there. It wrote a new one | 0 |
| `Added the mapping to …` | It merged the two keys into the existing config | 0 |
| `Repaired a stale mapping in …` | The old target was gone. It now names this checkout | 0 |
| `Already mapped in …` | The mapping already names this checkout | 0, or 1 when the Bun probe fails |
| `… maps the package to …` | Another checkout that exists. Nothing written | 1 |
| `… is not a JSON object …` | A file it cannot edit safely. Nothing written | 1 |
| `… extends another config …` | It has `extends` and no own `paths`. Nothing written | 1 |

On the `Already mapped` path, `install` also runs the live Bun probe from the root. When the probe fails (the 10 s
limit, or a missing or edited bare `@genesiscz/utils` key), it prints the success line, then `The mapping exists
but its target is not a valid package directory.`, and exits 1. In that case the message comes from the probe, not
from the `package.json` check, and the target is fine.

After a write it checks the target. When the target folder has no `package.json` named
`@genesiscz/utils`, it prints `The mapping exists but its target is not a valid package directory.`
and exits 1.

Why it refuses, and what it keeps:

- **Another live checkout** needs `--force`. Repointing it silently would move every consumer
  under that root onto a different tree. A mapping whose target no longer exists is repaired
  without `--force`, because nothing can depend on a path that is not there.
- **A config with `extends` and no `paths` of its own** is refused, whether or not the base defines paths. Its `paths`
  is never overwritten. TypeScript and Bun merge `compilerOptions` from
  an `extends` chain option by option, and a child `paths` replaces the inherited one whole, so
  every alias of the base config would stop resolving. Add the mapping to the config that defines
  `paths`, or copy its `paths` into this file first and run `install` again. When no config in the chain defines
  `paths`, add an empty `"paths": {}` under `compilerOptions` and run `install` again: it then merges the two keys.
- **The rest of an existing tsconfig** stays: other keys, other aliases and comments. The replaced
  file stays beside it as `tsconfig.json.bak`.

### uninstall

`tools link uninstall` removes the two keys from `<root>/tsconfig.json` (default: your home
directory):

- It removes `paths` when nothing else is left in it, and `compilerOptions` when that is empty.
- It deletes the file only when nothing is left but empty `files` and `include` lists. It
  prints `Removed …; it held nothing else.` Otherwise it rewrites the file, keeps the old copy as
  `tsconfig.json.bak`, and prints `Removed the mapping from …; its other settings are untouched.`
- A mapping that names another checkout which exists is left alone without `--force` (exit 1). A
  dangling mapping is removed without `--force`.
- A file that is not a JSON object is left alone (exit 1). No mapping of ours prints
  `Nothing of ours to remove at …` and exits 0. When only the old symlink was removed (no mapping existed), it
  prints the symlink line followed by `Removed the mapping from …`, although the tsconfig was not touched.
- First, before it reads the config, it removes the `<root>/node_modules/@genesiscz/utils`
  symlink that the first version of this tool made, then the `@genesiscz` and `node_modules`
  folders if they are now empty. It removes a symlink that names another checkout only with
  `--force`.

⚠️ Do not run `uninstall --root` at the GenesisTools checkout that runs the command. Its own
`tsconfig.json` maps the package with a relative path, which this tool reads as its own mapping,
so it removes those two keys from the repo's config (the `.bak` copy keeps them). Another
checkout reads as `other checkout` and is refused, unless you add `--force`.

## How it works

### The file it writes

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

- The paths are absolute and name `src/utils` of the checkout that ran the command. `tools` on
  your PATH runs the main checkout. `./tools` in a worktree runs that worktree, so a mapping made
  from a worktree goes `dangling` when the worktree is removed.
- The empty `files` and `include` matter. Without them an editor's TypeScript server treats the
  folder as a project root and indexes every file beneath it, which at the home directory is the
  whole machine. Bun reads only `compilerOptions.paths` and ignores both (measured 2026-09-22).
  They are set only on a file the tool creates: a real project's own `include` is not its business.
- The file is parsed as JSON with comments, so a hand-written tsconfig with `//` comments and
  trailing commas survives a merge.
- Writes are atomic. When a file is replaced, the previous content stays as `<root>/tsconfig.json.bak`
  (one rolling copy).

### Where data lives, and what it needs

- The tool has no config, no cache and no state of its own. The shared logger adds one debug line for each
  `install` to `~/.genesis-tools/logs/<date>.log`. The only files it writes in `<root>` are `tsconfig.json`
  and its `.bak`.
- It needs only Bun. It makes no network calls, needs no macOS permission and costs nothing.
- The `RESOLVES` check runs a short `bun --no-install` child process that calls
  `Bun.resolveSync("@genesiscz/utils", <root>)`, with a 10-second limit. A probe that times out
  reads as `no`. The `--no-install` flag is the point: without it, Bun's auto-installer tried a
  live npm lookup for the unpublished package and printed a progress line with no newline into the
  status output (issue #452). A "does it resolve?" check must never download anything.
- `install` does not ask Bun after a write. Bun caches module resolution per process, so a probe
  right after the write would still report the old miss. It checks the target folder for a
  `package.json` named `@genesiscz/utils` instead, which answers the same question. When the
  mapping was already there, it runs the Bun probe as well.

### What a home-directory install covers

Every file under the root that imports `@genesiscz/utils` **and has no tsconfig of its own** now
resolves it. That bound is the whole reason this is safe at the home directory: Bun reads only the
nearest tsconfig, so a project with its own is never affected, even one directly beneath the root.
What is left in scope is loose scripts and vault documents, which is the target.

It can still mask a missing dependency in a project that has no tsconfig. Use `--root` to narrow
the scope when that matters.

A folder outside your home directory (`/tmp`, `/Volumes/…`) never sees `~/tsconfig.json`. Map it
directly with `tools link install --root <folder>`.

### The one way it fails: a nearer tsconfig

Bun reads the **nearest** tsconfig and applies only its `paths`. There is no merge up the chain.
That bound makes a home-directory mapping safe, and it is also the single way the mapping stops
working: a project with its own `tsconfig.json` hides the ancestor completely, even when its own
config says nothing about paths.

This is not hypothetical. A notes tree is rarely only notes: any folder in it that grew a small
Bun or TypeScript project has its own `tsconfig.json`, and every document beneath that folder is
then cut off from the ancestor mapping. One real tree measured on 2026-09-22 held **six** such
configs, none of them related to documents. Find yours:

```bash
find ~/Projects/notes -name tsconfig.json -not -path '*/node_modules/*'
```

`tools link status` detects this and names the file, because otherwise the failure looks like a
broken install rather than a shadowed one. It counts a file as a shadow only when it has no
mapping of ours and a config above it does. The warning reads:

```
/…/some-project/tsconfig.json is nearer, and carries no mapping of ours.
Bun reads only the nearest tsconfig, so that file hides the one above it.
tools link install --root /…/some-project
```

Running that command merges the mapping into that project's own config and keeps every other
setting and comment in it.

## For agents

- There is no `--json` output and no MCP tool. Read the `status` table.
- Exit codes: `status` always exits 0, so check the `RESOLVES` column, not the exit code.
  `install` exits 1 when it refuses (another checkout, an unreadable file, an `extends` without own `paths`),
  when the target is not a valid package, or when the Bun probe fails on an already-mapped root. `uninstall` exits 1 when it refuses.
- `tools json2md init`, `build` and `check` run the same check on a document module's import graph.
  When the package does not resolve, they print the matching command: `tools link install` under
  your home directory, `tools link install --root <folder>` outside it, and
  `tools link install --root <project>` when a nearer project tsconfig hides the mapping.
- The json2md skill ([SKILL.md](../../plugins/genesis-tools/skills/json2md/SKILL.md)) tells agents
  to run `tools link install` once per machine.
- Do not replace the bare import with an absolute path to `document-file.ts`. It works, and it
  commits a home directory into whatever repo the document lives in, so it runs on one machine only.

## Troubleshooting

- **`Cannot find package '@genesiscz/utils'` after `install`.** A nearer `tsconfig.json` hides the
  mapping. Run `tools link status` from the folder of the failing file: it names the file and
  prints `tools link install --root <that project>`.
- **That install says the config `extends another config`.** The project has `extends` and no `paths`
  of its own, so `install` refuses. The fix is in [install](#install).
- **A file in `/tmp` or on another volume still fails.** The home mapping does not reach outside
  your home directory. Run `tools link install --root <folder>`.
- **`dangling` in `status`.** The checkout was moved or deleted, or the mapping came from a
  worktree that is gone. Run `tools link install` from the checkout you keep. It repairs the
  mapping without `--force`.
- **`other checkout` in `status`.** The mapping names another GenesisTools checkout that still
  exists. Run `tools link install --force` from the checkout that should own it.
- **`current` but `RESOLVES` is `no`.** A nearer tsconfig cannot cause this row: the root's own
  file holds the mapping, so it is the nearest one. `status` reads only the `@genesiscz/utils/*` key, but the
  probe resolves the bare `@genesiscz/utils`, so a missing or edited bare key gives this row. Check that
  `<root>/tsconfig.json` has both keys (`@genesiscz/utils` mapped to `<checkout>/src/utils/index.ts`, and the `/*`
  key). Fix it with `tools link uninstall --root <root>` and then `tools link install --root <root>`, because
  `install` alone answers `Already mapped`. A probe that takes longer than 10 seconds also reads as `no`.
- **Loose scripts under your home directory stopped auto-installing their packages.** The first
  version of this tool put a `node_modules` symlink at the root, and an empty or near-empty
  `node_modules` disables Bun's auto-install for every file beneath it. `tools link uninstall`
  removes the symlink and the empty folders; run `tools link install` after it to keep the mapping.

## Design notes

### Rejected alternatives, each measured

Bun 1.4.2, macOS, 2026-09-22. None of these is a matter of taste.

- **A `node_modules` symlink at an ancestor.** Works, but an empty or near-empty `node_modules`
  disables Bun's auto-install for every file beneath it. Measured: `picocolors` resolved from
  `/tmp` and failed from the home directory. That silently breaks loose scripts that used to run.
  It was the first version of this tool, which is why `uninstall` still cleans it up.
- **A runtime `Bun.plugin` `onResolve` hook.** Never consulted for a bare specifier. Positive
  control: the same plugin's hook fired for a relative specifier in the same process, and `onLoad`
  fired for real files. This is
  [oven-sh/bun#12261](https://github.com/oven-sh/bun/issues/12261): the `could_be_plugin`
  pre-filter lets a specifier reach `onResolve` only when it has an extension or a namespace
  prefix. The fix, Bun PR #40398, was open and unmerged on 2026-09-22.
- **`bun link`.** Registers a package for a later `bun link <name>`. It puts nothing on the
  resolution path by itself.
- **Publishing to npm.** Works, and hands consumers a **snapshot** while the repo runs live code.
- **A loader with an alias option (`jiti`).** Works, but only for imports **we** perform.
  `bun doc.ts` never calls our loader, so it still fails. Both arms measured.
- **`NODE_PATH` pointing at a folder of symlinks.** Works on all four arms, and does **not** break
  auto-install. It loses because it must be in the environment before Bun starts, so it fails for
  anything not launched from your shell: an editor's run button, a launchd job, a GUI app.
- **A global `~/.bunfig.toml` with `preload`.** Bun's docs state that `bun run` and `bun <file>`
  never read the global bunfig.
- **`package.json` `"imports"` (the `#` prefix).** The only other ancestor-shaped mechanism, with
  the same walk-up shape as `paths`. It remaps **only** specifiers that start with `#`, so adopting
  it means rewriting every import site away from `@genesiscz/utils/...`.
- **`bun link`, `install.globalDir`, `workspace:`, `file:`.** All reduce to the same requirement: the
  consuming location needs its own `package.json` and `node_modules`.

The `jiti` arm decides it: the same file must work under `bun doc.ts` **and** under a GenesisTools
command. Only the tsconfig mapping satisfies both.

This list is meant to end the question. It was built from measurement first, then checked against
Bun's docs, its issue tracker and its resolver source. Treat a new suggestion as already answered
unless it comes with a run that contradicts one of these.

### Prior art and neighbours

- `src/scripts/lib/store.ts` (`ensureStoreScaffold`) already writes a `tsconfig.json` with `paths`
  at `~/.genesis-tools/scripts/`, and rewrites it when it no longer points at the current checkout.
  That self-healing idea is where the `Repaired a stale mapping` outcome came from.
- Two other places let code outside the repo reach repo code. Neither is wrong, and neither should
  move to this tool:
  - `src/artifact/lib/vite.ts` (`baseResolve`): a Vite `resolve.alias` entry. The files are served
    through a dev server, so the bundler resolves them.
  - `src/cmux/lib/capture-installer.ts` (`bundleRuntime`): a `Bun.build` `onResolve` plugin that
    redirects one import at bundle time. The output runs standalone, with no repo nearby.
- ⚠️ The build-time `onResolve` above works. The **runtime** one does not, as the list above
  records. They are different hooks despite the shared name.

### Not a licence to break plugin standalone-ness

`scripts/ci/check-plugin-standalone.ts` fails CI on any `@genesiscz/*` import under `plugins/**`,
because plugin files are copied out of this checkout and run where the repo is not nearby. Several
of them inline small helpers for exactly that reason. Do **not** use this mapping to justify an
import of the package there. The rule's value is that a plugin needs zero setup, and the plugin
cache folder is not a path we control.

### Other code that could hit the same failure

- `src/utils/json2md/document-file.ts` (`loadDocumentModule`): the case this tool was built for.
- `src/node-repl/lib/worker.ts`: the REPL can `import()` any absolute path. A single-file snippet
  is fine. An external multi-file module whose own imports use the bare specifier would hit it.

The logic lives in `src/utils/package-link.ts` (`@genesiscz/utils/package-link`), which json2md
also imports for its check.

## Related

- [json2md](../json2md/README.md): document modules, the main reason to run `tools link install`.
- [scripts](../scripts/README.md): its store writes a tsconfig `paths` scaffold of the same kind.
- [node-repl](../node-repl/README.md): can import external modules that hit the same failure.
