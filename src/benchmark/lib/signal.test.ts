import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readProcessCommand } from "@genesiscz/utils/process-identity";
import { signalVerified, stillRuns } from "./signal";

/**
 * Our own pid is the one number guaranteed live for the whole test, so a wrong expectation
 * against it IS the recycled shape: the number is occupied, the program is not the one the
 * caller resolved.
 */
const FOREIGN_COMMAND = "/usr/libexec/definitely-not-this-process --serve";

// `ps` is how identity is read, and there is none on Windows.
const noPs = process.platform === "win32";

const realKill = process.kill.bind(process);

interface KillSpy {
    /** Every real signal that reached `process.kill`, in order. */
    sent: { pid: number; signal: string | number | undefined }[];
}

/**
 * Replace `process.kill` for one test. Signal 0 is the liveness probe `classifyPid` runs
 * FIRST, so it goes through to the kernel; every real signal is recorded and, with `refuse`
 * set, thrown on, so a path that reaches the kill fails loudly instead of passing quietly.
 */
function spyKill(refuse?: Error): KillSpy {
    const spy: KillSpy = { sent: [] };

    spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number): true => {
        if (signal === 0) {
            return realKill(pid, 0);
        }

        spy.sent.push({ pid, signal });

        if (refuse) {
            throw refuse;
        }

        return true;
    });

    return spy;
}

describe("signalVerified", () => {
    afterEach(() => {
        mock.restore();
    });

    test.skipIf(noPs)("a live pid running a different command than recorded is foreign and never signalled", () => {
        const kill = spyKill(new Error("process.kill reached for a pid that failed the identity check"));

        const outcome = signalVerified(process.pid, FOREIGN_COMMAND, "SIGTERM");

        expect(outcome.sent).toBe(false);
        expect(outcome.identity.status).toBe("foreign");
        expect(kill.sent).toEqual([]);
    });

    test.skipIf(noPs)("a live pid whose command matches the one recorded is signalled exactly once", () => {
        const kill = spyKill();
        const own = readProcessCommand(process.pid);

        expect(own).not.toBeNull();

        if (own === null) {
            return;
        }

        const outcome = signalVerified(process.pid, own, "SIGTERM");

        expect(outcome).toEqual({ sent: true, identity: { status: "live", pid: process.pid, command: own } });
        expect(kill.sent).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
    });

    test.skipIf(noPs)("a predicate expectation gates the signal the same way", () => {
        const kill = spyKill();

        expect(signalVerified(process.pid, () => false, "SIGKILL").sent).toBe(false);
        expect(kill.sent).toEqual([]);
        expect(signalVerified(process.pid, () => true, "SIGKILL").sent).toBe(true);
        expect(kill.sent).toEqual([{ pid: process.pid, signal: "SIGKILL" }]);
    });

    test.skipIf(noPs)(
        "a kill that throws is reported, not thrown: the pid exited between the read and the signal",
        () => {
            const gone = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
            const kill = spyKill(gone);

            const outcome = signalVerified(process.pid, () => true, "SIGTERM");

            expect(outcome.sent).toBe(false);
            expect(outcome.error).toBe(gone);
            expect(kill.sent).toHaveLength(1);
        }
    );
});

describe("stillRuns", () => {
    test.skipIf(noPs)("true only while the pid runs the expected command", () => {
        const own = readProcessCommand(process.pid);

        expect(own).not.toBeNull();
        expect(stillRuns(process.pid, own ?? "")).toBe(true);
        expect(stillRuns(process.pid, FOREIGN_COMMAND)).toBe(false);
    });
});
