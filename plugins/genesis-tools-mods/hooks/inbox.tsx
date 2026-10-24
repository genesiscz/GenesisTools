// The Inbox sidebar (`/mod-inbox`, or the `inbox` chip in the band): what this session put in the GenesisTools
// inbox through the answer MCP, as a summary. The forms it waits on, the messages it sent (`inbox_send`), the
// questions and answers it recorded (`question_answer`) and its todos; an entry opens to its text, [jump to] (the
// tool call that sent it) and its images. `new` is an entry nobody read in the widget yet.
import type { ElementTable, RenderElement } from "claude-code";
import {
    afterQuestionTool,
    answersOf,
    jumpRowOf,
    jumpTo,
    type LoggedEntry,
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

export const INBOX_PANE = "mods-inbox";
/** Entries opened or closed against `mods.inbox.expand`. */
const flipped = new Set<string>();
const DONE_TODOS = new Set(["implemented", "dismissed", "superseded"]);

export const inbox: Feature = {
    async start(host) {
        if ((await settingsOf(host)).inbox.enabled) {
            startAnswers(host);
        }
    },
    async afterTool(host, e) {
        if ((await settingsOf(host)).inbox.enabled) {
            afterQuestionTool(host, e);
        }
    },
    sidebars: [{ id: INBOX_PANE, title: "Inbox", draw: inboxPane }],
    commands: [
        {
            name: "mod-inbox",
            description:
                "The Inbox sidebar: the forms, messages, answers and todos this session put in the GenesisTools inbox",
            async run(host) {
                if (!(await settingsOf(host)).inbox.enabled) {
                    return {
                        text: "The inbox mod is off: tools agents hooks config set mods.inbox.enabled true --write",
                    };
                }

                startAnswers(host);
                await host.togglePane(INBOX_PANE, "Inbox", "command");
                await refreshAnswers(host, "command", true);

                return {};
            },
        },
    ],
};

/** How many items the chip and the header count: waiting forms, entries and open todos. */
function counts(): { items: number; unread: number } {
    const read = answersOf();

    if (!read) {
        return { items: 0, unread: 0 };
    }

    const todos = read.todos.filter((todo) => !DONE_TODOS.has(todo.state)).length;

    return {
        items: read.forms.length + read.entries.length + todos,
        unread: read.forms.length + read.entries.filter((entry) => entry.isUnread).length,
    };
}

/** The band chip, `inbox 2 new` or `inbox 5`, with the columns it takes; null when it has nothing to say. */
export async function inboxChip(
    host: Host,
    ui: ElementTable
): Promise<{ element: RenderElement; width: number } | null> {
    const settings = (await settingsOf(host)).inbox;
    const { items, unread } = counts();

    if (!settings.enabled || settings.chip === "off" || items === 0 || (settings.chip === "unread" && unread === 0)) {
        return null;
    }

    const label = unread > 0 ? `inbox ${unread} new` : `inbox ${items}`;
    const { Button, Text } = ui;

    return {
        element: (
            <Button key="inbox-chip" plain onPress={() => void host.togglePane(INBOX_PANE, "Inbox")}>
                <Text color={unread > 0 ? "cyan" : undefined} dimColor={unread === 0}>
                    {label}
                </Text>
            </Button>
        ),
        width: [...label].length,
    };
}

/** The first line of a text, for a row's label. */
function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim())
            ?.trim() ?? ""
    );
}

