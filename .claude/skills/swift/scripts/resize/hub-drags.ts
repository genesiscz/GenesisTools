// Real-pointer drags of every hub resize edge, mode by mode, inside a "Stop touching" window. A drag counts only
// when the hub logged its own `hub.resize <panel>` line for it; otherwise it is MISSED (the pointer hit something
// else). Usage: bun hub-drags.ts [modes] [--pr <ref>] [--worktree <path>] [--settle <ms>] [--repeat <n>]
// Wait for the mode's loads first: PRs shows its threads list up to 40 s after the switch, 1.5 s on the main
// thread, and a drag inside that window measures the load (2026-10-29).
import { drag, dragLines, flag, focusHub, logSize, openHub, resizeEdges } from "./lib";

const modes = (process.argv[2]?.startsWith("--") ? undefined : process.argv[2])?.split(",") ?? [
    "worktrees",
    "prs",
    "inbox",
    "timeline",
    "agents",
    "sessions",
];
const opts = { pr: flag("--pr"), worktree: flag("--worktree") };
const settle = Number(flag("--settle") ?? 9000);
const repeat = Number(flag("--repeat") ?? 1);
let missed = 0;
for (const mode of modes) {
    openHub(mode, opts);
    await Bun.sleep(mode === "prs" ? Math.max(settle, 25_000) : settle);
    const edges = await resizeEdges();
    console.log(
        `## ${mode}: ${edges.map((e) => `${e.desc} @${e.x},${e.y} ${e.w}x${e.h}`).join("; ") || "no resize edges"}`
    );
    for (const e of edges) {
        const delta = e.w > e.h ? 140 : e.desc.includes("Files") ? -180 : 180;
        for (let k = 0; k < repeat; k++) {
            await focusHub();
            await Bun.sleep(600);
            const since = logSize();
            await drag(e, delta, 1.2, 1.2).exited;
            await Bun.sleep(1500);
            const got = dragLines(since);
            if (!got.step) {
                missed++;
            }
            console.log(
                `- ${e.desc}${repeat > 1 ? ` #${k + 1}` : ""}: ${got.step ?? "MISSED: no resize logged, the pointer hit something else"}`
            );
            if (got.release) {
                console.log(`    ${got.release}`);
            }
        }
    }
}
console.log(`missed ${missed}`);
