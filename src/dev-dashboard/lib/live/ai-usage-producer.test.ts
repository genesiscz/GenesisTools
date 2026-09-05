import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type SnapshotsCacheProvider,
    snapshotsCachePath,
    writeSnapshotsCache,
} from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { __resetUsagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { createAiUsageProducer } from "./ai-usage-producer";
import { createLiveHub } from "./hub";
import type { LiveFrame } from "./types";

const cleanups: Array<() => void> = [];

function useTempHome(): void {
    const home = mkdtempSync(join(tmpdir(), "dd-ai-usage-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    __resetUsagePollStorage();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }

    env.testing.unset("GENESIS_TOOLS_HOME");
    __resetUsagePollStorage();
});

function mockEmit() {
    const frames: LiveFrame[] = [];

    return {
        frames,
        emit: {
            data: (payload: string) => {
                frames.push(SafeJSON.parse(payload, { strict: true }) as LiveFrame);
            },
            comment: () => {},
        },
    };
}

/** Invented handles, never a live account name. */
function slice(accountName: string): SnapshotsCacheProvider {
    return {
        alias: "claude",
        displayName: "Claude",
        prominent: ["five_hour"],
        accounts: [
            {
                provider: "anthropic-sub",
                accountId: `acc_${accountName}`,
                accountName,
                fetchedAt: "2026-09-04T12:00:00.000Z",
                limits: [{ key: "five_hour", label: "5h", kind: "session", percentUsed: 12 }],
            },
        ],
    };
}

function usageFrames(frames: LiveFrame[]) {
    return frames.filter((frame) => frame.channel === "ai-usage");
}

describe("ai-usage producer", () => {
    test("publishes the cache once, then only after the file changes", async () => {
        useTempHome();
        const hub = createLiveHub();
        const client = mockEmit();
        hub.open(client.emit, ["ai-usage"]);
        const producer = createAiUsageProducer(hub);

        await writeSnapshotsCache({ "anthropic-sub": slice("work") }, new Date("2026-09-04T12:00:00.000Z"));
        await producer.tick();

        expect(usageFrames(client.frames)).toHaveLength(1);
        expect(usageFrames(client.frames)[0]).toMatchObject({
            v: 1,
            channel: "ai-usage",
            type: "snapshot",
            payload: { fetchedAt: "2026-09-04T12:00:00.000Z" },
        });

        // Same file, same stamp: a second tick must stay silent.
        await producer.tick();
        expect(usageFrames(client.frames)).toHaveLength(1);

        await writeSnapshotsCache(
            { "anthropic-sub": slice("work"), "grok-sub": slice("personal") },
            new Date("2026-09-04T12:00:30.000Z")
        );
        await producer.tick();

        const latest = usageFrames(client.frames).at(-1);
        expect(usageFrames(client.frames)).toHaveLength(2);
        expect(latest).toMatchObject({ payload: { fetchedAt: "2026-09-04T12:00:30.000Z" } });
        expect((latest as { payload: { snapshots: unknown[] } }).payload.snapshots).toHaveLength(2);

        producer.stop();
        hub._reset();
    });

    test("a missing cache file publishes nothing and does not throw", async () => {
        useTempHome();
        const hub = createLiveHub();
        const client = mockEmit();
        hub.open(client.emit, ["ai-usage"]);
        const producer = createAiUsageProducer(hub);

        expect(snapshotsCachePath()).toContain("ai-usage");
        await producer.tick();
        expect(usageFrames(client.frames)).toHaveLength(0);

        // Negative control: the same producer publishes as soon as the file appears.
        await writeSnapshotsCache({ "anthropic-sub": slice("shop") });
        await producer.tick();
        expect(usageFrames(client.frames)).toHaveLength(1);

        producer.stop();
        hub._reset();
    });

    test("no subscriber means no read at all", async () => {
        useTempHome();
        const hub = createLiveHub();
        let reads = 0;
        const producer = createAiUsageProducer(hub, {
            readCache: async () => {
                reads += 1;
                return { fetchedAt: "2026-09-04T12:00:00.000Z", snapshots: [] };
            },
        });

        await writeSnapshotsCache({ "anthropic-sub": slice("side") });
        await producer.tick();

        expect(reads).toBe(0);

        producer.stop();
        hub._reset();
    });
});
