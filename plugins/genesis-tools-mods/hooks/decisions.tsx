// The Decisions sidebar (`/decisions`, or the `decisions` chip in the band): every `❓ DECISION N` of this session,
// as the answer MCP's decision log has it (`answers.ts`), grouped by what it waits for. A waiting one opens to its
// prompt, its options as Buttons and a field for an answer in the person's own words. A press stages the answer in
// the decision store (`tools question inbox draft`; a second press unstages), so the widget shows the same pick, and a
// pick made in the widget shows here. [send] sends the session's staged answers through its own prompt, the store
// recording them as sent; [put in prompt] leaves them in the prompt to edit first. [jump to] scrolls the transcript to
// where the decision was first asked. A decision the store cannot take (asked in the chat before the last reply) is
// answered by putting `D16: a)` in the prompt.
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
    sendStaged,
    stageAnswer,
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
    pressed,
    sectionTitle,
    sidebarFrame,
    wrapWords,
} from "./sidebar";

export const DECISIONS_PANE = "genesis-decisions";
/** What the session's messages say: the decisions still open there, and the numbers a user message answered. */
let chat: { open: OpenDecisions; answered: Set<number> } = { open: [], answered: new Set() };
/** Rows opened or closed against `mods.decisions.expand`. */
const flipped = new Set<number>();
/** The answered, done and closed decisions shown or folded against `mods.decisions.history`. */
let historyFlipped = false;
/**
 * The fields whose drawn value carries a trailing zero-width mark. The engine empties a field after Enter and keeps
 * it empty until a drawing passes a `value` different from the one drawn before; the mark flips on each Enter, so the
 * next drawing differs and the field shows the staged text again. What the field reports is read without it.
 */
const marked = new Set<number>();
const MARK = "\u2060";
/** What each answer field holds before Enter stages it, so a redraw or a press elsewhere keeps the typed text. */
const typed = new Map<number, string>();

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
    /** The staged answer the store holds (state `drafted`): picked letters and a note. */
    draftOption?: string;
    draft?: string;
    at?: number;
}

