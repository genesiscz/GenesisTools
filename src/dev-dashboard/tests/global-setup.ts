import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates (and truncates) a run-scoped file for tracking created board slugs, then shares its
 *  path with worker processes via PW_RUN_SLUGS_FILE. boards-test-api.ts's freshBoard() appends
 *  every slug it creates; global-teardown.ts reads the file back to archive only the boards THIS
 *  run created — not every "pw-*" board on the shared singleton dev-dashboard server. */
export default async function globalSetup(): Promise<void> {
    const file = join(tmpdir(), `pw-board-slugs-${Date.now()}-${process.pid}.txt`);
    await Bun.write(file, "");
    process.env.PW_RUN_SLUGS_FILE = file;
}
