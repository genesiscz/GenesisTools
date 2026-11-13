#!/usr/bin/env bun
/**
 * Draws the GenesisKit component catalog: one PNG per component and look, and a manifest of them.
 *
 *   bun run kit:catalog -- --out <dir>                 every sheet and manifest.json into <dir>
 *   bun run kit:catalog -- --out <dir> --only tabs     one entry (no manifest)
 *   bun run kit:catalog -- --list                      the entries and their looks
 *   bun run kit:catalog -- --probe <png>               today's controls in a fixed layout, to compare before and after a change
 *
 * It builds the `genesis-kit-catalog` product of src/macos/GenesisKit and runs it. The command shows no window and
 * takes no focus. `--scratch <dir>` puts the build somewhere else than the package's own .build folder.
 *
 * The catalog itself is Swift: Sources/GenesisKitCatalog (KitCatalogEntries.swift holds the entries). A control added
 * to GenesisKit/Controls gets an entry there, or a line in KitCatalogTests with the reason it has none.
 */
import { resolve } from "node:path";

const kit = resolve(import.meta.dir, "../../src/macos/GenesisKit");
const args = process.argv.slice(2);
let scratch: string | undefined;
const scratchAt = args.indexOf("--scratch");
if (scratchAt >= 0) {
    scratch = args[scratchAt + 1];
    args.splice(scratchAt, 2);
}

const buildArgs = [
    "build",
    "--package-path",
    kit,
    "--product",
    "genesis-kit-catalog",
    ...(scratch ? ["--scratch-path", scratch] : []),
];
const build = Bun.spawn(["swift", ...buildArgs], { stdout: "pipe", stderr: "pipe" });
const [buildOut, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
]);
if (buildCode !== 0) {
    process.stderr.write(buildOut + buildErr);
    process.exit(buildCode);
}

const binPath = Bun.spawn(["swift", ...buildArgs, "--show-bin-path"], { stdout: "pipe", stderr: "inherit" });
const [binDir, binCode] = await Promise.all([new Response(binPath.stdout).text(), binPath.exited]);
if (binCode !== 0) {
    process.exit(binCode);
}

const run = Bun.spawn([`${binDir.trim()}/genesis-kit-catalog`, ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(await run.exited);
