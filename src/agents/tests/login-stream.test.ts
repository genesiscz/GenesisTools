import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

// The agents entry itself, not the `tools` wrapper: a SIGTERM to the wrapper never reached the `agents login`
// stream behind it, so every run left three logins alive in its bun test worker (worker log, 2026-10-09).
const agentsEntry = join(import.meta.dir, "../index.ts");

type JsonLine = Record<string, unknown>;

function spawnAgents(home: string, args: string[]): Bun.Subprocess<"ignore", "pipe", "ignore"> {
    return Bun.spawn(["bun", agentsEntry, ...args], {
        stdout: "pipe",
        stderr: "ignore",
        env: {
            ...process.env,
            GENESIS_TOOLS_HOME: home,
            GENESIS_AGENTS_SESSION: "",
            CLAUDE_CODE_SESSION_ID: "",
            GROK_SESSION_ID: "",
            COPILOT_AGENT_SESSION_ID: "",
        },
    });
}

class JsonlTap {
    private buf = "";
    private readonly lines: JsonLine[] = [];
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    private readonly decoder = new TextDecoder();

    constructor(stream: ReadableStream<Uint8Array>) {
        this.reader = stream.getReader();
    }

    async waitUntil(match: (line: JsonLine) => boolean, timeoutMs: number): Promise<JsonLine[]> {
        if (this.lines.some(match)) {
            return this.lines;
        }

        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const remaining = Math.max(1, deadline - Date.now());
            const raced = await Promise.race([
                this.reader.read().then((r) => ({ kind: "read" as const, r })),
                Bun.sleep(remaining).then(() => ({ kind: "timeout" as const })),
            ]);

            if (raced.kind === "timeout") {
                break;
            }

            const { done, value } = raced.r;

            if (done) {
                break;
            }

            this.buf += this.decoder.decode(value, { stream: true });
            let nl = this.buf.indexOf("\n");

            while (nl >= 0) {
                const raw = this.buf.slice(0, nl).trim();
                this.buf = this.buf.slice(nl + 1);

                if (raw.startsWith("{")) {
                    const parsed = SafeJSON.parse(raw, { strict: true });

                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        const rec = parsed as JsonLine;
                        this.lines.push(rec);

                        if (match(rec)) {
                            return this.lines;
                        }
                    }
                }

                nl = this.buf.indexOf("\n");
            }
        }

        throw new Error(`timeout waiting for login JSONL; saw ${SafeJSON.stringify(this.lines, { strict: true })}`);
    }
}

describe("agents login stream (monitor contract)", () => {
    test("prints ready, then main sees a peer-to-peer hop", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-login-stream-"));
        const session = `stream-${Date.now()}`;
        const procs: Bun.Subprocess<"ignore", "pipe", "ignore">[] = [];

        try {
            const lead = spawnAgents(home, [
                "login",
                "--agent-main",
                "--agent-name",
                "lead",
                "--session",
                session,
                "--format",
                "json",
            ]);
            procs.push(lead);
            const leadTap = new JsonlTap(lead.stdout);

            const leadReady = await leadTap.waitUntil((line) => line.type === "ready", 8_000);
            expect(leadReady[0]).toMatchObject({
                type: "ready",
                agent_name: "lead",
                session,
                mode: "stream",
                is_main: true,
            });

            const alpha = spawnAgents(home, [
                "login",
                "--agent-name",
                "alpha",
                "--session",
                session,
                "--format",
                "json",
            ]);
            procs.push(alpha);
            await new JsonlTap(alpha.stdout).waitUntil((line) => line.type === "ready", 8_000);

            const beta = spawnAgents(home, ["login", "--agent-name", "beta", "--session", session, "--format", "json"]);
            procs.push(beta);
            const betaTap = new JsonlTap(beta.stdout);
            await betaTap.waitUntil((line) => line.type === "ready", 8_000);

            await leadTap.waitUntil((line) => line.type === "logged_in" && line.agent_name === "beta", 8_000);

            const sent = spawnAgents(home, [
                "message",
                "--from",
                "alpha",
                "--to",
                "beta",
                "--body",
                "peer-hop",
                "--session",
                session,
            ]);
            expect(await sent.exited).toBe(0);

            const leadHop = await leadTap.waitUntil(
                (line) => line.type === "message" && line.body === "peer-hop",
                8_000
            );
            expect(leadHop.some((line) => line.type === "message" && line.body === "peer-hop")).toBe(true);

            const betaHop = await betaTap.waitUntil(
                (line) => line.type === "message" && line.body === "peer-hop",
                8_000
            );
            expect(betaHop.at(-1)).toMatchObject({ type: "message", body: "peer-hop" });
        } finally {
            // Wait for each login to exit (a killed child that nobody waits for stays a zombie), and
            // escalate when one ignores the signal.
            await Promise.all(
                procs.map(async (proc) => {
                    proc.kill("SIGTERM");
                    const stopped = await Promise.race([
                        proc.exited.then(() => true),
                        Bun.sleep(3_000).then(() => false),
                    ]);

                    if (!stopped) {
                        proc.kill("SIGKILL");
                        await proc.exited;
                    }
                })
            );
        }
    }, 30_000);
});
describe("agents login --once --timeout", () => {
    async function runOnce(home: string, args: string[]): Promise<{ code: number; lines: JsonLine[] }> {
        const proc = spawnAgents(home, ["login", "--once", "--format", "json", ...args]);
        const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
        const lines = text
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map((line) => SafeJSON.parse(line, { strict: true }) as JsonLine);

        return { code, lines };
    }

    test("an empty mailbox exits 124 with a timeout line; queued mail still exits 0 without one", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-login-timeout-"));
        const session = `timeout-${Date.now()}`;

        const sender = await runOnce(home, ["--agent-name", "alpha", "--session", session, "--timeout", "1"]);
        expect(sender.code).toBe(124);

        const empty = await runOnce(home, ["--agent-name", "beta", "--session", session, "--timeout", "1"]);
        expect(empty.code).toBe(124);
        expect(empty.lines.at(-1)).toMatchObject({ type: "timeout", agent_name: "beta", session });

        const sent = spawnAgents(home, [
            "message",
            "--from",
            "alpha",
            "--to",
            "beta",
            "--body",
            "queued",
            "--session",
            session,
        ]);
        expect(await sent.exited).toBe(0);

        const queued = await runOnce(home, ["--agent-name", "beta", "--session", session, "--timeout", "30"]);
        expect(queued.code).toBe(0);
        expect(queued.lines.some((line) => line.type === "message" && line.body === "queued")).toBe(true);
        expect(queued.lines.some((line) => line.type === "timeout")).toBe(false);
    }, 30_000);

    test("--timeout without --once is refused", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-login-timeout-"));
        const proc = spawnAgents(home, [
            "login",
            "--agent-name",
            "x",
            "--session",
            `refuse-${Date.now()}`,
            "--timeout",
            "1",
        ]);

        expect(await proc.exited).not.toBe(0);
    }, 15_000);
});
