import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairCodeResponseSchema } from "@genesiscz/utils/device-pairing/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { ADMIN_API, PUBLISH_API, PUBLISH_SERVER_HEADER } from "./api";
import { artifactKindServer, writeArtifactSnapshot } from "./kinds/artifact";
import { adminRequest, startPublishServer } from "./server";
import { type PublishTarget, PublishTargetSchema, resolveTargets } from "./targets";
import { PUBLISH_TRANSPORTS, TRANSPORT_KINDS, transportFor } from "./transports";
import { createPairedTransport, tokenPath } from "./transports/paired";
import { createSshRsyncTransport } from "./transports/ssh-rsync";
import type { SetupAsk } from "./transports/types";

const mac = PublishTargetSchema.parse({
    name: "mac",
    publicBase: "https://mac.example.com",
    transport: { kind: "mac-live", mounts: { md: "/share" } },
});
const remote = PublishTargetSchema.parse({
    name: "remote",
    publicBase: "https://share.example.com",
    transport: { kind: "ssh-rsync", host: "alice@host.example.com", dataDir: "/srv/shares" },
});
const ask: SetupAsk = async ({ flag }) => {
    throw new Error(`Unexpected prompt for --${flag}`);
};

describe("publish targets", () => {
    test("has one transport for each kind and each resolves its own page URL", () => {
        expect(TRANSPORT_KINDS).toEqual(["mac-live", "paired", "ssh-rsync"]);
        for (const kind of TRANSPORT_KINDS) {
            expect(PUBLISH_TRANSPORTS[kind].kind).toBe(kind);
        }

        expect(transportFor(mac).pageUrl({ target: mac, kind: "md", id: "fixture" })).toBe(
            "https://mac.example.com/share/fixture"
        );
        expect(transportFor(mac).pageUrl({ target: mac, kind: "artifact", id: "fixture" })).toBeNull();
        expect(transportFor(remote).pageUrl({ target: remote, kind: "artifact", id: "fixture" })).toBe(
            "https://share.example.com/artifact/fixture"
        );
    });

    test("selects the default, all targets, or the names given", () => {
        const targets = [mac, remote];
        expect(resolveTargets({ targets, names: [] })).toEqual([]);
        expect(resolveTargets({ targets, names: [], defaultTarget: "mac" })).toEqual([mac]);
        expect(resolveTargets({ targets, names: ["all"] })).toEqual(targets);
        expect(resolveTargets({ targets, names: ["remote", "remote"] })).toEqual([remote]);
        expect(() => resolveTargets({ targets, names: ["unknown"] })).toThrow('unknown publish target "unknown"');
    });

    test("allows plaintext pairing only on a private address", () => {
        const make = (url: string) =>
            PublishTargetSchema.safeParse({
                name: "remote",
                publicBase: "https://share.example.com",
                transport: {
                    kind: "paired",
                    url,
                    deviceId: "fixture",
                    token: { type: "secure", path: "fixture/token" },
                },
            });
        expect(make("http://10.0.0.5").success).toBe(true);
        expect(make("http://share.example.com").success).toBe(false);
        expect(make("not an origin").success).toBe(false);
        expect(make("https://share.example.com").success).toBe(true);
    });
});

