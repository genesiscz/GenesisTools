import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * A refresh token is single-use, and replaying one can revoke the whole family.
 * The `inflight` map in refresh.ts only de-duplicates callers inside ONE process,
 * and on a normal day three processes run against `~/.grok/auth.json` at once
 * (the usage daemon, a TUI and ai-proxy), each with its own empty map.
 *
 * So this test uses REAL processes. An in-process test cannot fail the way the
 * bug fails: it would share the very map that does not cover the bug.
 */

const REFRESH_DELAY_MS = 500;
const ENTRY_ID = "issuer::11111111-2222-3333-4444-555555555555";

function jwt(expSecondsFromNow: number): string {
    const payload = Buffer.from(SafeJSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }), "utf-8")
        .toString("base64url")
        .replace(/=+$/, "");

    return `e30.${payload}.sig`;
}

let authPath: string;
let server: ReturnType<typeof Bun.serve> | undefined;
/** Every `refresh_token` the issuer was asked to spend, in order. */
let submitted: string[] = [];

/**
 * An issuer with real rotation semantics: a grant may be spent once. The second
 * presentation of the same token is `invalid_grant`, exactly as xAI answers.
 */
function startIssuer(): string {
    submitted = [];
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === "/.well-known/openid-configuration") {
                return new Response("no discovery", { status: 404 });
            }

            const form = new URLSearchParams(await req.text());
            const presented = form.get("refresh_token") ?? "";
            const replayed = submitted.includes(presented);
            submitted.push(presented);

            if (replayed) {
                return new Response(SafeJSON.stringify({ error: "invalid_grant" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                });
            }

            // Hold the response open so a second process has time to read the
            // still-expired file and present the same grant, which is the race.
            await Bun.sleep(REFRESH_DELAY_MS);

            return new Response(
                SafeJSON.stringify({ access_token: jwt(3_600), refresh_token: `${presented}-next`, expires_in: 3600 }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );
        },
    });

    return `http://127.0.0.1:${server.port}`;
}

/** One child process doing exactly what the daemon or the proxy would do. */
function spawnRefresher() {
    const module = join(import.meta.dir, "refresh.ts");
    const script = `const { refreshGrokAuth } = await import(${SafeJSON.stringify(module)});
const token = await refreshGrokAuth({ path: ${SafeJSON.stringify(authPath)} });
console.log(token ? "TOKEN" : "NULL");`;

    return Bun.spawn(["bun", "-e", script], {
        env: process.env,
        cwd: join(import.meta.dir, "..", "..", "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
    });
}

beforeEach(() => {
    const issuer = startIssuer();
    authPath = join(mkdtempSync(join(tmpdir(), "grok-refresh-race-")), "auth.json");

    writeFileSync(
        authPath,
        SafeJSON.stringify(
            {
                [ENTRY_ID]: {
                    key: jwt(-3_600),
                    refresh_token: "rt-1",
                    expires_at: "2020-01-01T00:00:00.000Z",
                    oidc_issuer: issuer,
                    oidc_client_id: "client-abc",
                    auth_mode: "oidc",
                },
            },
            { strict: true },
            2
        ),
        { mode: 0o600 }
    );
});

afterEach(() => {
    server?.stop(true);
    server = undefined;
});

describe("refreshGrokAuth across processes", () => {
    test("two processes racing on one auth file spend the grant once", async () => {
        const children = [spawnRefresher(), spawnRefresher()];
        const outputs = await Promise.all(
            children.map(async (child) => {
                const [stdout, stderr] = await Promise.all([
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                ]);
                await child.exited;

                return { stdout: stdout.trim(), stderr };
            })
        );

        // Both come away usable. Before the file lock the loser replayed the
        // grant, got invalid_grant and returned null — a dead account, from
        // nothing but two healthy processes doing their job at the same time.
        for (const output of outputs) {
            expect(output.stdout, `child stderr:\n${output.stderr}`).toBe("TOKEN");
        }

        // The whole point: `rt-1` reached the issuer exactly once.
        expect(submitted.filter((token) => token === "rt-1")).toHaveLength(1);
        expect(submitted).toEqual(["rt-1"]);
    }, 20_000);
});
