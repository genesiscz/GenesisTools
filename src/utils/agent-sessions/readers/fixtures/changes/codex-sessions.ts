import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { at, type Fixture, fixture, jsonl, type Line, row } from "./claude-sessions";

export function codexFixture(): Fixture {
    const f = fixture("20000000-1111-4111-8111-111111111111", 7);
    const dir = join(f.home, "sessions", "2026", "01", "02");
    mkdirSync(dir, { recursive: true });
    const records: Line[] = [];
    const file = join(f.home, "file");
    const moved = join(f.home, "moved");
    const patch = (turn: number, id: string, path: string, change: Line) => ({
        type: "event_msg",
        timestamp: at(turn * 10 + 1),
        payload: {
            type: "item_completed",
            turn_id: `p${turn}`,
            item: { type: "FileChange", id, changes: { [path]: change } },
        },
    });
    for (let i = 1; i <= f.turns; i++) {
        records.push({ type: "event_msg", timestamp: at(i * 10), payload: { type: "task_started", turn_id: `p${i}` } });
        if (i === 1 || i === 3) {
            records.push({ type: "turn_context", payload: { cwd: i === 1 ? "/work/acme" : "/work/acme-tools" } });
        }
        if (i === 1) {
            records.push(patch(1, "create", file, { type: "add", content: "old\n" }));
        } else if (i === 4) {
            records.push(patch(2, "edit", file, { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new\n" }));
        } else if (i === 5) {
            records.push(
                patch(5, "move", file, {
                    type: "update",
                    move_path: moved,
                    unified_diff: "@@ -1 +1 @@\n-new\n+moved\n",
                })
            );
        } else if (i === 7) {
            records.push(patch(7, "delete", moved, { type: "delete", content: "moved\n" }));
        }
    }
    f.transcript = join(dir, `rollout-2026-01-02-${f.session}.jsonl`);
    writeFileSync(f.transcript, `${jsonl(records)}\n`);
    f.rows.push(row(f, "p6", "/work/acme/shell", 62, "shell"));
    return f;
}
