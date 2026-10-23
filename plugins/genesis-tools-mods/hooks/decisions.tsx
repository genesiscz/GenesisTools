// `/decisions`: the open `❓ DECISION N` questions of this session in a pane, each with its options as Buttons.
// A press stages an answer (a second press on it unstages), an Input takes an answer in the person's own words,
// and [send] submits every staged answer as one message (`D16: a)` per line); [put in prompt] leaves it in the
// prompt to edit first. The list comes from the session's own messages, so a decision asked before this mod
// loaded is found too: a first ask is a `❓ DECISION N` that is not a link (a repeat is `[❓ DECISION N](…)`),
// its options are the `a)` lines under it, and it closes when a later user message answers it (`D16: a)`,
// `D16 b)`, `16 a)`, `D16: own words`) or a later assistant message says it replaces it.
import type { ElementTable, RenderElement } from "claude-code";
import type { DecisionOption, OpenDecision, OpenDecisions, StagedDecisions } from "../types";
import { type Feature, type Host, logMod, settingsOf } from "./shared";
import { sidebarFrame } from "./sidebar";

export const DECISIONS_PANE = "genesis-decisions";
let open: OpenDecisions = [];
let staged: StagedDecisions = {};

const ASK = /(^|[^[])❓\s*\**\s*DECISION\s+(\d+)\**\s*[:.]?\s*(.*)$/;
const OPTION = /^\s*(?:[-*]\s+)?\**\(?([a-z])\)\**\s*(.+)$/;
const ANSWER_LETTER = /\bD(?:ECISION)?\s*(\d+)\s*[:-]?\s*\(?([a-z])\)/gi;
const ANSWER_BARE = /^\s*(\d+)\s+([a-z])\)/gm;
const ANSWER_OWN = /^\s*D(\d+)\s*:\s*(.+)$/gm;
const REPLACES = /replaces?\s+\[?❓\s*DECISION\s+(\d+)/gi;

function clean(text: string): string {
    return text
        .replace(/\*\*/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .trim();
}

/** The decisions an assistant text asks for the first time, with the options listed under each. */
export function asksIn(text: string): OpenDecision[] {
    const lines = text.split("\n");
    const found: OpenDecision[] = [];

    for (let i = 0; i < lines.length; i++) {
        const match = ASK.exec(lines[i] ?? "");

        if (!match) {
            continue;
        }

        let title = clean(match[3] ?? "");
        const options: DecisionOption[] = [];
        let j = i + 1;

        for (; j < lines.length && j <= i + 14; j++) {
            const line = lines[j] ?? "";

            if (ASK.test(line)) {
                break;
            }

            const option = OPTION.exec(line);

            if (option) {
                options.push({ letter: option[1] ?? "", text: clean(option[2] ?? "") });
                continue;
            }

            if (!title && line.trim()) {
                title = clean(line);
                continue;
            }

            if (options.length > 0 && line.trim() && !/^\s/.test(line)) {
                break;
            }
        }

        found.push({ n: Number(match[2]), title, options });
        i = j - 1;
    }

    return found;
}

/** The decision numbers a user text answers. */
export function answersIn(text: string): Set<number> {
    const answered = new Set<number>();

    for (const pattern of [ANSWER_LETTER, ANSWER_BARE, ANSWER_OWN]) {
        for (const match of text.matchAll(pattern)) {
            answered.add(Number(match[1]));
        }
    }

    return answered;
}

/** The decisions still open after reading the messages in order: asked, and since then neither answered nor replaced. */
export function openDecisions(messages: readonly { role: string; text: string }[]): OpenDecisions {
    const asked = new Map<number, OpenDecision>();

    for (const message of messages) {
        if (message.role === "assistant") {
            for (const decision of asksIn(message.text)) {
                if (!asked.has(decision.n)) {
                    asked.set(decision.n, decision);
                }
            }

            for (const match of message.text.matchAll(REPLACES)) {
                asked.delete(Number(match[1]));
            }

            continue;
        }

        for (const n of answersIn(message.text)) {
            asked.delete(n);
        }
    }

    return [...asked.values()].sort((a, b) => a.n - b.n);
}

/** The message `[send]` submits: one `D<n>: <answer>` line per staged decision, in number order. */
export function stagedMessage(answers: StagedDecisions): string {
    return Object.entries(answers)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([n, answer]) => `D${n}: ${answer}`)
        .join("\n");
}

async function refresh(host: Host): Promise<OpenDecisions> {
    const list = openDecisions(await host.messages());
    const numbers = new Set(list.map((decision) => String(decision.n)));

    open = list;
    staged = Object.fromEntries(Object.entries(staged).filter(([n]) => numbers.has(n)));
    host.redraw();

    return list;
}

export const decisions: Feature = {
    sidebars: [
        { id: DECISIONS_PANE, title: "Decisions", draw: (host, kit) => sidebarFrame(kit, decisionsPane(host, kit.ui)) },
    ],
    commands: [
        {
            name: "decisions",
            description: "Open decisions of this session: stage an answer per decision, then send them in one message",
            async run(host) {
                if (!(await settingsOf(host)).decisions.enabled) {
                    return {
                        text: "The decisions mod is off: tools agents hooks config set mods.decisions.enabled true --write",
                    };
                }

                const list = await refresh(host);
                await host.openPane(DECISIONS_PANE, "Decisions");
                await logMod(host, "decisions", { event: "open", open: list.map((decision) => decision.n) });

                return list.length === 0 ? { text: "No open decisions in this session." } : {};
            },
        },
    ],
};

/** The decisions pane: per decision its options as Buttons and a field for an answer in the person's own words. */
export function decisionsPane(host: Host, elements: ElementTable): RenderElement {
    const { Box, Button, Text } = elements;
    // The mobile app draws no field yet; there an answer is staged from the options alone.
    const Input = "Input" in elements ? elements.Input : undefined;
    const list = open;
    const answers = staged;
    const stage = (n: number, answer: string, how: string) => {
        const key = String(n);

        const next = { ...staged };

        if (next[key] === answer) {
            delete next[key];
        } else {
            next[key] = answer;
        }

        staged = next;
        host.redraw();
        void logMod(host, "decisions", { event: "stage", n, answer, how });
    };
    const message = stagedMessage(answers);
    const send = async (how: "send" | "fill") => {
        if (!message) {
            return;
        }

        await logMod(host, "decisions", { event: how, message });

        if (how === "send") {
            await host.submit(message);
        } else {
            await host.fill({ text: message, mode: "replace" });
        }

        staged = {};
        await host.closePane(DECISIONS_PANE);
    };

    return (
        <Box flexDirection="column" gap={1}>
            {list.length === 0 ? <Text dimColor>No open decisions.</Text> : null}
            {list.map((decision) => (
                <Box key={`d${decision.n}`} flexDirection="column">
                    <Text bold>
                        D{decision.n} {decision.title}
                    </Text>
                    <Box flexDirection="column">
                        {decision.options.map((option) => {
                            const answer = `${option.letter})`;
                            const isStaged = answers[String(decision.n)] === answer;

                            return (
                                <Button
                                    key={`d${decision.n}-${option.letter}`}
                                    dimColor={!isStaged}
                                    onPress={() => stage(decision.n, answer, "option")}
                                >
                                    {`${isStaged ? "● " : ""}${option.letter}) ${option.text.slice(0, 110)}`}
                                </Button>
                            );
                        })}
                    </Box>
                    {Input ? (
                        <Input
                            key={`d${decision.n}-own`}
                            placeholder="or type your own answer, Enter stages it"
                            submitLabel="stage"
                            onSubmit={(value: string) => {
                                if (value.trim()) {
                                    stage(decision.n, value.trim(), "own");
                                }
                            }}
                        />
                    ) : null}
                </Box>
            ))}
            <Box flexDirection="column">
                <Text dimColor>Staged:</Text>
                <Text>{message || "nothing yet"}</Text>
            </Box>
            <Box flexDirection="row" gap={1}>
                <Button key="decisions-send" onPress={() => send("send")}>
                    send
                </Button>
                <Button key="decisions-fill" onPress={() => send("fill")}>
                    put in prompt
                </Button>
                <Button
                    key="decisions-clear"
                    dimColor
                    onPress={() => {
                        staged = {};
                        host.redraw();
                    }}
                >
                    clear
                </Button>
                <Button key="decisions-refresh" dimColor onPress={() => void refresh(host)}>
                    refresh
                </Button>
                <Button key="decisions-close" dimColor onPress={() => void host.closePane(DECISIONS_PANE)}>
                    close
                </Button>
            </Box>
        </Box>
    );
}
