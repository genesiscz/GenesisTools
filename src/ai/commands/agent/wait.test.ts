import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as delivery from "@app/ai/lib/agent-message/delivery";
import { codexNativeLinesToTurns } from "@genesiscz/utils/ai/transcripts/codex";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import type { TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state";
import {
    DEFAULT_TURN_LIMIT,
    type SliceOptions,
    sliceTurns,
    type TranscriptEnvelope,
    type TranscriptTool,
    type TranscriptTurn,
} from "@genesiscz/utils/ai/transcripts/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { messageCommand } from "./message";
import {
    answeredBeforeWatch,
    baselineStartFor,
    DEFAULT_WAIT_STALL_SECONDS,
    exitCodeOf,
    parseSeconds,
    parseWaitFlags,
    printsFinalText,
    readTurnExtras,
    registerAgentWaitCommand,
    sentAtSlackMs,
    streamsLive,
    type TranscriptPager,
    TurnStreamer,
    turnExtrasOf,
    WAIT_EXIT_DONE,
    WAIT_EXIT_STALLED,
    WAIT_EXIT_TIMEOUT,
} from "./wait";

describe("wait exit codes", () => {
    it("gives each outcome its own status, with timeout matching coreutils", () => {
        expect(exitCodeOf("done")).toBe(WAIT_EXIT_DONE);
        expect(exitCodeOf("stalled")).toBe(WAIT_EXIT_STALLED);
        expect(exitCodeOf("timeout")).toBe(WAIT_EXIT_TIMEOUT);
        expect(new Set([exitCodeOf("done"), exitCodeOf("stalled"), exitCodeOf("timeout")]).size).toBe(3);
        expect(WAIT_EXIT_TIMEOUT).toBe(124);
    });
});

describe("answeredBeforeWatch", () => {
    function snapshot(state: TurnSnapshot["state"], turnStartedAt: number | null): TurnSnapshot {
        return {
            state,
            lastText: "",
            asksQuestion: false,
            question: null,
            interrupted: false,
            lastEventAt: turnStartedAt,
            turnStartedAt,
            lastActivityAt: 0,
            silenceMs: 0,
        };
    }

    it("takes an ended answering turn as the reply", () => {
        expect(answeredBeforeWatch(snapshot("FINISHED", 2000), { turnStartedAfter: 1000 })).toBe(true);
        expect(answeredBeforeWatch(snapshot("AWAITING-INPUT", 2000), { turnStartedAfter: 1000 })).toBe(true);
    });

    it("never takes a stalled or running answering turn as done, nor a turn from before the send", () => {
        expect(answeredBeforeWatch(snapshot("STALLED", 2000), { turnStartedAfter: 1000 })).toBe(false);
        expect(answeredBeforeWatch(snapshot("RUNNING", 2000), { turnStartedAfter: 1000 })).toBe(false);
        expect(answeredBeforeWatch(snapshot("FINISHED", 500), { turnStartedAfter: 1000 })).toBe(false);
        expect(answeredBeforeWatch(snapshot("FINISHED", 2000), {})).toBe(false);
        expect(answeredBeforeWatch(null, { turnStartedAfter: 1000 })).toBe(false);
    });

    it("never takes the turn that was current before the send, even inside the timestamp tolerance", () => {
        // Grok: the send at 10_500 allows starts from 9_500; the previous turn began at 10_000 and already ended.
        const sentAt = 10_500;
        const window = { turnStartedAfter: sentAt - sentAtSlackMs("grok"), turnNewerThan: 10_000 };

        expect(answeredBeforeWatch(snapshot("FINISHED", 10_000), window)).toBe(false);
        // The reply's turn, stamped in the same whole second as the send, still counts.
        expect(answeredBeforeWatch(snapshot("FINISHED", 10_000 + 1), window)).toBe(true);
        // Millisecond clocks get no tolerance: a Claude or Codex turn from 500 ms before the send is not the reply.
        expect(sentAtSlackMs("claude")).toBe(0);
        expect(sentAtSlackMs("codex")).toBe(0);
        expect(answeredBeforeWatch(snapshot("FINISHED", sentAt - 500), { turnStartedAfter: sentAt })).toBe(false);
    });

    it("keeps the baseline only for the session the message went to", () => {
        expect(baselineStartFor({ sessionId: "s-1", turnStartedAt: 10_000 }, "s-1")).toBe(10_000);
        expect(baselineStartFor({ sessionId: "s-1", turnStartedAt: 10_000 }, "s-2")).toBeUndefined();
        expect(baselineStartFor({ sessionId: "s-1", turnStartedAt: null }, "s-1")).toBeUndefined();
        expect(baselineStartFor(null, "s-1")).toBeUndefined();
    });
});

describe("wait output with --stream and --quiet", () => {
    it("never streams with --quiet, even when --stream is given", () => {
        expect(streamsLive({ stream: true, quiet: true })).toBe(false);
        expect(streamsLive({ stream: true })).toBe(true);
        expect(streamsLive({})).toBe(false);
    });

    it("prints a reply that ended before the watch began, because the streamer never showed it", () => {
        expect(printsFinalText({ quiet: false, streaming: true, answeredBeforeWatch: true })).toBe(true);
    });

    it("does not print the text twice after a live stream, and prints nothing with --quiet", () => {
        expect(printsFinalText({ quiet: false, streaming: true, answeredBeforeWatch: false })).toBe(false);
        expect(printsFinalText({ quiet: false, streaming: false, answeredBeforeWatch: false })).toBe(true);
        expect(printsFinalText({ quiet: true, streaming: false, answeredBeforeWatch: true })).toBe(false);
    });
});

describe("parseSeconds", () => {
    it("accepts positive numbers and, when allowed, zero", () => {
        expect(parseSeconds("2.5", "--timeout", { allowZero: false })).toBe(2.5);
        expect(parseSeconds("0", "--stall-timeout", { allowZero: true })).toBe(0);
        expect(parseSeconds(undefined, "--timeout", { allowZero: false })).toBeUndefined();
    });

    it("rejects zero, negatives and words, naming the flag", () => {
        expect(() => parseSeconds("0", "--timeout", { allowZero: false })).toThrow("--timeout");
        expect(() => parseSeconds("-1", "--timeout", { allowZero: false })).toThrow("--timeout");
        expect(() => parseSeconds("soon", "--stall-timeout", { allowZero: true })).toThrow("--stall-timeout");
    });
});

describe("registerAgentWaitCommand", () => {
    it("registers `wait <session>` with the documented flags", () => {
        const program = new Command();
        const command = registerAgentWaitCommand(program, "grok");
        const flags = command.options.map((option) => option.long);

        expect(command.name()).toBe("wait");
        expect(flags).toEqual([
            "--timeout",
            "--stall-timeout",
            "--next",
            "--stream",
            "--json",
            "--first",
            "--last",
            "--tools",
            "--quiet",
        ]);
        expect(command.description()).toContain("grok");
        expect(DEFAULT_WAIT_STALL_SECONDS).toBeGreaterThan(120);
    });
});

describe("wait --last and --tools", () => {
    const tool = (name: string) => ({ name, inputPreview: "" });
    const turns = [
        { role: "user" as const, text: "first ask", tools: [] },
        { role: "assistant" as const, text: "old reply", tools: [tool("Read")] },
        { role: "user" as const, text: "second ask", tools: [] },
        { role: "assistant" as const, text: "", tools: [tool("Bash"), tool("Bash")] },
        { role: "assistant" as const, text: "new reply", tools: [tool("Edit")] },
    ];

    it("keeps the last N assistant texts and counts only the ending turn's tools", () => {
        expect(turnExtrasOf(turns, { last: 2, tools: true })).toEqual({
            lastMessages: ["old reply", "new reply"],
            tools: [
                { name: "Bash", count: 2 },
                { name: "Edit", count: 1 },
            ],
        });
        expect(turnExtrasOf(turns, {})).toEqual({});
    });
});

describe("TurnStreamer", () => {
    const resolved: ResolvedTranscript = {
        provider: "grok",
        source: "native",
        sessionId: "s-stream",
        filePath: "/nonexistent/s-stream.jsonl",
    };
    const turn = (text: string): TranscriptTurn => ({ id: text, role: "assistant", at: null, text, tools: [] });

    function harness(initial: TranscriptTurn[]) {
        const transcript = { turns: initial, size: 1, reads: 0, failRead: false, failPage: null as number | null };
        const lines: string[] = [];
        const pager = async (): Promise<TranscriptPager> => {
            transcript.reads += 1;

            if (transcript.failRead) {
                transcript.failRead = false;
                throw new Error("transcript read failed");
            }

            const turns = [...transcript.turns];
            let pages = 0;

            return async (opts: SliceOptions): Promise<TranscriptEnvelope> => {
                pages += 1;

                if (pages === transcript.failPage) {
                    transcript.failPage = null;
                    throw new Error("page read failed");
                }

                const sliced = sliceTurns(turns, opts);

                return {
                    provider: "grok",
                    sessionId: resolved.sessionId,
                    filePath: resolved.filePath,
                    byteSize: transcript.size,
                    truncated: sliced.truncated,
                    nextOffset: sliced.nextOffset,
                    turns: sliced.turns,
                    turnCount: turns.length,
                };
            };
        };
        const streamer = new TurnStreamer({
            resolved,
            write: (line) => lines.push(line),
            pager,
            size: () => transcript.size,
        });

        return { transcript, lines, streamer };
    }

    it("prints every turn of a burst longer than one page, and the rest of a turn that grew", async () => {
        const history = Array.from({ length: 5 }, (_, index) => turn(`old ${index}`));
        const { transcript, lines, streamer } = harness(history);
        await streamer.prime();

        const burst = Array.from({ length: DEFAULT_TURN_LIMIT + 20 }, (_, index) => turn(`new ${index}`));
        transcript.turns = [...history.slice(0, 4), { ...turn("old 4 and more"), id: "old 4" }, ...burst];
        transcript.size = 2;
        await streamer.print();

        expect(lines[0]).toBe(" and more");
        expect(lines.slice(1)).toEqual(burst.map((entry) => entry.text));
    });

    it("reads nothing while the transcript's size is unchanged", async () => {
        const { transcript, lines, streamer } = harness([turn("old")]);
        await streamer.prime();
        await streamer.print();
        await streamer.print();

        expect(transcript.reads).toBe(1);
        expect(lines).toEqual([]);
    });

    it("retries a failed read at the same size and prints the final write", async () => {
        const { transcript, lines, streamer } = harness([turn("old")]);
        await streamer.prime();

        transcript.turns = [turn("old"), turn("final answer")];
        transcript.size = 2;
        transcript.failRead = true;
        await expect(streamer.print()).rejects.toThrow("transcript read failed");
        expect(lines).toEqual([]);

        await streamer.print();

        expect(lines).toEqual(["final answer"]);
    });

    it("catches up after the wait settled on a failed print, and reports a final read that fails too", async () => {
        const { transcript, lines, streamer } = harness([turn("old")]);
        await streamer.prime();

        transcript.turns = [turn("old"), turn("final answer")];
        transcript.size = 2;
        transcript.failRead = true;
        await expect(streamer.print()).rejects.toThrow("transcript read failed");
        expect(await streamer.printRest()).toBe(true);
        expect(lines).toEqual(["final answer"]);

        transcript.turns = [...transcript.turns, turn("after")];
        transcript.size = 3;
        transcript.failRead = true;
        expect(await streamer.printRest()).toBe(false);
        expect(lines).toEqual(["final answer"]);
    });

    it("runs the final printRest after a print still in flight, never beside it", async () => {
        const { transcript, lines, streamer } = harness([turn("old")]);
        await streamer.prime();
        transcript.turns = [turn("old"), turn("final answer")];
        transcript.size = 2;

        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let active = 0;
        let overlap = false;
        const original = streamer["options"].pager;
        streamer["options"].pager = async (resolved) => {
            active += 1;
            overlap ||= active > 1;

            if (transcript.reads === 1) {
                await held;
            }

            try {
                return (await original?.(resolved)) as TranscriptPager;
            } finally {
                active -= 1;
            }
        };

        const inFlight = streamer.print();
        const rest = streamer.printRest();
        release();
        await inFlight;

        expect(await rest).toBe(true);
        expect(overlap).toBe(false);
        expect(lines).toEqual(["final answer"]);
    });

    it("resumes a drain that failed between pages without printing a turn twice", async () => {
        const { transcript, lines, streamer } = harness([turn("old")]);
        await streamer.prime();

        const burst = Array.from({ length: DEFAULT_TURN_LIMIT + 20 }, (_, index) => turn(`new ${index}`));
        transcript.turns = [turn("old"), ...burst];
        transcript.size = 2;
        transcript.failPage = 2;
        await expect(streamer.print()).rejects.toThrow("page read failed");
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.length).toBeLessThan(burst.length);

        await streamer.print();

        expect(lines).toEqual(burst.map((entry) => entry.text));
    });

    it("follows a Codex turn list that drops a finished script turn before the final answer", async () => {
        const row = (second: number, payload: Record<string, unknown>, type = "response_item") =>
            SafeJSON.stringify({
                timestamp: `2026-10-09T10:00:${String(second).padStart(2, "0")}.000Z`,
                type,
                payload,
            });
        const running = [
            row(1, { type: "user_message", message: "go" }, "event_msg"),
            row(2, { type: "custom_tool_call", name: "exec", call_id: "s1", input: 'tools.exec_command({cmd:"ls"})' }),
            row(3, { type: "custom_tool_call_output", call_id: "s1", output: "Script running" }),
            row(4, { type: "reasoning", summary: [] }),
            row(5, {
                type: "custom_tool_call",
                name: "exec",
                call_id: "s2",
                input: 'tools.exec_command({cmd:"git status"})',
            }),
        ];
        const finished = [
            ...running,
            row(6, { type: "custom_tool_call_output", call_id: "s1", output: "Script completed" }),
            row(
                7,
                {
                    type: "item_completed",
                    item: {
                        type: "CommandExecution",
                        id: "e2",
                        command: ["/bin/zsh", "-lc", "git status"],
                        aggregated_output: "clean",
                        exit_code: 0,
                    },
                },
                "event_msg"
            ),
            row(8, { type: "custom_tool_call_output", call_id: "s2", output: "Script completed" }),
            row(9, { type: "reasoning", summary: [] }),
            row(10, { type: "message", role: "assistant", content: [{ type: "output_text", text: "final answer" }] }),
            row(11, { type: "function_call", name: "shell", call_id: "c3", arguments: '{"command":"git log"}' }),
        ];
        const before = codexNativeLinesToTurns(running);
        const after = codexNativeLinesToTurns(finished);
        // The script turn of s1 is gone, so the turn of s2 moved down and the answer took its place.
        expect(before.map((entry) => entry.id)).toEqual(["codex-user-1", "codex-2", "codex-3"]);
        expect(after.map((entry) => entry.id)).toEqual(["codex-user-1", "codex-3", "codex-4"]);

        const { transcript, lines, streamer } = harness(before);
        await streamer.prime();
        transcript.turns = after;
        transcript.size = 2;
        await streamer.print();

        const tools = (turn: TranscriptTurn) => turn.tools.map((tool) => `→ ${tool.name}(${tool.inputPreview})`);
        expect(lines.map((line) => Bun.stripANSI(line))).toEqual([
            ...tools(after[1]),
            "final answer",
            ...tools(after[2]),
        ]);
        expect(lines).toHaveLength(3);
    });
});

