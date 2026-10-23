// The stall catcher (`mods.stall`). A main-loop reply that ends on what it was about to do ("Next I'll run the tests.")
// while nothing can wake the session (no background shell, subagent, monitor or workflow, no scheduled wake-up) does
// not go on by itself. The classic Stop hook carries the reply's last message and both lists, so the band then shows
// the closing sentence with `continue` and `dismiss`; `action: auto` presses continue by itself after `minutes`. A
// tool call or a new turn of the main loop takes it down. It never fires while anything runs: a Stop input without the
// task list counts as unknown, and the session's agent list (`$.agent.list()`) is asked too, before the row shows and
// again before an auto continue. The sentence tests are the session-analyzer's stall scorer
// (`scripts/stalls-shared.ts`), calibrated on real transcripts: the last sentence, not the last line, and a
// conditional ("I'll report when it fires"), a negated ("I won't rewrite …") or a gated reply ("waiting for your
// answer") is not a stall. About 70% of the 402 stall endings it found were resumed later by a task notice, which is
// why a pending task or wake-up keeps the band quiet. Each finding and each press goes to `mods-log/stall.jsonl`.
import type { ElementTable, RenderElement } from "claude-code";
import { liveLeft } from "./live";
import { type Feature, type Host, isRecord, logMod, settingsOf } from "./shared";

