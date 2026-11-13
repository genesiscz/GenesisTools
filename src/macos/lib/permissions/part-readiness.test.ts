import { describe, expect, test } from "bun:test";
import {
    ensureFaceReady,
    type FaceDeps,
    type FaceReadyPolicy,
    faceReadiness,
    openFace,
} from "@app/macos/lib/permissions/part-readiness";

interface Machine {
    built: boolean;
    stale: boolean;
    parts: string[];
}

function fakeDeps(machine: Machine, open: ReturnType<FaceDeps["open"]> = { status: 0, stderr: "" }) {
    const calls: string[] = [];
    const deps: FaceDeps = {
        status: () => {
            calls.push("status");
            return machine;
        },
        build: async (part) => {
            calls.push(`build ${part}`);
        },
        open: (args) => {
            calls.push(`open ${args.join(" ")}`);
            return open;
        },
    };
    return { deps, calls };
}

const EVERY_PART = ["features", "hub", "meetings", "recorder"];
const FACES = [
    { face: "--hub", part: "hub" },
    { face: "--meetings", part: "meetings" },
    { face: "--recorder", part: "recorder" },
] as const;

interface Case {
    name: string;
    machine: (part: string) => Machine;
    policy: FaceReadyPolicy;
    reason?: (part: string) => string;
    builds: boolean;
}

const CASES: Case[] = [
    {
        name: "not built, build allowed",
        machine: () => ({ built: false, stale: false, parts: [] }),
        policy: { build: "allow" },
        reason: () => "GenesisTools.app is not built",
        builds: true,
    },
    {
        name: "not built, build refused",
        machine: () => ({ built: false, stale: false, parts: [] }),
        policy: { build: "refuse" },
        reason: () => "GenesisTools.app is not built",
        builds: false,
    },
    {
        name: "stale, build allowed",
        machine: () => ({ built: true, stale: true, parts: EVERY_PART }),
        policy: { build: "allow" },
        reason: () => "GenesisTools.app is older than its Swift sources",
        builds: true,
    },
    {
        name: "stale, build refused",
        machine: () => ({ built: true, stale: true, parts: EVERY_PART }),
        policy: { build: "refuse" },
        reason: () => "GenesisTools.app is older than its Swift sources",
        builds: false,
    },
    {
        name: "stale, accepted as it is",
        machine: () => ({ built: true, stale: true, parts: EVERY_PART }),
        policy: { build: "refuse", stale: "accept" },
        builds: false,
    },
    {
        name: "part missing, build allowed",
        machine: (part) => ({ built: true, stale: false, parts: EVERY_PART.filter((id) => id !== part) }),
        policy: { build: "allow" },
        reason: (part) => `GenesisTools.app was built without the ${part} part`,
        builds: true,
    },
    {
        name: "part missing, build refused",
        machine: (part) => ({ built: true, stale: false, parts: EVERY_PART.filter((id) => id !== part) }),
        policy: { build: "refuse" },
        reason: (part) => `GenesisTools.app was built without the ${part} part`,
        builds: false,
    },
    {
        name: "ready",
        machine: () => ({ built: true, stale: false, parts: EVERY_PART }),
        policy: { build: "allow" },
        builds: false,
    },
];

describe("ensureFaceReady", () => {
    for (const { face, part } of FACES) {
        for (const row of CASES) {
            test(`${face}: ${row.name}`, async () => {
                const { deps, calls } = fakeDeps(row.machine(part));
                const result = await ensureFaceReady(face, row.policy, deps);
                const reason = row.reason?.(part);

                expect(calls).toEqual(row.builds ? ["status", `build ${part}`] : ["status"]);

                if (!reason) {
                    expect(result).toEqual({ ready: true, built: false });
                    return;
                }

                if (row.builds) {
                    expect(result).toEqual({ ready: true, built: true, reason });
                    return;
                }

                const command = `tools macos permissions build --add-part ${part}`;
                expect(result).toEqual({
                    ready: false,
                    reason,
                    command,
                    sentence: `${reason}, so nothing was started. Build it: ${command}`,
                });
            });
        }
    }

    test("a face's own reason counts as not ready once its part is in", async () => {
        const { deps, calls } = fakeDeps({ built: true, stale: false, parts: EVERY_PART });
        const check = () => "GenesisTools.app predates the review window; rebuild it";

        expect(await ensureFaceReady("--hub", { build: "allow", check }, deps)).toEqual({
            ready: true,
            built: true,
            reason: "GenesisTools.app predates the review window; rebuild it",
        });
        expect(calls).toEqual(["status", "build hub"]);
    });

    test("the build step names the reason and the part", async () => {
        const { deps } = fakeDeps({ built: true, stale: false, parts: ["features"] });
        const steps: string[] = [];

        await ensureFaceReady("--meetings", { build: "allow", onStep: (line) => steps.push(line) }, deps);
        expect(steps).toEqual([
            "GenesisTools.app was built without the meetings part: building it with the meetings part (about a minute on a cold build)",
        ]);
    });

    test("a face no part serves is a caller's mistake, refused before the machine is asked", () => {
        const { deps, calls } = fakeDeps({ built: true, stale: false, parts: EVERY_PART });

        expect(() => faceReadiness("--window", { build: "refuse" }, deps)).toThrow(
            "--window is not a face that a part of GenesisTools.app serves"
        );
        expect(calls).toEqual([]);
    });
});

describe("openFace", () => {
    test("a failed open throws with its message; a good one passes the arguments through", () => {
        const failed = fakeDeps({ built: true, stale: false, parts: [] }, { status: 1, stderr: "LSOpen failed\n" });

        expect(() => openFace(["-n", "/A.app"], failed.deps)).toThrow("open failed (1): LSOpen failed");

        const good = fakeDeps({ built: true, stale: false, parts: [] });
        openFace(["-n", "/A.app", "--args", "--hub"], good.deps);
        expect(good.calls).toEqual(["open -n /A.app --args --hub"]);
    });
});