describe("paired transport", () => {
    function dependencies(request: typeof fetch = fetch) {
        const stored = new Map<string, string>();
        const transport = createPairedTransport({
            fetch: request,
            resolveToken: async (ref) => stored.get(ref.path),
            secrets: async () => ({
                set: async (path, secret) => {
                    stored.set(path, secret);
                    return { type: "secure", path };
                },
                delete: async (path) => stored.delete(path),
            }),
        });
        return { stored, transport };
    }

    test("pairs, sends, lists, checks and removes through a loopback server", async () => {
        const root = await mkdtemp(join(tmpdir(), "publish-transport-"));
        const stateDir = join(root, "state");
        const server = await startPublishServer({
            kinds: [artifactKindServer],
            dataDir: join(root, "data"),
            stateDir,
            publicBase: "https://share.example.com/artifact",
            minFreeBytes: 0,
            port: 0,
            host: "127.0.0.1",
        });
        try {
            const { code } = PairCodeResponseSchema.parse(
                await adminRequest({ stateDir, path: ADMIN_API.pairCode, method: "POST" })
            );
            const { stored, transport } = dependencies();
            const target = await transport.setup({
                name: "remote",
                values: {
                    url: `${server.url}/artifact`,
                    code,
                    "device-name": "desk",
                    "public-base": "https://share.example.com",
                },
                ask,
            });
            const path = tokenPath("remote");
            expect(target).toMatchObject({
                name: "remote",
                publicBase: "https://share.example.com",
                transport: { kind: "paired", url: server.url, token: { type: "secure", path } },
            });
            const token = stored.get(path);
            expect(token).toStartWith("gtshare_");
            expect(SafeJSON.stringify(target)).not.toContain(token ?? "missing");

            const dir = join(root, "build");
            const id = "fixture";
            const location = { target, kind: "artifact", id };
            const html = "<title>Weekly report</title>";
            await writeArtifactSnapshot({
                dir,
                id,
                title: "Weekly report",
                sourceName: "report.html",
                html: new TextEncoder().encode(html),
            });
            expect(await transport.list(location)).toEqual([]);
            await transport.send({ ...location, dir });
            expect(await transport.list(location)).toEqual([id]);
            expect(transport.pageUrl(location)).toBe("https://share.example.com/artifact/fixture");
            expect(await (await fetch(new URL("/artifact/fixture", server.url))).text()).toBe(html);
            expect(await transport.check(target)).toEqual([
                { label: "Server health", ok: true, detail: `${server.url} serves artifact` },
                { label: "Paired device", ok: true, detail: expect.stringMatching(/^desk /) },
            ]);
            await transport.remove(location);
            await transport.remove(location);
            expect(await transport.list(location)).toEqual([]);
            await transport.forget(target);
            expect(stored.has(path)).toBe(false);
        } finally {
            await server.stop();
            await rm(root, { recursive: true, force: true });
        }
    });

    test("points old servers to setup and refuses public HTTP before consuming a code", async () => {
        const requested: string[] = [];
        const request = Object.assign(
            async (input: Parameters<typeof fetch>[0]) => {
                requested.push(String(input));
                return new Response("not found", {
                    status: 404,
                    headers: { [PUBLISH_SERVER_HEADER]: "genesis-tools" },
                });
            },
            { preconnect: fetch.preconnect }
        );
        const { transport, stored } = dependencies(request);
        const setup = (url: string) =>
            transport.setup({ name: "remote", values: { url, code: "CODE", "device-name": "desk" }, ask });
        await expect(setup("http://share.example.com")).rejects.toThrow("HTTP requires a private host");
        expect(requested).toEqual([]);
        await expect(setup("http://10.0.0.5/md")).rejects.toThrow("dev-dashboard share-server setup --role server");
        expect(requested).toEqual([`http://10.0.0.5${PUBLISH_API.pair}`]);
        expect(stored.size).toBe(0);
    });

    test("reads an old list response and forgets a migrated token path", async () => {
        const response = Object.assign(async () => Response.json({ slugs: ["old"] }), { preconnect: fetch.preconnect });
        const { transport, stored } = dependencies(response);
        const path = "old/remote/token";
        const target = PublishTargetSchema.parse({
            name: "remote",
            publicBase: "https://share.example.com",
            transport: {
                kind: "paired",
                url: "https://share.example.com",
                deviceId: "fixture",
                token: { type: "secure", path },
            },
        });
        stored.set(path, "test-token");
        expect(await transport.list({ target, kind: "md" })).toEqual(["old"]);
        await transport.forget(target);
        expect(stored.has(path)).toBe(false);
    });
});

test("ssh-rsync uses kind-scoped argv for sending, removing and listing", async () => {
    const calls: string[][] = [];
    const transport = createSshRsyncTransport({
        run: async (argv) => {
            calls.push(argv);
            return argv.includes("ls") ? "fixture\n.old\n_api\n" : "";
        },
    });
    const target: PublishTarget = remote;
    const location = { target, kind: "artifact", id: "fixture" };
    await transport.send({ ...location, dir: "/tmp/snapshot" });
    await transport.remove(location);
    expect(await transport.list(location)).toEqual(["fixture"]);
    expect(await transport.check(target)).toEqual([
        { label: "SSH data directory", ok: true, detail: "alice@host.example.com:/srv/shares" },
    ]);
    expect(calls.map((argv) => argv[0])).toEqual(["ssh", "rsync", "rsync", "ssh", "ssh", "ssh"]);
    expect(calls[0]?.slice(-4)).toEqual(["mkdir", "-p", "--", "/srv/shares/artifact"]);
    const destination = "alice@host.example.com:/srv/shares/artifact/fixture/";
    expect(calls[1]).toContain("--chmod=D755,F644");
    expect(calls[1]?.slice(-2)).toEqual(["/tmp/snapshot/", destination]);
    expect(calls[2]?.at(-1)).toBe(destination);
    expect(calls[3]?.slice(-3)).toEqual(["rmdir", "--", "/srv/shares/artifact/fixture"]);
    expect(calls[4]?.slice(-6)).toEqual(["ls", "-1", "--", "/srv/shares/artifact", ";", "fi"]);
    expect(calls[5]?.slice(-3)).toEqual(["test", "-d", "/srv/shares"]);
});