const INTENT =
    /^\W*(i'?ll\b|i will\b|i am going to\b|i'?m going to\b|let me\b|next,? i\b|now i'?ll\b|starting (that|it|now)\b|running (it|that) now\b|(moving )?on to (the|my|its|it)\b|now (the|for) \w+\b|up next\b|i dispatch\b|dispatching\b|doing (that|this|it) next\b)/i;
const CONDITIONAL =
    /\b(when|once|as soon as|after|before|if|unless|in case|the moment|while|until|as they|as it|every time|each time|whenever|from (here|now) on|going forward)\b/i;
const NEGATED = /\bi (will|'?ll|am|'?m) (not|never)\b|\bi won'?t\b/i;
const GATED =
    /\b(is running|are running|still running|still working|still writing|still building|still gathering|still out\b|has not reported|have not reported|hasn'?t reported|no report yet|a (background )?watcher|watcher is|poller is|is polling|waiting (on|for)|awaiting|in flight|ci (is|on)\b|agents? (are|is) still|still owe me|when (it|they|the)\b|once (it|they|the)\b|as soon as|your (call|answer|decision|go|word)|needs your|need from you|click it\b|say the word)\b/i;

interface Stall {
    sentence: string;
    at: number;
}

let stall: Stall | undefined;

/** The last sentence of a reply: its last line with text, list and emphasis marks dropped, then its final sentence. */
export function lastSentence(text: string): string {
    const lines = text.trim().split("\n");
    const last =
        [...lines]
            .reverse()
            .find((row) => row.trim() && !/^[-*•|>#`\s]*$/.test(row))
            ?.trim() ?? "";
    const cleaned = last.replace(/^[-*•>\s]+/, "").replace(/\*\*/g, "");
    const parts = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);

    return (parts.at(-1) ?? cleaned).trim();
}

/** The closing sentence when the reply stopped on what it meant to do next, else undefined. */
export function stallSentence(reply: string): string | undefined {
    const sentence = lastSentence(reply);

    if (!INTENT.test(sentence) || CONDITIONAL.test(sentence) || NEGATED.test(sentence) || GATED.test(reply)) {
        return undefined;
    }

    return sentence;
}

/** What the continue press sends: the stopping sentence, so the model knows what it left undone. */
export function continueText(sentence: string): string {
    return `Continue. Your last reply ended on "${sentence}", and nothing runs in the background to wake you, so do it now.`;
}

/** An agent in these states can still wake the session (a subagent's report, a teammate's message). */
const BUSY = new Set(["pending", "running", "waiting"]);

function countOf(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

/** How many of the session's agents still work, or undefined when the list could not be read. */
async function busyAgents(host: Host): Promise<number | undefined> {
    const list = await host.agents().catch(() => undefined);

    return list?.filter((agent) => BUSY.has(agent.status)).length;
}

/** Reads a classic `Stop` input: a stall shows; anything else, or work that will wake the session, takes it down. */
export async function noteStop(host: Host, input: unknown): Promise<void> {
    if (!isRecord(input) || input.hook_event_name !== "Stop" || !(await settingsOf(host)).stall.enabled) {
        return;
    }

    const reply = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    const sentence = stallSentence(reply);

    if (!sentence) {
        clearStall(host, "answered");
        return;
    }

    // Without the task list there is no telling whether a shell or a monitor still runs, so it counts as running.
    const tasks = Array.isArray(input.background_tasks) ? input.background_tasks.length : undefined;
    const crons = countOf(input.session_crons);
    const agents = await busyAgents(host);

    if (tasks === undefined || agents === undefined || tasks || crons || agents) {
        clearStall(host, "waits");
        await logMod(host, "stall", {
            event: "waits",
            sentence,
            tasks: tasks ?? "unknown",
            crons,
            agents: agents ?? "unknown",
        });
        return;
    }

    stall = { sentence, at: Date.now() };
    host.redraw();
    await logMod(host, "stall", { event: "stall", sentence });
}

/** Takes the band row down: the session went on (a tool call, a new turn) or its last reply is no stall. */
export function clearStall(host: Host, why: string): void {
    if (!stall) {
        return;
    }

    const held = stall;
    stall = undefined;
    host.redraw();
    void logMod(host, "stall", { event: "cleared", why, sentence: held.sentence, afterMs: Date.now() - held.at });
}

/** The stall the band shows now; a test reads it. */
export function stallNow(): Readonly<Stall> | undefined {
    return stall;
}

/** A press on the band row, or the auto continue: `dismiss` only takes the row down. */
export async function pressStall(host: Host, how: "continue" | "auto" | "dismiss"): Promise<void> {
    const held = stall;

    if (!held) {
        return;
    }

    stall = undefined;
    host.redraw();
    await logMod(host, "stall", { event: how, sentence: held.sentence, afterMs: Date.now() - held.at });

    if (how !== "dismiss") {
        await host.submit(continueText(held.sentence));
    }
}

export const stallCatcher: Feature = {
    async start(host) {
        host.every(5_000, () => {
            void (async () => {
                const settings = (await settingsOf(host)).stall;

                if (!stall || settings.action !== "auto" || Date.now() - stall.at < settings.minutes * 60_000) {
                    return;
                }

                const agents = await busyAgents(host);

                if (agents === undefined || agents > 0) {
                    clearStall(host, "an agent works");
                    return;
                }

                await pressStall(host, "auto");
            })();
        });
    },
    beforeTool(host, e) {
        if (e.agentId === undefined) {
            clearStall(host, "tool call");
        }

        return undefined;
    },
};

/** The band row: the sentence the reply stopped on, `continue` and `dismiss`; null while there is none. */
export async function stallRow(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    const held = stall;
    const settings = (await settingsOf(host)).stall;

    if (!held || !settings.enabled) {
        return null;
    }

    const { Box, Button, Text } = ui;
    const auto = settings.action === "auto" ? ` · continues in ${liveLeft(held.at + settings.minutes * 60_000)}` : "";

    return (
        <Box key="stall-band" flexDirection="row" gap={1}>
            <Box flexShrink={1} minWidth={0}>
                <Text color="yellow" wrap="truncate-end">
                    {`⏸ stopped on "${held.sentence}" · nothing runs in the background${auto}`}
                </Text>
            </Box>
            <Box flexShrink={0} flexDirection="row" columnGap={1}>
                <Button key="stall-continue" variant="primary" onPress={() => void pressStall(host, "continue")}>
                    continue
                </Button>
                <Button key="stall-dismiss" dimColor onPress={() => void pressStall(host, "dismiss")}>
                    dismiss
                </Button>
            </Box>
        </Box>
    );
}
