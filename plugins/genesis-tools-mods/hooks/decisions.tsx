// The Decisions sidebar (`/decisions`, or the `decisions` chip in the band): every `❓ DECISION N` of this session,
// as the answer MCP's decision log has it (`answers.ts`), grouped by what it waits for. A waiting one opens to its
// prompt, its options as Buttons and a field for an answer in the person's own words: a press stages an answer (a
// second press unstages), and [send] submits every staged answer as one message (`D16: a)` per line); [put in
// prompt] leaves it in the prompt to edit first. [jump to] scrolls the transcript to where the decision was first
// asked.
//
// The session's own messages count too, so the sidebar works without the `tools` CLI and before the log has a new
// decision: a first ask is a `❓ DECISION N` that is not a link (a repeat is `[❓ DECISION N](…)`), its options are
// the `a)` lines under it, and a later user message answers it (`D16: a)`, `D16 b)`, `16 a)`, `D16: own words`) or a
// later assistant message says it replaces it.
import type { ElementTable, RenderElement } from "claude-code";
import type { DecisionOption, OpenDecision, OpenDecisions, StagedDecisions } from "../types";
import {
    afterQuestionTool,
    answersOf,
    type DecisionStatus,
    findAskRows,
    jumpTo,
    refreshAnswers,
    startAnswers,
} from "./answers";
import { liveAgo } from "./live";
import { type Feature, type Host, logMod, settingsOf } from "./shared";
import {
    actionRow,
    dimNote,
    headerRow,
    type Kit,
    listRow,
    type Pressable,
    plural,
    sectionTitle,
    sidebarFrame,
    wrapWords,
} from "./sidebar";

export const DECISIONS_PANE = "genesis-decisions";
let staged: StagedDecisions = {};
/** What the session's messages say: the decisions still open there, and the numbers a user message answered. */
let chat: { open: OpenDecisions; answered: Set<number> } = { open: [], answered: new Set() };
/** Rows opened or closed against `mods.decisions.expand`. */
const flipped = new Set<number>();
/** What each decision's own-answer field holds, so a redraw or a press elsewhere keeps the typed text. */
const drafts = new Map<number, string>();

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
    return chatDecisions(messages).open;
}

/** The open decisions of the messages, and every number a user message answered (asked here or before a compaction). */
export function chatDecisions(messages: readonly { role: string; text: string }[]): {
    open: OpenDecisions;
    answered: Set<number>;
} {
    const asked = new Map<number, OpenDecision>();
    const answered = new Set<number>();

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
            answered.add(n);
        }
    }

    return { open: [...asked.values()].sort((a, b) => a.n - b.n), answered };
}

/** The message `[send]` submits: one `D<n>: <answer>` line per staged decision, in number order. */
export function stagedMessage(answers: StagedDecisions): string {
    return Object.entries(answers)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([n, answer]) => `D${n}: ${answer}`)
        .join("\n");
}

/** One decision as the sidebar shows it: the log's row, a chat ask the log does not have yet, or both merged. */
export interface ShownDecision {
    n: number;
    title: string;
    prompt: string;
    status: DecisionStatus | "chat-answered";
    options: { letter: string; text: string }[];
    recommended?: string;
    option?: string;
    answer?: string;
    at?: number;
}

/**
 * The log's decisions, plus the chat's open ones it lacks, by number. A decision the log still has waiting that a
 * user message already answered reads `chat-answered`: the agent has the answer and has not recorded it yet.
 */
export function shownDecisions(
    logged: readonly ShownDecision[],
    fromChat: { open: OpenDecisions; answered: ReadonlySet<number> }
): ShownDecision[] {
    const numbers = new Set(logged.map((decision) => decision.n));
    const merged = logged.map((decision) =>
        (decision.status === "waiting" || decision.status === "drafted") && fromChat.answered.has(decision.n)
            ? { ...decision, status: "chat-answered" as const }
            : decision
    );
    const asked = fromChat.open
        .filter((decision) => !numbers.has(decision.n))
        .map((decision) => ({ ...decision, prompt: "", status: "waiting" as const }));

    return [...merged, ...asked].sort((a, b) => a.n - b.n);
}