/** The Inbox sidebar: a summary line, then forms, messages, answers and todos; an entry opens to its text. */
async function inboxPane(host: Host, kit: Kit): Promise<RenderElement> {
    const { Box, Text } = kit.ui;
    const settings = (await settingsOf(host)).inbox;
    const read = answersOf();
    const { items, unread } = counts();
    const width = Math.max(10, kit.columns - 4);
    const messages = read?.entries.filter((entry) => entry.tag === "message") ?? [];
    const answers = read?.entries.filter((entry) => entry.tag !== "message") ?? [];
    const todos = [...(read?.todos ?? [])].sort(
        (a, b) => Number(DONE_TODOS.has(a.state)) - Number(DONE_TODOS.has(b.state)) || a.n - b.n
    );
    const isOpen = (entry: LoggedEntry) => {
        const byDefault = settings.expand === "all" || (settings.expand === "unread" && entry.isUnread);

        return flipped.has(entry.id) ? !byDefault : byDefault;
    };

    const entryRow = (entry: LoggedEntry): RenderElement => {
        const open = isOpen(entry);
        const actions: Pressable[] = [];

        if (jumpRowOf({ entry: entry.id })) {
            actions.push({
                key: `${entry.id}-jump`,
                label: "jump to",
                hint: "Scrolls the transcript to the tool call that sent this.",
                onPress: () => void jumpTo(host, `${entry.id}-jump`, { entry: entry.id }),
            });
        }

        if (entry.images.length > 0) {
            actions.push({
                key: `${entry.id}-images`,
                label: plural(entry.images.length, "image"),
                isDim: true,
                hint: "Opens the attached images in Preview.",
                onPress: () => void host.run(["/usr/bin/open", ...entry.images], { timeoutMs: 10_000 }),
            });
        }

        return (
            <Box key={`entry-${entry.id}`} flexDirection="column">
                {listRow(
                    kit,
                    {
                        key: `${entry.id}-row`,
                        label: `${open ? "▾" : "▸"} ${firstLine(entry.title) || "(no title)"}`,
                        isDim: !entry.isUnread,
                        hint: open ? "Folds this entry." : "Opens this entry: its text and [jump to].",
                        onPress: () => {
                            if (flipped.has(entry.id)) {
                                flipped.delete(entry.id);
                            } else {
                                flipped.add(entry.id);
                            }

                            host.redraw();
                            void logMod(host, "inbox", { event: open ? "fold" : "open", id: entry.id });
                        },
                    },
                    <Text color={entry.isUnread ? "cyan" : undefined} dimColor={!entry.isUnread}>
                        {`${entry.isUnread ? "new · " : ""}${entry.tag === "message" ? "" : `${entry.tag} · `}${liveAgo(entry.at, { unit: "minute" })}`}
                    </Text>
                )}
                {open ? (
                    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
                        {wrapWords(
                            entry.text.trim() === entry.title.trim() ? "" : entry.text.replace(/\n+/g, " "),
                            width,
                            12
                        ).map((line, index) => (
                            <Text key={`${entry.id}-t${index}`} wrap="truncate-end">
                                {line}
                            </Text>
                        ))}
                        {actions.length > 0 ? actionRow(kit, actions) : null}
                    </Box>
                ) : null}
            </Box>
        );
    };

    return sidebarFrame(
        kit,
        <Box flexDirection="column">
            {headerRow(
                kit,
                <Text wrap="truncate-end">
                    <Text bold>{plural(items, "item")}</Text>
                    <Text dimColor>{unread > 0 ? ` · ${unread} new` : ""}</Text>
                </Text>,
                [
                    {
                        key: "inbox-refresh",
                        label: "refresh",
                        isDim: true,
                        hint: "Reads the inbox again.",
                        onPress: () => void refreshAnswers(host, "button", true),
                    },
                ]
            )}
            {dimNote(
                kit,
                read
                    ? `What this session sent to the GenesisTools inbox, read ${liveAgo(read.at, { unit: "minute" })}.`
                    : "Not read yet: the inbox needs the tools CLI."
            )}
            {read && items === 0 ? dimNote(kit, "Nothing from this session in the inbox yet.") : null}
            {read && read.forms.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Forms waiting for you", `(${read.forms.length})`)}
                    {read.forms.map((form) => (
                        <Box key={`form-${form.id}`} flexDirection="row">
                            <Text wrap="truncate-end">{firstLine(form.prompts[0] ?? "") || form.id}</Text>
                            <Box flexGrow={1} />
                            <Text color="yellow">{`waiting · ${liveAgo(form.at, { unit: "minute" })}`}</Text>
                        </Box>
                    ))}
                    {dimNote(kit, "Answer a form in the GenesisTools widget.")}
                </Box>
            ) : null}
            {messages.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Messages", `(${messages.length})`)}
                    {messages.map(entryRow)}
                </Box>
            ) : null}
            {answers.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Questions and answers", `(${answers.length})`)}
                    {answers.map(entryRow)}
                </Box>
            ) : null}
            {todos.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                    {sectionTitle(kit, "Todos", `(${todos.length})`)}
                    {todos.map((todo) => (
                        <Box key={`todo-${todo.n}`} flexDirection="row">
                            <Text dimColor={DONE_TODOS.has(todo.state)} wrap="truncate-end">
                                {`TODO ${todo.n} ${todo.title}`}
                            </Text>
                            <Box flexGrow={1} />
                            <Text dimColor>{todo.state}</Text>
                        </Box>
                    ))}
                </Box>
            ) : null}
        </Box>
    );
}
