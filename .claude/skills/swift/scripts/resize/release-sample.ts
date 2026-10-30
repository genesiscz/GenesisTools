// One real drag of a named resize edge with `sample` on the hub around the release, so the release's busy time
// (`…release main busy N ms`) gets a stack. The drag goes out over 2.4 s and back in 0.1 s, so the release lands
// about 2.5 s after the mouse-down; sampling starts at 2.3 s for 1 s. Read the file with sample-who.ts.
// Usage: bun release-sample.ts <mode> <edge label> <delta pt> <out file> [--settle <ms>] [--pr <ref>] [--worktree <path>]
import { drag, dragLines, flag, focusHub, hubPid, logSize, openHub, resizeEdges } from "./lib";

const [mode, edgeName, deltaArg, out] = process.argv.slice(2);
const opts = { pr: flag("--pr"), worktree: flag("--worktree") };
openHub(mode, opts);
await Bun.sleep(Number(flag("--settle") ?? (mode === "prs" ? 25_000 : 6000)));
const e = (await resizeEdges()).find((x) => x.desc === edgeName);
if (!e) {
    console.log(`no edge "${edgeName}" in ${mode}`);
    process.exit(1);
}
focusHub();
await Bun.sleep(500);
const since = logSize();
const run = drag(e, Number(deltaArg), 2.4, 0.1);
await Bun.sleep(2300);
const sample = Bun.spawn(["sample", await hubPid(), "1", "1", "-mayDie", "-file", out], {
    stdout: "ignore",
    stderr: "ignore",
});
await run.exited;
await sample.exited;
await Bun.sleep(1200);
const got = dragLines(since);
console.log(`- ${mode} ${edgeName}: ${got.step ?? "MISSED"}`);
if (got.release) {
    console.log(`    ${got.release}`);
}
console.log(`    sample: ${out}`);
