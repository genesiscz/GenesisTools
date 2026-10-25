// The sidebar every feature of this plugin opens from the band: a pane the surface docks beside the transcript in
// fullscreen and shows as a dialog above the prompt otherwise, as Claude Code's own `/diff` mod does
// (github.com/anthropics/claude-code, mods/diff/hooks/views). A feature lists its sidebars in `Feature.sidebars`;
// `register.tsx` holds the one `Pane` hook that draws them. The parts below copy the diff mod's look: a header line
// with its controls at the right edge, list rows that are plain dim Buttons with their counts at the right edge,
// dim rules and dim notes.
//
// A Button with a `hint` says what it does in the sidebar's status bar: two rows of its own under a rule at the
// bottom, so nothing above moves when the focus ring does. It shows, in order: what the last press did (`pressed()`:
// busy, done or failed) until the ring moves or 20 seconds pass, the focused Button's hint (Tab, the arrows, a click;
// the engine runs no plugin code on mere hover), else how to reach the hints. Docked, the body fills the pane, so the
// bar sits at its foot. `mods.sidebar.hints` and `mods.sidebar.feedback` switch them.
import type { ElementTable, RenderElement } from "claude-code";
import { type Host, settingsOf } from "./shared";

/** What a sidebar draws with: the surface's elements, the body's size and seat, and where its focus ring is. */
export interface Kit {
    ui: ElementTable;
    columns: number;
    rows: number;
    placement: "dock" | "inline";
    /** Whether the pane holds the keyboard. */
    isFocused?: boolean;
    /** The key of the element the pane's focus ring is on. */
    focused?: string;
    /** The ring moved onto one of the engine's own stops (the close mark, another pane's tab). */
    isOnEngineStop?: boolean;
    /** Whether a focused Button's `hint` is drawn (`mods.sidebar.hints`). */
    hints?: boolean;
    /** Every Button drawn in this pass, for the status bar. */
    pressables?: Pressable[];
}

export interface Sidebar {
    id: string;
    title: string;
    draw: (host: Host, kit: Kit) => RenderElement | Promise<RenderElement>;
}

/** One action or row: its address, its text, what a press does, and what it does in words. */
export interface Pressable {
    key: string;
    label: string;
    onPress: () => void;
    isDim?: boolean;
    isPrimary?: boolean;
    /** A list row drawn bold in this color: the one picked of several. */
    color?: string;
    /** The status bar's line while the focus ring is on this Button: what a press does, as a sentence. */
    hint?: string;
    /** One digit or lowercase letter that presses it while its site holds the keys (not while a field has them). */
    hotkey?: string;
}

const FEEDBACK_MS = 20_000;
const STATUS_ROWS = 2;

type Tone = "busy" | "ok" | "error";

/** What the last press did, for the status bar. */
let feedback: { key: string; text: string; tone: Tone; at: number } | undefined;
const focusedIn = new Map<string, string | undefined>();

/** Notes where a pane's focus ring went (`ui.focus`); a move off the last pressed Button ends its feedback. */
export function noteFocus(paneId: string, element: string | undefined): void {
    focusedIn.set(paneId, element);

    if (feedback && feedback.tone !== "busy" && feedback.key !== element) {
        feedback = undefined;
    }
}

/** The key the pane's focus ring is on; `onEngineStop` when a move took it to the engine's close mark or a tab. */
export function focusOf(paneId: string): { key?: string; onEngineStop: boolean } {
    const key = focusedIn.get(paneId);

    return { key, onEngineStop: focusedIn.has(paneId) && key === undefined };
}

/** Forgets where a pane's ring was: it opens again with the ring on nothing. */
export function forgetFocus(paneId: string): void {
    focusedIn.delete(paneId);
}

/**
 * Says what a press did: in the status bar, as a toast, or both (`mods.sidebar.feedback`). `busy` is for the
 * moment between the press and the result (a `gh` read takes a second); it never goes to a toast.
 */
