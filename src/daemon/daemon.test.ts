import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("daemon SIGTERM shutdown ordering", () => {
    test("PID file stays present until the scheduler loop has actually drained", async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), "daemon-test-"));
        const proc = Bun.spawn(["bun", "run", "src/daemon/daemon.ts"], {
            env: { ...process.env, GENESIS_TOOLS_DAEMON_DIR: tmpDir },
        });

        await new Promise((r) => setTimeout(r, 500));
        const pidFile = `${tmpDir}/daemon.pid`;
        expect(existsSync(pidFile)).toBe(true);

        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 50));

        expect(existsSync(pidFile)).toBe(true);

        await proc.exited;
        expect(existsSync(pidFile)).toBe(false);
    });
});
