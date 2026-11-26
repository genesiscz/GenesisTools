import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { artifactKind, writeArtifactSnapshot } from "@genesiscz/utils/publish/kinds/artifact";
import type { PublishTarget } from "@genesiscz/utils/publish/targets";
import { publisher } from "./publisher";
import {
    loadPublishConfig,
    migratePublishConfig,
    PublishConfigSchema,
    publicationsPath,
    updatePublishConfig,
} from "./store";

let dir: string;
let prevHome: string | undefined;

beforeEach(async () => {
    prevHome = env.get("GENESIS_TOOLS_HOME");
    dir = await mkdtemp(join(tmpdir(), "publish-ledger-"));
    env.testing.set("GENESIS_TOOLS_HOME", dir);
});

afterEach(async () => {
    if (prevHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", prevHome);
    }

    await rm(dir, { recursive: true, force: true });
});

test("a successful send writes one sync record and a failed target leaves its outcome", async () => {
    expect(await loadPublishConfig()).toEqual(PublishConfigSchema.parse(migratePublishConfig({})));
    const targets: PublishTarget[] = [
        {
            name: "live",
            publicBase: "https://live.example.com",
            transport: { kind: "mac-live", mounts: { artifact: "/preview" } },
        },
        {
            name: "unpaired",
            publicBase: "https://share.example.com",
            transport: {
                kind: "paired",
                url: "https://share.example.com",
                deviceId: "fixture",
                token: { type: "secure", path: "fixture/missing-token" },
            },
        },
    ];
    await updatePublishConfig((config) => ({ ...config, client: { defaults: { target: "live" }, targets } }));
    const artifacts = publisher(artifactKind);
    const source = join(dir, "weekly.html");
    const title = "Weekly report";
    const sourceModifiedAt = "2026-01-01T00:00:00.000Z";
    let builds = 0;
    const result = await artifacts.publish({
        source,
        title,
        sourceModifiedAt,
        targetNames: ["unpaired", "live"],
        build: async ({ dir, id }) => {
            builds++;
            await writeArtifactSnapshot({ dir, id, title, sourceName: "weekly.html", html: new Uint8Array() });
        },
    });
    expect(builds).toBe(1);
    expect(result.outcomes).toEqual([
        { target: "unpaired", error: 'publish target "unpaired" has no token in the vault; pair it again' },
        { target: "live", url: `https://live.example.com/preview/${result.id}` },
    ]);
    const stored = SafeJSON.parse(await readFile(publicationsPath(), "utf8"));
    expect(stored).toEqual({
        version: 1,
        publications: [
            {
                kind: "artifact",
                id: result.id,
                source,
                title,
                publishedAt: expect.any(String),
                syncs: { live: { syncedAt: expect.any(String), sourceModifiedAt } },
            },
        ],
    });
    expect(await artifacts.find({ source })).toEqual(stored.publications[0]);
    expect(await artifacts.unpublish({ id: result.id, targetNames: [] })).toEqual([{ target: "live" }]);
    expect(SafeJSON.parse(await readFile(publicationsPath(), "utf8"))).toEqual({ version: 1, publications: [] });
});