export async function pressed(host: Host, key: string, text: string, tone: Tone | boolean = "ok"): Promise<void> {
    const kind: Tone = tone === true ? "ok" : tone === false ? "error" : tone;
    const mode = (await settingsOf(host)).sidebar.feedback;

    if (mode !== "toast" || kind === "busy") {
        feedback = { key, text, tone: kind, at: Date.now() };
    }

    if (mode !== "line" && kind !== "busy") {
        host.toast(`${kind === "ok" ? "✓" : "✗"} ${text}`);
    }

    host.redraw();
}

/** The status bar's text: the last press's result, else the focused Button's hint, else how to reach the hints. */
function statusOf(kit: Kit): { text: string; tone: Tone | "hint" | "rest"; label?: string } {
    const done = feedback;

    // A busy line that no result replaced (the work threw) gives way after a minute.
    if (done && Date.now() - done.at < (done.tone === "busy" ? 60_000 : FEEDBACK_MS)) {
        return { text: done.text, tone: done.tone };
    }

    const focused = kit.pressables?.find((action) => action.key === kit.focused);

    if (kit.hints !== false && focused?.hint) {
        return { text: focused.hint, tone: "hint", label: focused.label };
    }

    if (kit.isFocused && kit.isOnEngineStop) {
        return { text: "Enter closes this sidebar. Tab moves on, Esc gives the keys back.", tone: "hint", label: "✕" };
    }

    return {
        text: kit.isFocused
            ? "Tab moves between buttons and this line says what each does. Enter presses, Esc gives the keys back."
            : "Click in this pane (or open it with its slash command), then Tab: this line says what each button does.",
        tone: "rest",
    };
}

/** The status bar: a rule, then two fixed rows. */
function statusBar(kit: Kit): RenderElement {
    const { Box, Text } = kit.ui;
    const status = statusOf(kit);
    const mark = { busy: "… ", ok: "✓ ", error: "✗ ", hint: "", rest: "" }[status.tone];
    const color = { busy: "yellow", ok: "green", error: "red", hint: undefined, rest: undefined }[status.tone];

    return (
        <Box key="sidebar-status" flexDirection="column" flexShrink={0}>
            {divider(kit)}
            <Box height={STATUS_ROWS} overflow="hidden">
                <Text wrap="wrap" color={color} dimColor={status.tone === "rest"}>
                    {status.label ? <Text bold>{`${status.label} `}</Text> : null}
                    {`${mark}${status.text}`}
                </Text>
            </Box>
        </Box>
    );
}

/** The rows the status bar takes: its rule and its two lines. */
export const STATUS_BAR_ROWS = 1 + STATUS_ROWS;

/**
 * The sidebar's body. With a Button that has a hint, the status bar follows it. A body that says how many rows it
 * takes (`bodyRows`, every line one row) and fits with the bar gets the bar pinned to the pane's foot, so it stays
 * in view; a taller body scrolls, the bar after it. One column of room at the right when docked, as the diff mod leaves.
 */
export function sidebarFrame(kit: Kit, body: RenderElement, bodyRows?: number): RenderElement {
    const { Box } = kit.ui;
    const hasBar = Boolean(kit.pressables?.some((action) => action.hint));
    const docked = kit.placement === "dock";
    const pinned = hasBar && docked && bodyRows !== undefined && bodyRows + STATUS_BAR_ROWS <= kit.rows;

    return (
        <Box flexDirection="column" paddingRight={docked ? 1 : 0} {...(pinned ? { height: kit.rows } : {})}>
            {body}
            {pinned ? <Box flexGrow={1} /> : null}
            {hasBar ? statusBar(kit) : null}
        </Box>
    );
}

/** One row of a counted body: whatever it holds, cut to one row. */
export function line(kit: Kit, key: string, content: RenderElement | null): RenderElement {
    const { Box } = kit.ui;

    return (
        <Box key={key} height={1} overflow="hidden" flexDirection="row">
            {content}
        </Box>
    );
}

/** Text wrapped at word breaks into lines of `width` columns, at most `max` of them, the last cut with `…`. */
export function wrapWords(text: string, width: number, max: number): string[] {
    const room = Math.max(4, width);
    const lines: string[] = [];
    let current = "";

    for (const word of text.split(/\s+/).filter(Boolean)) {
        const next = current ? `${current} ${word}` : word;

        if ([...next].length <= room) {
            current = next;
            continue;
        }

        if (current) {
            lines.push(current);
        }

        current = [...word].length > room ? `${[...word].slice(0, room - 1).join("")}…` : word;
    }

    if (current) {
        lines.push(current);
    }

    if (lines.length <= max) {
        return lines;
    }

    const kept = lines.slice(0, max);
    const last = [...(kept[max - 1] ?? "")];
    kept[max - 1] = `${last.slice(0, Math.max(0, room - 1)).join("")}…`;

    return kept;
}