describe("wait --last and --tools past one page", () => {
    const tool = (name: string): TranscriptTool => ({ id: name, name, inputPreview: "", result: null, isError: false });

    function pagerOver(turns: TranscriptTurn[]): { page: TranscriptPager; reads: SliceOptions[] } {
        const reads: SliceOptions[] = [];
        const page: TranscriptPager = async (opts) => {
            reads.push(opts);
            const sliced = sliceTurns(turns, opts);

            return {
                provider: "grok",
                sessionId: "s-pages",
                filePath: "/nonexistent/s-pages.jsonl",
                byteSize: 1,
                truncated: sliced.truncated,
                nextOffset: sliced.nextOffset,
                turns: sliced.turns,
                turnCount: turns.length,
            };
        };

        return { page, reads };
    }

    it("pages back until --last N assistant texts are read, though user turns fill half of each page", async () => {
        const turns = Array.from({ length: 300 }, (_, index): TranscriptTurn => {
            const role = index % 2 === 0 ? "user" : "assistant";
            return { id: String(index), role, at: null, text: `${role} ${index}`, tools: [] };
        });
        const { page } = pagerOver(turns);
        const extras = await readTurnExtras(page, { last: 100 });

        expect(extras.lastMessages).toHaveLength(100);
        expect(extras.lastMessages?.[0]).toBe("assistant 101");
        expect(extras.lastMessages?.at(-1)).toBe("assistant 299");
    });

    it("counts every tool call of an ending turn longer than one page, and reads one page when that is enough", async () => {
        const working = Array.from(
            { length: DEFAULT_TURN_LIMIT + 40 },
            (_, index): TranscriptTurn => ({
                id: `a${index}`,
                role: "assistant",
                at: null,
                text: "",
                tools: [tool("Bash")],
            })
        );
        const turns: TranscriptTurn[] = [
            { id: "old", role: "assistant", at: null, text: "old", tools: [tool("Read")] },
            { id: "ask", role: "user", at: null, text: "do it", tools: [] },
            ...working,
        ];
        const long = pagerOver(turns);

        expect((await readTurnExtras(long.page, { tools: true })).tools).toEqual([
            { name: "Bash", count: DEFAULT_TURN_LIMIT + 40 },
        ]);

        const short = pagerOver(turns.slice(-10));
        await readTurnExtras(short.page, { last: 1, tools: true });
        expect(short.reads).toEqual([{}]);
    });
});

