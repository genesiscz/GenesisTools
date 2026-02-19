import { registerCommand } from "../dispatcher";
import { getDb } from "@app/automate/lib/db";
import { formatDuration } from "@app/utils/format";

registerCommand("tasks", async () => {
  const db = getDb();
  const runs = db.listRuns(10);

  if (runs.length === 0) return { text: "No runs recorded yet." };

  const lines = ["Recent runs:", ""];
  for (const r of runs) {
    const status = r.status === "success" ? "OK" : r.status === "error" ? "FAIL" : r.status.toUpperCase();
    const duration = r.duration_ms != null ? formatDuration(r.duration_ms) : "running";
    lines.push(`#${r.id} ${r.preset_name} [${status}] ${duration} (${r.trigger_type})`);
  }

  return { text: lines.join("\n") };
});