/** The columns a row of Buttons takes: `[ label ]` each, one column between. */
export function buttonsWidth(actions: readonly Pick<Pressable, "label">[]): number {
    return actions.reduce((sum, action, index) => sum + [...action.label].length + 4 + (index ? 1 : 0), 0);
}

/** The first line: what the sidebar counts, a spacer, its controls at the right edge. */
export function headerRow(kit: Kit, left: RenderElement, controls: readonly Pressable[] = []): RenderElement {
    const { Box } = kit.ui;

    return (
        <Box flexDirection="row" height={1}>
            {left}
            <Box flexGrow={1} />
            <Box flexDirection="row" columnGap={1} marginLeft={1}>
                {controls.map((control) => actionButton(kit, control))}
            </Box>
        </Box>
    );
}

/**
 * One list row: a plain Button as wide as its label, a spacer, then the tail at the right edge. The tail keeps its
 * width; a label too long for the rest wraps beside it.
 */
export function listRow(kit: Kit, row: Pressable, tail: RenderElement | null = null): RenderElement {
    const { Box, Button, Text } = kit.ui;
    kit.pressables?.push(row);

    return (
        <Box key={`${row.key}:row`} flexDirection="row">
            <Box flexShrink={1} minWidth={0}>
                <Button key={row.key} plain dimColor={row.isDim} onPress={row.onPress}>
                    {row.color ? (
                        <Text color={row.color} bold>
                            {row.label}
                        </Text>
                    ) : (
                        row.label
                    )}
                </Button>
            </Box>
            <Box flexGrow={1} />
            {tail ? (
                // Shrinks first: a long tail (a staged answer, a long status) once took the row and drew the label
                // one character per line.
                <Box flexShrink={4} minWidth={0} marginLeft={1}>
                    {tail}
                </Box>
            ) : null}
        </Box>
    );
}

export function divider(kit: Kit): RenderElement {
    const { Text } = kit.ui;

    return (
        <Text dimColor wrap="truncate-end">
            {"─".repeat(Math.max(1, kit.columns))}
        </Text>
    );
}

export function dimNote(kit: Kit, text: string, key?: string): RenderElement {
    const { Text } = kit.ui;

    return (
        <Text key={key} dimColor wrap="truncate-end">
            {text}
        </Text>
    );
}

/** A heading inside the body: bold, with a dim note after it. */
export function sectionTitle(kit: Kit, title: string, note = ""): RenderElement {
    const { Text } = kit.ui;

    return (
        <Text wrap="truncate-end">
            <Text bold>{title}</Text>
            <Text dimColor>{note ? ` ${note}` : ""}</Text>
        </Text>
    );
}

export function actionButton(kit: Kit, action: Pressable): RenderElement {
    const { Button } = kit.ui;
    kit.pressables?.push(action);

    return (
        <Button
            key={action.key}
            dimColor={action.isDim}
            {...(action.isPrimary ? ({ variant: "primary" } as const) : {})}
            {...(action.hotkey ? { hotkey: action.hotkey } : {})}
            onPress={action.onPress}
        >
            {action.label}
        </Button>
    );
}

/** A row of action Buttons, wrapped when the body is narrow. */
export function actionRow(kit: Kit, actions: readonly Pressable[]): RenderElement {
    const { Box } = kit.ui;

    return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {actions.map((action) => actionButton(kit, action))}
        </Box>
    );
}

/** `1 tool`, `3 tools`. */
export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A bar of `width` cells, full to `share` (0 to 1), as the diff mod's todo bar draws one. */
export function barText(share: number, width: number): string {
    const full = Math.round(Math.min(1, Math.max(0, share)) * width);

    return `${"█".repeat(full)}${"░".repeat(width - full)}`;
}
