// One real drag of a named resize edge in the live hub, with window captures every 60 ms while it runs, so the
// dragged panel's far edge can be judged frame by frame (does right-aligned content jump or get cut?).
// Usage: bun drag-frames.ts <mode> <edge label prefix> <delta pt> <out dir> [--pr <ref>] [--worktree <path>]
import { mkdirSync } from "node:fs";
import { control, drag, dragGeometry, flag, focusHub, openHub, resizeEdges } from "./lib";

const [mode, edgeName, deltaArg, out] = process.argv.slice(2);
const opts = { pr: flag("--pr"), worktree: flag("--worktree") };
mkdirSync(out, { recursive: true });
openHub(mode, opts);
await Bun.sleep(mode === "prs" ? 25_000 : 6000);
const e = (await resizeEdges()).find((x) => x.desc.startsWith(edgeName));
if (!e) {
    console.log(`no edge "${edgeName}" in ${mode}`);
    process.exit(1);
}
const g = dragGeometry(e);
console.log(
    `${e.desc} @${e.x},${e.y} ${e.w}x${e.h}; drag ${g.vertical ? "y" : "x"} from ${g.across} by ${deltaArg} over 2.4 s`
);
await focusHub();
await Bun.sleep(500);
const run = drag(e, Number(deltaArg), 2.4, 0.1);
const started = Date.now();
let n = 0;
while (Date.now() - started < 2300) {
    await control([
        "screenshot",
        "--app",
        "GenesisTools",
        "--path",
        `${out}/f${String(n).padStart(2, "0")}-${Date.now() - started}ms.png`,
    ]);
    n++;
    await Bun.sleep(60);
}
await run.exited;
console.log(`${n} frames in ${out}`);