const GROUPS: { title: string; statuses: ShownDecision["status"][] }[] = [
    { title: "Waiting for you", statuses: ["waiting", "drafted"] },
    { title: "Answered", statuses: ["chat-answered", "answered", "sent", "acknowledged"] },
    { title: "Done", statuses: ["implemented"] },
    { title: "Closed", statuses: ["superseded", "dismissed"] },
];

function isWaiting(decision: ShownDecision): boolean {
    return decision.status === "waiting" || decision.status === "drafted";
}

/** The decisions the sidebar and the chip count, newest read. */
function currentDecisions(): ShownDecision[] {
    return shownDecisions(answersOf()?.decisions ?? [], chat);
}

async function readChat(host: Host): Promise<void> {
    chat = chatDecisions(await host.messages());
    const numbers = new Set(
        currentDecisions()
            .filter(isWaiting)
            .map((decision) => String(decision.n))
    );
    staged = Object.fromEntries(Object.entries(staged).filter(([n]) => numbers.has(n)));
    host.redraw();
    await findAskRows(
        host,
        currentDecisions().map((decision) => decision.n)
    );
}

async function refresh(host: Host, why: string): Promise<void> {
    await Promise.all([readChat(host), refreshAnswers(host, why, true)]);
}

export const decisions: Feature = {
    async start(host) {
        if ((await settingsOf(host)).decisions.enabled) {
            startAnswers(host);
            await readChat(host);
        }
    },
    async afterTool(host, e) {
        if ((await settingsOf(host)).decisions.enabled) {
            afterQuestionTool(host, e);
        }
    },
    async afterTurn(host, e) {
        if (e.agentId === undefined && (await settingsOf(host)).decisions.enabled) {
            await readChat(host);
        }
    },
    sidebars: [{ id: DECISIONS_PANE, title: "Decisions", draw: decisionsPane }],
    commands: [
        {
            name: "decisions",
            description:
                "The Decisions sidebar: every decision of this session, a summary by state, stage and send answers, jump to where each was asked",
            async run(host) {
                if (!(await settingsOf(host)).decisions.enabled) {
                    return {
                        text: "The decisions mod is off: tools agents hooks config set mods.decisions.enabled true --write",
                    };
                }

                startAnswers(host);
                await host.togglePane(DECISIONS_PANE, "Decisions", "command");
                await refresh(host, "command");
                await logMod(host, "decisions", { event: "open", shown: currentDecisions().map((d) => d.n) });

                return {};
            },
        },
    ],
};

function chipText(list: readonly ShownDecision[], mode: "any" | "waiting" | "off"): string | undefined {
    const waiting = list.filter(isWaiting).length;

    if (mode === "off" || list.length === 0 || (mode === "waiting" && waiting === 0)) {
        return undefined;
    }

    return waiting > 0 ? `decisions ${waiting} waiting` : `decisions ${list.length}`;
}

/** The band chip, `decisions 1 waiting` or `decisions 4`, with the columns it takes; null when it has nothing to say. */
export async function decisionsChip(
    host: Host,
    ui: ElementTable
): Promise<{ element: RenderElement; width: number } | null> {
    const settings = (await settingsOf(host)).decisions;

    if (!settings.enabled) {
        return null;
    }

    const list = currentDecisions();
    const label = chipText(list, settings.chip);

    if (!label) {
        return null;
    }

    const { Button, Text } = ui;
    const waiting = list.some(isWaiting);

    return {
        element: (
            <Button key="decisions-chip" plain onPress={() => void host.togglePane(DECISIONS_PANE, "Decisions")}>
                <Text color={waiting ? "yellow" : undefined} dimColor={!waiting}>
                    {label}
                </Text>
            </Button>
        ),
        width: [...label].length,
    };
}

function tailOf(decision: ShownDecision): { text: string; color?: string } {
    const ago = decision.at ? ` · ${liveAgo(decision.at, { unit: "minute" })}` : "";
    const picked = decision.option ? `${decision.option}) ` : "";

    switch (decision.status) {
        case "waiting":
            return { text: `waiting${ago}`, color: "yellow" };
        case "drafted":
            return { text: `${picked}drafted${ago}`, color: "yellow" };
        case "chat-answered":
            return { text: "answered in chat", color: "green" };
        case "answered":
        case "sent":
        case "acknowledged":
            return { text: `${picked}${decision.status}${ago}`, color: "green" };
        case "implemented":
            return { text: `${picked}done${ago}` };
        case "superseded":
            return { text: "replaced" };
        case "dismissed":
            return { text: "dismissed" };
    }
}

