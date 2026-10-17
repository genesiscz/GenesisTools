import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendGateAudit, gatesAuditPath } from "@genesiscz/utils/audit/gates";
import { defaultRouterConfig, route } from "@genesiscz/utils/browser-router/route";
import { env } from "@genesiscz/utils/env";
import { parseJSON, SafeJSON } from "@genesiscz/utils/json";
import {
    appendAudit,
    auditPath,
    findGrant,
    grantsPath,
    listGrants,
    listVaultGrants,
    readAuditTail,
    rememberGrant,
    revokeGrants,
    revokeVaultGrants,
    vaultGrantsPath,
} from "./grants";
import type { ClientIdentity, GateGrant } from "./types";

const identity: ClientIdentity = {
    name: "pi",
    pid: 700,
    executable: "node",
    script: "/tmp/pi",
    command: "node pi",
    cwd: "/tmp",
    ancestors: [],
    key: "k-pi-node",
    isAncestor: true,
    injected: [],
    verified: true,
};

/** Writes prune expired grants against the real clock, so every fixture lives in the future. */
const NOW = Date.now();
const T = (seconds: number) => NOW + seconds * 1000;

function grant(overrides: Partial<GateGrant> = {}): GateGrant {
    return {
        key: identity.key,
        clientName: "pi",
        executable: "node",
        provider: "anthropic-sub",
        accountId: "acc_a",
        accountName: "alice",
        grantedAt: NOW,
        until: T(60),
        method: "touch-id",
        tokenKind: "long-lived",
        ...overrides,
    };
}

