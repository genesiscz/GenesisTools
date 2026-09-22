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

⚠️ A `Bun.plugin` `onResolve` hook does **not** help. Measured 2026-09-22: resolution happens
before a runtime plugin sees the specifier, and the hook is never called for this case.

## The fix

Ordinary node resolution walks **up** from the importing file looking for
`node_modules/<package>`. One symlink at an ancestor directory therefore answers for every file
beneath it, under plain `bun` exactly as under a tool.

```bash
tools link install              # link under your home directory
tools link install --root DIR   # narrower blast radius
tools link status               # is it installed, and does the import actually resolve
tools link uninstall            # remove it
```

---

## Commands

| Command | What it does |
|---|---|
| `tools link status` | Default. Reports the link and whether the import resolves, for the home directory and the current one |
| `tools link install` | Creates `<root>/node_modules/@genesiscz/utils` pointing at this checkout |
| `tools link uninstall` | Removes it |

| Option | Applies to | Description |
|---|---|---|
| `--root <dir>` | all | Directory to act on. Defaults to the home directory |
| `--force` | install, uninstall | Act on a symlink pointing at a **different** checkout |

---

## What it will not do

- 🛑 **Never replaces a real directory.** If `node_modules/@genesiscz/utils` is an installed
  dependency rather than a symlink, it is reported and left alone.
- 🛑 **Never repoints another checkout's link** without `--force`. Silently moving it would
  move every consumer under that root onto a different tree.
- 🛑 **Never removes a link it did not create** without `--force`.

---

## Reading the status table

`LINK` and `RESOLVES` are independent on purpose:

| LINK | RESOLVES | Means |
|---|---|---|
| `current` | `yes` | Installed and working |
| `absent` | `yes` | A nearer `node_modules` already provides it — a repo that depends on it normally |
| `absent` | `no` | Nothing here; `tools link install` |
| `current` | `no` | The link exists but something nearer shadows it |
| `other checkout` | either | Points at a different GenesisTools; `--force` to repoint |
| `occupied` | either | A real directory is there. Not ours to touch |

---

## ⚠️ What installing at the home directory means

Every file under that root that imports `@genesiscz/utils` and has no nearer `node_modules`
entry will now resolve it, including projects that previously failed. That can mask a genuinely
missing dependency in an unrelated project. Use `--root` to narrow it when that matters — the
vault, or one project tree, rather than the whole home directory.

The link points at the checkout the command was run from. Move that checkout and the link
dangles; `tools link status` reports it and `tools link install` repairs it.