/** The Decisions sidebar: a summary line, the decisions by state, each opening to its options and [jump to]. */
async function decisionsPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    const elements = kit.ui;
    // The mobile app draws no field yet; there an answer is staged from the options alone.
    const Input = "Input" in elements ? elements.Input : undefined;
    const settings = (await settingsOf(host)).decisions;
    const list = currentDecisions();
    const read = answersOf();
    const waiting = list.filter(isWaiting).length;
    const message = stagedMessage(staged);
    const width = Math.max(10, kit.columns - 4);
    const isOpen = (decision: ShownDecision) => {
        const byDefault = settings.expand === "all" || (settings.expand === "waiting" && isWaiting(decision));

        return flipped.has(decision.n) ? !byDefault : byDefault;
    };
    /** An option toggles; the own-answer field stages its text, or unstages when Enter finds it empty. */
    const stage = (n: number, answer: string, how: "option" | "own") => {
        const key = String(n);
        const next = { ...staged };

        if (!answer || (how === "option" && next[key] === answer)) {
            delete next[key];
        } else {
            next[key] = answer;
        }

        staged = next;
        host.redraw();
        void logMod(host, "decisions", { event: "stage", n, answer, how });
    };
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
        drafts.clear();
        host.redraw();
    };

    /**
     * The own-answer field in a rounded border, so it reads as a field: cyan while its text is the staged answer.
     * It keeps what was typed (`drafts`); Enter stages the text, Enter on an empty field unstages it.
     */
    const ownField = (decision: ShownDecision): RenderElement | null => {
        if (!Input) {
            return null;
        }

        const draft = drafts.get(decision.n) ?? "";
        const stagedHere = staged[String(decision.n)];
        const isOwnStaged = stagedHere !== undefined && stagedHere !== "" && stagedHere === draft;
        // Only for the status bar's line while the field has focus; Enter is the field's own.
        kit.pressables?.push({
            key: `d${decision.n}-own`,
            label: "answer",
            hint: `Your own answer to DECISION ${decision.n}. Enter stages it; Enter on an empty field unstages it.`,
            onPress: () => undefined,
        });

        return (
            <Box
                key={`d${decision.n}-own-box`}
                borderStyle="round"
                borderColor={isOwnStaged ? "cyan" : undefined}
                borderDimColor={!isOwnStaged}
                paddingX={1}
            >
                <Input
                    key={`d${decision.n}-own`}
                    value={draft}
                    placeholder="your own answer, Enter stages it"
                    submitLabel={isOwnStaged ? "staged" : "stage"}
                    onInput={(value: string) => {
                        drafts.set(decision.n, value);
                    }}
                    onSubmit={(value: string) => {
                        drafts.set(decision.n, value.trim());
                        stage(decision.n, value.trim(), "own");
                    }}
                />
            </Box>
        );
    };

    const body = (decision: ShownDecision): RenderElement => {
        const key = `d${decision.n}`;
        const jump: Pressable = {
            key: `${key}-jump`,
            label: "jump to",
            hint: `Scrolls the transcript to where DECISION ${decision.n} was first asked.`,
            onPress: () => void jumpTo(host, `${key}-jump`, { decision: decision.n }),
        };

        return (
            <Box key={`${key}-body`} flexDirection="column" marginLeft={2} marginBottom={1}>
                {wrapWords(decision.prompt, width, 4).map((text, index) => (
                    <Text key={`${key}-p${index}`} dimColor wrap="truncate-end">
                        {text}
                    </Text>
                ))}
                {decision.options.map((option) => {
                    const isStaged = staged[String(decision.n)] === `${option.letter})`;
                    const isPicked = decision.option === option.letter;
                    const mark = isStaged ? "● " : isPicked ? "✓ " : "  ";
                    const star = decision.recommended === option.letter ? " (recommended)" : "";
                    const label = `${mark}${option.letter}) ${option.text}${star}`;

                    if (!isWaiting(decision)) {
                        return (
                            <Text key={`${key}-${option.letter}`} dimColor={!isPicked} wrap="truncate-end">
                                {label}
                            </Text>
                        );
                    }

                    return listRow(kit, {
                        key: `${key}-${option.letter}`,
                        label,
                        ...(isStaged ? { color: "cyan" } : {}),
                        hint: isStaged
                            ? `Unstages ${option.letter}) for DECISION ${decision.n}.`
                            : `Stages ${option.letter}) as the answer to DECISION ${decision.n}; [send] sends every staged answer.`,
                        onPress: () => stage(decision.n, `${option.letter})`, "option"),
                    });
                })}
                {decision.answer ? <Text wrap="truncate-end">{`Answer: ${decision.answer}`}</Text> : null}
                {isWaiting(decision) && Input ? ownField(decision) : null}
                {actionRow(kit, [jump])}
            </Box>
        );
    };

    return sidebarFrame(
        kit,
        <Box flexDirection="column">
            {headerRow(
                kit,
                <Text wrap="truncate-end">
                    <Text bold>{plural(list.length, "decision")}</Text>
                    <Text dimColor>{waiting > 0 ? ` · ${waiting} waiting` : ""}</Text>
                </Text>,
                [
                    {
                        key: "decisions-refresh",
                        label: "refresh",
                        isDim: true,
                        hint: "Reads the decision log and this session's messages again.",
                        onPress: () => void refresh(host, "button"),
                    },
                ]
            )}
            {dimNote(
                kit,
                read
                    ? `From the decision log, read ${liveAgo(read.at, { unit: "minute" })}, and this session's messages.`
                    : "From this session's messages (the decision log needs the tools CLI)."
            )}
            {list.length === 0 ? dimNote(kit, "No decisions in this session yet.") : null}
            {GROUPS.map((group) => {
                const rows = list.filter((decision) => group.statuses.includes(decision.status));

                if (rows.length === 0) {
                    return null;
                }

                return (
                    <Box key={`group-${group.title}`} flexDirection="column" marginTop={1}>
                        {sectionTitle(kit, group.title, `(${rows.length})`)}
                        {rows.map((decision) => {
                            const open = isOpen(decision);
                            const pick = staged[String(decision.n)];
                            const tail = pick
                                ? { text: /^[a-z]\)$/.test(pick) ? `staged ${pick}` : `staged: ${pick}`, color: "cyan" }
                                : tailOf(decision);

                            return (
                                <Box key={`row-d${decision.n}`} flexDirection="column">
                                    {listRow(
                                        kit,
                                        {
                                            key: `d${decision.n}-row`,
                                            label: `${open ? "▾" : "▸"} D${decision.n} ${decision.title}`,
                                            isDim: !isWaiting(decision),
                                            hint: open
                                                ? "Folds this decision."
                                                : "Opens this decision: its options and [jump to].",
                                            onPress: () => {
                                                if (flipped.has(decision.n)) {
                                                    flipped.delete(decision.n);
                                                } else {
                                                    flipped.add(decision.n);
                                                }

                                                host.redraw();
                                            },
                                        },
                                        <Text color={tail.color} dimColor={!tail.color}>
                                            {tail.text}
                                        </Text>
                                    )}
                                    {open ? body(decision) : null}
                                </Box>
                            );
                        })}
                    </Box>
                );
            })}
            {message ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Staged")}
                    <Text wrap="wrap">{message}</Text>
                    {actionRow(kit, [
                        {
                            key: "decisions-send",
                            label: "send",
                            isPrimary: true,
                            hint: "Sends every staged answer as one message, one line per decision.",
                            onPress: () => void send("send"),
                        },
                        {
                            key: "decisions-fill",
                            label: "put in prompt",
                            hint: "Puts the staged answers in the prompt to edit before you send them.",
                            onPress: () => void send("fill"),
                        },
                        {
                            key: "decisions-clear",
                            label: "clear",
                            isDim: true,
                            hint: "Unstages every answer and empties the answer fields.",
                            onPress: () => {
                                staged = {};
                                drafts.clear();
                                host.redraw();
                            },
                        },
                    ])}
                </Box>
            ) : null}
        </Box>
    );
}