/** A staged answer in words: `b)`, `my words`, `b) my words`. */
export function stagedText(decision: Pick<ShownDecision, "draftOption" | "draft">): string {
    const letters = [...(decision.draftOption ?? "")].map((letter) => `${letter})`).join(" ");

    return [letters, decision.draft?.trim() ?? ""].filter(Boolean).join(" ");
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

/** `text` cut to `cells` characters with `…` where it was cut. */
function cut(text: string, cells: number): string {
    const chars = [...text];

    return chars.length <= cells ? text : `${chars.slice(0, cells - 1).join("")}…`;
}

function tailOf(decision: ShownDecision): { text: string; color?: string } {
    const ago = decision.at ? ` · ${liveAgo(decision.at, { unit: "minute" })}` : "";
    const picked = decision.option ? `${decision.option}) ` : "";

    switch (decision.status) {
        case "waiting":
            return { text: `waiting${ago}`, color: "yellow" };
        case "drafted":
            // The whole answer is in the field below; a long one here took the row and squeezed the title.
            return { text: `staged ${cut(stagedText(decision), 24)}`, color: "cyan" };
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
    const { Box, Button, Text } = kit.ui;
    const elements = kit.ui;
    // The mobile app draws no field yet; there an answer is staged from the options alone.
    const Input = "Input" in elements ? elements.Input : undefined;
    const settings = (await settingsOf(host)).decisions;
    const list = currentDecisions();
    const read = answersOf();
    const waiting = list.filter(isWaiting).length;
    const staged = list.filter((decision) => decision.status === "drafted");
    const message = stagedMessage(
        Object.fromEntries(staged.map((decision) => [String(decision.n), stagedText(decision)]))
    );
    const width = Math.max(10, kit.columns - 4);
    const isOpen = (decision: ShownDecision) => {
        const byDefault = settings.expand === "all" || (settings.expand === "waiting" && isWaiting(decision));

        return flipped.has(decision.n) ? !byDefault : byDefault;
    };
    /**
     * Stages in the decision store: an option toggles, the answer field stores its text (Enter on an empty field
     * clears it). A decision the store cannot take gets its answer put in the prompt instead.
     */
    const stage = async (decision: ShownDecision, answer: { option?: string; text?: string }, key: string) => {
        await pressed(host, key, "Staging in the decision log…", "busy");
        const done = await stageAnswer(host, decision.n, answer);
        const words = answer.option ? `${answer.option})` : (answer.text ?? "");

        if (!done.error) {
            await pressed(host, key, words ? `Staged ${words}; the widget shows it too.` : "Unstaged.");
            return;
        }

        if (/not waiting/.test(done.error) && words) {
            await host.fill({ text: `D${decision.n}: ${words}\n`, mode: "append" });
            await pressed(
                host,
                key,
                `The decision log does not have DECISION ${decision.n}; "D${decision.n}: ${words}" is in the prompt instead.`
            );
            return;
        }

        await pressed(host, key, `Not staged: ${done.error}`, "error");
    };
    const send = async (how: "send" | "fill") => {
        if (!message) {
            return;
        }

        if (how === "fill") {
            await host.fill({ text: message, mode: "replace" });
            await pressed(
                host,
                "decisions-fill",
                "In the prompt; the answers stay staged until the agent records them."
            );
            return;
        }

        await pressed(host, "decisions-send", "Sending…", "busy");
        const sent = await sendStaged(host);

        if (sent.error || !sent.text) {
            await pressed(host, "decisions-send", `Not sent: ${sent.error ?? "nothing staged"}`, "error");
            return;
        }

        await host.submit(sent.text);
        typed.clear();
        await pressed(
            host,
            "decisions-send",
            `Sent ${plural(sent.numbers?.length ?? 0, "answer")}; the decision log marks them sent.`
        );
    };

    /**
     * The own-answer field. While the ring is elsewhere it sits in a rounded border, so it reads as a field: cyan
     * while its text is the staged answer. It keeps what was typed (`typed`); Enter stages the text, Enter on an
     * empty field unstages it, and with `mods.decisions.enter` `stage-then-send` Enter on the staged, unchanged answer
     * sends every staged answer (a terminal passes no Cmd+Enter to a mod's field).
     *
     * While the engine's Input has the keys it takes the pane's whole body width, whatever box holds it, and wraps a
     * long text itself; inside the border it ran 6 columns over and cut the text. So with the keys the field drops
     * its border and margin for two cyan rules across the pane. Without the keys the engine draws one cut line, so a
     * longer answer is a Button under the field's key holding the answer wrapped over as many lines as it takes;
     * Tab onto it brings the Input back.
     */
    const ownField = (decision: ShownDecision): RenderElement | null => {
        if (!Input) {
            return null;
        }

        const key = `d${decision.n}-own`;
        const stored = decision.draft ?? "";
        const draft = typed.get(decision.n) ?? stored;
        const unmarked = (value: string) => value.replaceAll(MARK, "");
        const isOwnStaged = stored !== "" && stored === draft;
        const sendsOnEnter = isOwnStaged && settings.enter === "stage-then-send";
        const isEditing = kit.isFocused === true && kit.focused === key;
        // Inside the margin (2), the border (2) and the padding (2).
        const inner = Math.max(10, kit.columns - 6);
        const isLong = [...draft].length > inner;
        const lines = isLong && !isEditing ? wrapWords(draft, inner, 40) : [];
        // Only for the status bar's line while the field has focus; Enter is the field's own.
        kit.pressables?.push({
            key,
            label: "answer",
            hint: sendsOnEnter
                ? `Enter sends every staged answer now; change the text to stage it again instead.`
                : `Your own answer to DECISION ${decision.n}. Enter stages it; Enter on an empty field unstages it.`,
            onPress: () => undefined,
        });
        const wrapped = lines.map((line, index) => (
            <Text key={`${key}-l${index}`} color={isOwnStaged ? "cyan" : undefined}>
                {line}
            </Text>
        ));
        const field = (
            <Input
                key={key}
                value={marked.has(decision.n) ? `${draft}${MARK}` : draft}
                placeholder="your own answer, Enter stages it"
                submitLabel={sendsOnEnter ? "send all" : isOwnStaged ? "staged" : "stage"}
                onInput={(value: string) => {
                    typed.set(decision.n, unmarked(value));
                }}
                onSubmit={(value: string) => {
                    const words = unmarked(value).trim();
                    typed.set(decision.n, words);

                    if (marked.has(decision.n)) {
                        marked.delete(decision.n);
                    } else {
                        marked.add(decision.n);
                    }

                    if (settings.enter === "stage-then-send" && words !== "" && words === stored) {
                        void send("send");
                        return;
                    }

                    void stage(decision, { text: words }, key);
                }}
            />
        );

        if (isEditing) {
            const rule = (side: string) => (
                <Text key={`${key}-${side}`} color="cyan" wrap="truncate-end">
                    {"─".repeat(Math.max(1, kit.columns))}
                </Text>
            );

            return (
                <Box key={`${key}-box`} flexDirection="column">
                    {rule("top")}
                    {/* A docked pane keeps its last column; the engine sizes the field to the column before it. */}
                    <Box marginRight={kit.placement === "dock" ? -1 : 0}>{field}</Box>
                    {rule("bottom")}
                </Box>
            );
        }

        return (
            <Box
                key={`${key}-box`}
                flexDirection="column"
                marginLeft={2}
                borderStyle="round"
                borderColor={isOwnStaged ? "cyan" : undefined}
                borderDimColor={!isOwnStaged}
                paddingX={1}
            >
                {isLong ? (
                    <Button key={key} plain onPress={() => undefined}>
                        {wrapped}
                    </Button>
                ) : (
                    field
                )}
            </Box>
        );
    };

    /** The letters of the answer given: the recorded option, else letters the answer starts with (`b)`, `ac)`). */
    const pickedOf = (decision: ShownDecision): string => {
        if (decision.option) {
            return decision.option;
        }

        return /^\s*([a-z]{1,4})\)/.exec(decision.answer ?? "")?.[1] ?? "";
    };

    const body = (decision: ShownDecision): RenderElement => {
        const key = `d${decision.n}`;
        const jump: Pressable = {
            key: `${key}-jump`,
            label: "jump to",
            hint: `Scrolls the transcript to where DECISION ${decision.n} was first asked.`,
            onPress: () => void jumpTo(host, `${key}-jump`, { decision: decision.n }),
        };
        const picked = pickedOf(decision);
        // The answer in words, when it says more than the letters picked.
        const said = (decision.answer ?? "").replace(/^\s*[a-z]{1,4}\)\s*/, "").trim();

        return (
            <Box key={`${key}-body`} flexDirection="column" marginBottom={1}>
                <Box flexDirection="column" marginLeft={2}>
                    {wrapWords(decision.prompt.trim() === decision.title.trim() ? "" : decision.prompt, width, 4).map(
                        (text, index) => (
                            <Text key={`${key}-p${index}`} dimColor wrap="truncate-end">
                                {text}
                            </Text>
                        )
                    )}
                    {decision.options.map((option) => {
                        const isStaged = (decision.draftOption ?? "").includes(option.letter);
                        const isPicked = picked.includes(option.letter);
                        const mark = isStaged ? "● " : isPicked ? "✓ " : "  ";
                        const star = decision.recommended === option.letter ? " (recommended)" : "";
                        const label = `${mark}${option.letter}) ${option.text}${star}`;

                        if (!isWaiting(decision)) {
                            return (
                                <Text
                                    key={`${key}-${option.letter}`}
                                    color={isPicked ? "green" : undefined}
                                    bold={isPicked}
                                    dimColor={!isPicked}
                                    wrap="truncate-end"
                                >
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
                            onPress: () =>
                                void stage(
                                    decision,
                                    { option: isStaged ? "" : option.letter },
                                    `d${decision.n}-${option.letter}`
                                ),
                        });
                    })}
                    {!isWaiting(decision) && said
                        ? wrapWords(`answer: ${said}`, width, 8).map((text, index) => (
                              <Text key={`${key}-a${index}`} color="green" wrap="truncate-end">
                                  {text}
                              </Text>
                          ))
                        : null}
                </Box>
                {isWaiting(decision) && Input ? ownField(decision) : null}
                <Box marginLeft={2}>{actionRow(kit, [jump])}</Box>
            </Box>
        );
    };

    /** One state group: its title and each decision's row, opening to its body. */
    const group = (title: string, rows: ShownDecision[]): RenderElement | null => {
        if (rows.length === 0) {
            return null;
        }

        return (
            <Box key={`group-${title}`} flexDirection="column" marginTop={1}>
                {sectionTitle(kit, title, `(${rows.length})`)}
                {rows.map((decision) => {
                    const open = isOpen(decision);
                    const tail = tailOf(decision);

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
                                <Text color={tail.color} dimColor={!tail.color} wrap="truncate-end">
                                    {tail.text}
                                </Text>
                            )}
                            {open ? body(decision) : null}
                        </Box>
                    );
                })}
            </Box>
        );
    };

    const [first, ...rest] = GROUPS;
    const waitingRows = first ? list.filter((decision) => first.statuses.includes(decision.status)) : [];
    const history = rest.map((held) => ({
        title: held.title,
        rows: list.filter((decision) => held.statuses.includes(decision.status)),
    }));
    const historyCount = history.reduce((sum, held) => sum + held.rows.length, 0);
    const showsHistory = (settings.history === "shown") !== historyFlipped;
    // What [send] submits, as the CLI builds it; this session's own list where the CLI is older.
    const outgoing = read?.staged ?? message;

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
            {first ? group(first.title, waitingRows) : null}
            {outgoing ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Staged", `(${staged.length})`)}
                    {dimNote(kit, "send submits exactly this:")}
                    {outgoing.split("\n").flatMap((line, index) =>
                        wrapWords(line, width, 6).map((text, part) => (
                            <Text key={`staged-${index}-${part}`} color="cyan" wrap="truncate-end">
                                {text}
                            </Text>
                        ))
                    )}
                    {actionRow(kit, [
                        {
                            key: "decisions-send",
                            label: "send",
                            isPrimary: true,
                            hotkey: "s",
                            hint: "Sends every staged answer as one message through this session's prompt (hotkey s); the decision log marks them sent.",
                            onPress: () => void send("send"),
                        },
                        {
                            key: "decisions-fill",
                            label: "put in prompt",
                            hint: "Puts the staged answers in the prompt to edit; they stay staged until the agent records them.",
                            onPress: () => void send("fill"),
                        },
                        {
                            key: "decisions-clear",
                            label: "clear",
                            isDim: true,
                            hint: "Unstages every answer in the decision store and empties the answer fields.",
                            onPress: () => {
                                typed.clear();
                                // One `tools` start at a time, then one read: never a process per row at once.
                                void (async () => {
                                    for (const decision of staged) {
                                        await stageAnswer(
                                            host,
                                            decision.n,
                                            { option: "", text: "" },
                                            { refresh: false }
                                        );
                                    }

                                    await refreshAnswers(host, "clear", true);
                                    await pressed(host, "decisions-clear", "Unstaged every answer.");
                                })();
                            },
                        },
                    ])}
                </Box>
            ) : waiting > 0 ? (
                <Box marginTop={1}>
                    {dimNote(kit, "Nothing staged: press an option, or type an answer and press Enter.")}
                </Box>
            ) : null}
            {historyCount > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                    {listRow(kit, {
                        key: "decisions-history",
                        label: showsHistory
                            ? `▾ hide the ${historyCount} answered, done and closed`
                            : `▸ show ${plural(historyCount, "answered decision")}`,
                        isDim: true,
                        hint: showsHistory
                            ? "Folds the answered, done and closed decisions into this one row."
                            : "Shows the answered, done and closed decisions; an opened one marks the answer given.",
                        onPress: () => {
                            historyFlipped = !historyFlipped;
                            host.redraw();
                        },
                    })}
                    {showsHistory ? history.map((held) => group(held.title, held.rows)) : null}
                </Box>
            ) : null}
        </Box>
    );
}