describe("parseWaitFlags", () => {
    it("validates --last as a whole number and names the flag the caller exposes", () => {
        expect(parseWaitFlags({ timeout: "5", last: "3" })).toEqual({
            timeoutSeconds: 5,
            last: 3,
            stallTimeoutMs: DEFAULT_WAIT_STALL_SECONDS * 1000,
        });
        expect(parseWaitFlags({ stallTimeout: "0" }).stallTimeoutMs).toBe(Number.POSITIVE_INFINITY);
        expect(() => parseWaitFlags({ last: "2.5" })).toThrow("--last");
        expect(() => parseWaitFlags({ timeout: "soon" }, { timeoutFlag: "--wait-timeout" })).toThrow("--wait-timeout");
    });
});

describe("message --wait with a bad wait flag", () => {
    afterEach(() => {
        mock.restore();
        process.exitCode = 0;
    });

    it("refuses before delivery, so nothing is sent", async () => {
        const deliver = spyOn(delivery, "deliverMessage").mockImplementation(async () => {
            throw new Error("deliverMessage must not run");
        });

        for (const flags of [{ waitTimeout: "soon" }, { last: "1.5" }, { stallTimeout: "-1" }]) {
            await messageCommand("grok", "s-1", ["hello"], { wait: true, ...flags });
            expect(process.exitCode).toBe(2);
        }

        expect(deliver).not.toHaveBeenCalled();
    });

    it("still delivers when the wait flags are valid", async () => {
        const deliver = spyOn(delivery, "deliverMessage").mockImplementation(async () => {
            throw new delivery.MessageError("delivery reached", []);
        });

        await messageCommand("grok", "s-1", ["hello"], { wait: true, waitTimeout: "5", last: "2" });

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(1);
    });
});
