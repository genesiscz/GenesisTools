import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { artifactKind, writeArtifactSnapshot } from "@genesiscz/utils/publish/kinds/artifact";
import type { PublishTarget } from "@genesiscz/utils/publish/targets";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { publisher } from "./publisher";
import {
    loadShareConfig,
    migrateShareConfig,
    publicationsPath,
    resolveServer,
    type ShareConfig,
    ShareConfigSchema,
    type ShareServerConfig,
    shareConfigPath,
    shareServerDir,
    updateShareConfig,
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

test("reads an old publish store without writing, then saves version 2 under share", async () => {
    const empty: ShareConfig = { version: 2, defaults: {}, targets: [], servers: [] };
    expect(migrateShareConfig({})).toEqual(empty);
    expect(await loadShareConfig()).toEqual(empty);
    expect(await Bun.file(shareConfigPath()).exists()).toBe(false);

    const path = toolDataDir("publish", "config.json");
    const target: PublishTarget = {
        name: "desk",
        publicBase: "https://mac.example.com",
        transport: { kind: "mac-live", mounts: { md: "/share" } },
    };
    const old = SafeJSON.stringify({ version: 1, client: { defaults: { target: "desk" }, targets: [target] } });
    await mkdir(toolDataDir("publish"), { recursive: true });
    await writeFile(path, old);
    const expected = { ...empty, defaults: { target: "desk" }, targets: [target] };
    expect(await loadShareConfig()).toEqual(expected);
    expect(await Bun.file(shareConfigPath()).exists()).toBe(false);
    await updateShareConfig((config) => config);
    expect(SafeJSON.parse(await readFile(shareConfigPath(), "utf8"))).toEqual(expected);
    expect(await readFile(path, "utf8")).toBe(old);
});

test("selects the named, default or only configured server and explains an empty config", async () => {
    const dirFor = shareServerDir("desk", "data");
    expect(dirFor).toBe(join(dir, ".genesis-tools", "share", "servers", "desk", "data"));

    const desk: ShareServerConfig = {
        name: "desk",
        dataDir: dirFor,
        stateDir: shareServerDir("desk", "state"),
        listen: { host: "127.0.0.1", port: 3044 },
        publicOrigin: "https://share.example.com",
        kinds: ["md", "artifact"],
        minFreeGb: 2,
        exposure: { kind: "local" },
        service: { manager: "none" },
    };
    const relay = { ...desk, name: "relay" };
    const base = await loadShareConfig();
    expect(() => resolveServer(base)).toThrow("share-server setup");
    expect(resolveServer({ ...base, servers: [desk] })).toEqual(desk);
    expect(resolveServer({ ...base, servers: [desk, relay], defaults: { server: "desk" } })).toEqual(desk);
    expect(resolveServer({ ...base, servers: [desk, relay], defaults: { server: "desk" } }, "relay")).toEqual(relay);
});

test("a successful send writes one sync record and a failed target leaves its outcome", async () => {
    expect(await loadShareConfig()).toEqual(ShareConfigSchema.parse(migrateShareConfig({})));
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
    await updateShareConfig((config) => ({ ...config, defaults: { target: "live" }, targets }));
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
