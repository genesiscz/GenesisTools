#!/usr/bin/env bun
// Build the deterministic clone fixture used by clone-controls.test.ts into a
// directory, so `tools du bench <dir>/a-noclones` and friends measure the same
// trees the tests pin. Usage: bun scripts/benchmarks/du/make-fixture.ts <dir> [--big]
import { existsSync, mkdirSync } from "node:fs";
import { makeCloneFixture } from "@app/du/lib/clone-fixture";

const dir = process.argv[2];
if (!dir) {
    console.error("usage: make-fixture.ts <dir> [--big]");
    process.exit(2);
}

if (existsSync(dir)) {
    console.error(`${dir} exists; pick a fresh directory so the fixture is exactly what the tests describe`);
    process.exit(2);
}

mkdirSync(dir, { recursive: true });
const big = process.argv.includes("--big");
const fx = makeCloneFixture(
    dir,
    big ? { files: 20000, clones: 5, copies: 8, filesPerTree: 400, fileBytes: 512 * 1024 } : {}
);
console.log(`root         ${fx.root}`);
console.log(`a-noclones   ${fx.noClones.dir}  files=${fx.noClones.files}  logical=${fx.noClones.logicalBytes}`);
console.log(`b-realclones ${fx.realClones.dir}  base=${fx.realClones.baseBytes}  clones=${fx.realClones.clones}`);
console.log(
    `c-worktrees  ${fx.worktrees.dir}  copies=${fx.worktrees.copies}  filesPerTree=${fx.worktrees.filesPerTree}  fileBytes=${fx.worktrees.fileBytes}`
);
