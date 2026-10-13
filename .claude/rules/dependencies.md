---
paths:
  - "package.json"
  - "**/package.json"
  - "bun.lock"
  - "bunfig.toml"
---

# Dependencies, bun.lock and node_modules

Loaded by Claude Code when you read, write or edit a `package.json`, `bun.lock` or `bunfig.toml`.

- **A conflicted `bun.lock` in a rebase: never union-merge it.** `git merge-file --union` plus `bun install` re-resolved 238 packages to newer versions than the branch had tested. Start from the branch's own lock (`git show :3:bun.lock > bun.lock`), keep the merged `package.json`, run `bun install`, then compare the resolved versions of both locks.
- **"Type X is not assignable to type X" between `node_modules/<pkg>` and `node_modules/.bun/<pkg>@…`** means a `bun install` flipped the lock's `configVersion` and left an isolated store behind. It is not a code problem: move `node_modules` aside and run `bun install --frozen-lockfile`.
- Editing `src/utils/package.json` needs a non-frozen `bun install` first, because `bun.lock` mirrors the workspace's peer ranges.
- **bun never prunes `node_modules`.** Neither `bun remove` nor `bun install` deletes a package folder whose `bun.lock` key is gone. A package that imports fine may not be in any `package.json`.
- **Installing an arbitrary or untrusted package version to read its files: always `--ignore-scripts`**, with every package manager. Its install scripts would otherwise run on this machine.