const lookup = (overrides: Partial<Parameters<typeof findGrant>[0]> = {}) =>
    findGrant({
        identity,
        provider: "anthropic-sub",
        accountId: "acc_a",
        tokenKind: "long-lived",
        now: NOW,
        ...overrides,
    });

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-test-home-gate-")));
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("grants", () => {
    test("Swift's omitted nil expiry is normalized and remains visible until revoked", async () => {
        const base = {
            key: "vault|ai|bun|daemon.ts",
            tool: "ai",
            executable: "/bin/bun",
            script: "/repo/daemon.ts",
            grantedAt: NOW,
            method: "touch-id",
        };
        mkdirSync(dirname(vaultGrantsPath()), { recursive: true });
        writeFileSync(
            vaultGrantsPath(),
            SafeJSON.stringify({
                version: 1,
                grants: [
                    base,
                    { ...base, key: "explicit", until: null },
                    { ...base, key: "timed", until: T(60) },
                    { ...base, key: "expired", until: NOW - 1 },
                ],
            })
        );

        expect(listVaultGrants(NOW).map((item) => [item.key, item.until])).toEqual([
            [base.key, null],
            ["explicit", null],
            ["timed", T(60)],
        ]);
        expect(await revokeVaultGrants(base.key)).toBe(1);
        expect(listVaultGrants(NOW).map((item) => item.key)).toEqual(["explicit", "timed"]);
    });

    test("vault revocation preserves malformed input before recovering, while listing stays read-only", async () => {
        const file = vaultGrantsPath();
        const dir = dirname(file);
        mkdirSync(dir, { recursive: true });
        for (const planted of [
            "{not valid json",
            SafeJSON.stringify({ version: 1, grants: {} }),
            SafeJSON.stringify({ version: 1 }),
            SafeJSON.stringify({ version: 2, grants: [] }),
            SafeJSON.stringify({ version: 1, grants: [null] }),
        ]) {
            writeFileSync(file, planted);
            const before = new Set(readdirSync(dir));
            expect(listVaultGrants(NOW)).toEqual([]);
            expect(readFileSync(file, "utf8")).toBe(planted);
            expect(readdirSync(dir).filter((name) => !before.has(name))).toEqual([]);
            expect(await revokeVaultGrants("work")).toBe(0);
            const copies = readdirSync(dir).filter(
                (name) => name.startsWith("vault-grants.json.corrupt-") && !before.has(name)
            );
            expect(copies).toHaveLength(1);
            expect(readFileSync(join(dir, copies[0]), "utf8")).toBe(planted);
            expect(parseJSON<{ version: 1; grants: unknown[] }>(readFileSync(file, "utf8"))).toEqual({
                version: 1,
                grants: [],
            });
            expect(statSync(file).mode & 0o777).toBe(0o600);
        }
    });

    test("revocation observes the native writer's bare PID lock and reloads after it releases", async () => {
        const file = vaultGrantsPath();
        const lock = `${file}.lock`;
        const base = { key: "old", tool: "ai", executable: "/bin/bun", grantedAt: NOW, method: "touch-id" };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, SafeJSON.stringify({ version: 1, grants: [base] }));
        writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
        let finished = false;
        const revoke = revokeVaultGrants("*").then((removed) => {
            finished = true;
            return removed;
        });
        await Bun.sleep(100);
        expect(finished).toBe(false);
        // The native transaction publishes a second grant before releasing the same O_EXCL lock.
        writeFileSync(file, SafeJSON.stringify({ version: 1, grants: [base, { ...base, key: "new" }] }));
        unlinkSync(lock);
        expect(await revoke).toBe(2);
        expect(listVaultGrants(NOW)).toEqual([]);
    });

    test("both audit trails redact argv credentials and command help text", async () => {
        const token = "fixture-secret-never-real";
        const client = {
            ...identity,
            command: `tools claude config add work --token ${token}`,
            argv: ["tools", "claude", "config", "add", "work", `--api-key=${token}`],
        };
        await appendAudit({
            at: "2026-09-23T00:00:00Z",
            event: "prompted",
            client,
            detail: `purpose: run tools claude config add work --token ${token}`,
        });
        appendGateAudit({
            gate: "vault",
            event: "prompted",
            shown: {
                purpose: `run tools claude --token=${token}`,
                facts: [{ label: "Command", help: `tools claude --password "${token}"` }],
            },
        });
        for (const file of [auditPath(), gatesAuditPath()]) {
            const text = readFileSync(file, "utf8");
            expect(text).not.toContain(token);
            expect(text).toContain("[REDACTED]");
            expect(text).toContain("config add work");
        }
    });

    test("gate audit URLs redact userinfo, credential queries and encoded command payloads", () => {
        const token = "fixture'url-secret";
        const query = new URLSearchParams({
            token,
            api_key: token,
            prompt: `tools claude --token ${token}`,
            safe: "kept",
        });
        const url = `https://fixture-user:${token}@example.com/run?${query}`;
        const nested = `https://example.com/open?next=${encodeURIComponent(url)}`;
        const callback = `genesis://oauth/callback#access_token=${encodeURIComponent(token)}&state=kept-state`;
        appendGateAudit({ gate: "link-command", event: "denied", link: url, url: nested, open: [url, callback] });
        const text = readFileSync(gatesAuditPath(), "utf8");
        expect(text).not.toContain(token);
        expect(text).not.toContain("fixture-user");
        expect(text).not.toContain("url-secret");
        expect(text).not.toContain(encodeURIComponent(`tools claude --token ${token}`));
        expect(text).toContain("safe=kept");
        expect(text).toContain("state=kept-state");
        expect(text).toContain("example.com");
        expect(text).toContain("REDACTED");
    });

    test("expanded HTTP header credentials are redacted from argv and rendered command facts", () => {
        const token = "fixture-header-secret-never-real";
        const headers = [
            ["Authorization: Bearer {token}", "Authorization: Bearer [REDACTED]"],
            ["authorization:Basic {token}", "authorization:Basic [REDACTED]"],
            ["Proxy-Authorization: Basic {token}", "Proxy-Authorization: Basic [REDACTED]"],
            ["pRoXy-AuThOrIzAtIoN:Bearer {token}", "pRoXy-AuThOrIzAtIoN:Bearer [REDACTED]"],
            ["Authorization:{token}", "Authorization:[REDACTED]"],
            ["X-Api-Key:{token}", "X-Api-Key:[REDACTED]"],
            ["x-aUtH-tOkEn: {token}", "x-aUtH-tOkEn: [REDACTED]"],
            ["X-Client-Secret: {token}", "X-Client-Secret: [REDACTED]"],
            ["Cookie:session={token}; other={token}", "Cookie:[REDACTED]"],
            ["Set-Cookie: session={token}; Path=/", "Set-Cookie: [REDACTED]"],
        ];
        const decision = route(`https://links.example.test/deploy?token=${token}`, {
            ...defaultRouterConfig(),
            routes: [
                {
                    pattern: "https://links\\.example\\.test/deploy",
                    action: {
                        type: "run",
                        approval: "ask",
                        argv: [
                            "curl",
                            ...headers.flatMap(([header]) => ["--header", header]),
                            "--header",
                            "Accept: application/json",
                            "https://api.example.test/deploy",
                        ],
                    },
                },
            ],
        });
        expect(decision.kind).toBe("run");
        if (decision.kind !== "run") {
            throw new Error("expected a saved-command decision");
        }

        expect(decision.needsApproval).toBe(true);
        expect(decision.argv.join(" ")).toContain(token);
        appendGateAudit({
            gate: "link-command",
            event: "prompted",
            link: decision.original,
            url: decision.url,
            argv: decision.argv,
            shown: {
                facts: [
                    { label: "Command", help: decision.argv.map((word) => `"${word}"`).join(" ") },
                    { label: "Unquoted command", help: decision.argv.join(" ") },
                ],
            },
        });
        const text = readFileSync(gatesAuditPath(), "utf8");
        expect(text).not.toContain(token);
        expect(text).toContain("Accept: application/json");
        for (const [, expected] of headers) {
            expect(text).toContain(expected);
        }
        const entry = parseJSON<{ shown: { facts: Array<{ help: string }> } }>(text.trim());
        expect(entry?.shown.facts).toHaveLength(2);
        for (const fact of entry?.shown.facts ?? []) {
            expect(fact.help).toContain("Accept: application/json");
            expect(fact.help).toContain("Authorization: Bearer [REDACTED]");
        }
    });

    test("quoted header values stay redacted in account commands and shown command facts", () => {
        const cookie = "fixture-cookie";
        const bearer = "fixture-bearer";
        for (const header of [
            `Cookie: session="${cookie}"`,
            `Cookie: session='${cookie}'`,
            `X-Api-Key: "${cookie}"`,
            `Cookie: session="prefix --header ${cookie}"`,
            `Cookie: session="prefix Accept: ${cookie}"`,
            `Cookie: session= " --header ${cookie}"`,
        ]) {
            const argv = [
                "curl",
                "--header",
                header,
                "--header",
                `Authorization: Bearer ${bearer}`,
                "--header",
                "Accept: application/json",
                "https://api.example.test/deploy",
            ];
            const original = SafeJSON.stringify(argv);
            const command = ["bun", "/fixture/client.ts", ...argv.slice(1)].join(" ").slice(0, 200);
            appendGateAudit({
                gate: "ai-account",
                event: "prompted",
                argv,
                client: { command },
                command,
                shown: {
                    facts: [
                        { label: "Quoted command", value: argv.map((word) => `"${word}"`).join(" ") },
                        { label: "Unquoted command", value: argv.join(" ") },
                        {
                            label: "Mixed quoted command",
                            value: `curl -H "Cookie: session='${cookie}'" --header Authorization: Bearer ${bearer} --header Accept: application/json`,
                        },
                    ],
                },
                ambiguous: `bun --header Cookie: session="${cookie} --header Accept: application/json`,
            });
            const text = readFileSync(gatesAuditPath(), "utf8");
            expect(text).not.toContain(cookie);
            expect(text).not.toContain(bearer);
            const entry = parseJSON<{
                argv: string[];
                client: { command: string };
                command: string;
                shown: { facts: Array<{ value: string }> };
                ambiguous: string;
            }>(text.trim().split("\n").at(-1) ?? "");
            if (!entry) {
                throw new Error("expected the audit fixture to parse");
            }

            expect(entry.argv).toContain("Accept: application/json");
            expect(entry.shown.facts).toHaveLength(3);
            for (const saved of [entry.client.command, entry.command, ...entry.shown.facts.map((fact) => fact.value)]) {
                expect(saved).not.toContain(cookie);
                expect(saved).not.toContain(bearer);
                expect(saved).toContain("Accept: application/json");
                expect(saved).toContain("Authorization: Bearer [REDACTED]");
            }
            expect(entry.ambiguous).toContain("[REDACTED]");
            expect(SafeJSON.stringify(argv)).toBe(original);
        }
    });

    test("a remembered grant is found until it expires", async () => {
        await rememberGrant(grant());

        expect(lookup()?.accountName).toBe("alice");
        expect(lookup({ now: T(60) })).toBeUndefined();
        expect(lookup({ provider: "openai-sub" })).toBeUndefined();
        expect(lookup({ identity: { ...identity, key: "other" } })).toBeUndefined();
    });

    test("a grant covers only the token kind it was approved for; a legacy grant without one covers none", async () => {
        await rememberGrant(grant());

        expect(lookup({ tokenKind: "access" })).toBeUndefined();

        await rememberGrant(grant({ tokenKind: undefined }));

        expect(lookup()).toBeUndefined();
        expect(lookup({ tokenKind: "access" })).toBeUndefined();
    });

    test("a new grant for the same client and account replaces the old one", async () => {
        await rememberGrant(grant({ until: T(60) }));
        await rememberGrant(grant({ until: T(120) }));

        expect(listGrants(NOW)).toHaveLength(1);
        expect(listGrants(NOW)[0].until).toBe(T(120));
    });

    test("an expired grant is dropped on the next write", async () => {
        await rememberGrant(grant({ until: NOW - 1 }));
        await rememberGrant(grant({ key: "k-other", clientName: "other", accountId: "acc_b" }));

        expect(listGrants(NOW).map((g) => g.clientName)).toEqual(["other"]);
    });

    test("revoke by name, by key and everything", async () => {
        await rememberGrant(grant());
        await rememberGrant(grant({ key: "k-other", clientName: "other", accountId: "acc_b" }));

        expect(await revokeGrants("pi")).toBe(1);
        expect(listGrants(NOW).map((g) => g.clientName)).toEqual(["other"]);
        expect(await revokeGrants("k-other")).toBe(1);
        await rememberGrant(grant());
        expect(await revokeGrants("*")).toBe(1);
        expect(listGrants(NOW)).toEqual([]);
    });

    test("a grants file that does not parse is copied aside before a new grant replaces it", async () => {
        const planted = '{"version":1,"grants":[{"key":"k-pi-node","clientName":"pi","accountId":"acc_a","un';
        mkdirSync(dirname(grantsPath()), { recursive: true });
        writeFileSync(grantsPath(), planted, { mode: 0o600 });

        await rememberGrant(grant({ key: "k-other", clientName: "other", accountId: "acc_b" }));

        const dir = dirname(grantsPath());
        const copies = readdirSync(dir).filter((name) => name.startsWith("grants.json.corrupt-"));
        expect(copies).toHaveLength(1);
        expect(readFileSync(join(dir, copies[0]), "utf8")).toBe(planted);
        expect(listGrants(NOW).map((g) => g.clientName)).toEqual(["other"]);
    });

    test("the audit tail returns the last lines in order, from a long history and from a short one", async () => {
        expect(await readAuditTail(5)).toEqual([]);

        const entry = (index: number) => ({
            at: new Date(NOW + index).toISOString(),
            event: "prompted" as const,
            client: { name: `client-${index}`, pid: null, executable: null, cwd: null },
            provider: "anthropic-sub" as const,
            account: "alice",
        });

        for (let index = 0; index < 400; index++) {
            await appendAudit(entry(index));
        }

        const tail = (await readAuditTail(3)).map((line) => line.match(/client-(\d+)/)?.[1]);
        expect(tail).toEqual(["397", "398", "399"]);
        expect(await readAuditTail(1000)).toHaveLength(400);
    });

    test("the files are private to the user", async () => {
        await rememberGrant(grant());
        await appendAudit({ at: "2026-09-23T00:00:00Z", event: "allowed", client: identity, account: "alice" });

        expect(statSync(grantsPath()).mode & 0o777).toBe(0o600);
        expect(statSync(auditPath()).mode & 0o777).toBe(0o600);
        expect(readFileSync(auditPath(), "utf8")).toContain('"event":"allowed"');
    });

    // Every gate goes to one trail (Martin, 2026-10-16: "I want all permission gates to be audited").
    test("a decision also lands in the shared gate audit, private to the user", async () => {
        await appendAudit({
            at: "2026-09-23T00:00:00Z",
            event: "denied",
            client: identity,
            account: "alice",
            detail: "no",
        });

        const lines = readFileSync(gatesAuditPath(), "utf8").trim().split("\n");
        const last = SafeJSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
        expect(last).toMatchObject({ gate: "ai-account", event: "denied", account: "alice", detail: "no" });
        expect(last.writer).toMatchObject({ pid: process.pid });
        expect(statSync(gatesAuditPath()).mode & 0o777).toBe(0o600);
    });
});
