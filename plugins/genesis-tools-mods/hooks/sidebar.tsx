// The sidebar every feature of this plugin opens from the band: a pane the surface docks beside the transcript in
// fullscreen and shows as a dialog above the prompt otherwise, as Claude Code's own `/diff` mod does
// (github.com/anthropics/claude-code, mods/diff/hooks/views). A feature lists its sidebars in `Feature.sidebars`;
// `register.tsx` holds the one `Pane` hook that draws them. The parts below copy the diff mod's look: a header line
// with its controls at the right edge, list rows that are plain dim Buttons with their counts at the right edge,
// dim rules and dim notes.
//
// A Button with a `hint` says what it does on a dim line under its row while the focus ring is on it (Tab, the
// arrows, a click; the engine runs no plugin code on mere hover). After a press, `pressed()` puts what happened on
// that line instead, in green or red, until the ring moves or 20 seconds pass. `mods.sidebar.hints` and
// `mods.sidebar.feedback` switch them.
import type { ElementTable, RenderElement } from "claude-code";
import { type Host, settingsOf } from "./shared";

/** What a sidebar draws with: the surface's elements, the body's size and seat, and where its focus ring is. */
export interface Kit {
    ui: ElementTable;
    columns: number;
    rows: number;
    placement: "dock" | "inline";
    /** The key of the element the pane's focus ring is on. */
    focused?: string;
    /** Whether a focused Button's `hint` is drawn (`mods.sidebar.hints`). */
    hints?: boolean;
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
    /** Drawn under the row while the focus ring is on this Button: what a press does, with its object. */
    hint?: string;
}

const FEEDBACK_MS = 20_000;

/** What the last press did, for the line under its row. */
let feedback: { key: string; text: string; isOk: boolean; at: number } | undefined;
const focusedIn = new Map<string, string | undefined>();

/** Notes where a pane's focus ring went (`ui.focus`); a move off the last pressed Button ends its feedback. */
export function noteFocus(paneId: string, element: string | undefined): void {
    focusedIn.set(paneId, element);

    if (feedback && feedback.key !== element) {
        feedback = undefined;
    }
}

/** The key the pane's focus ring is on. */
export function focusOf(paneId: string): string | undefined {
    return focusedIn.get(paneId);
}

/** What a press did, on the line under the Button's row (`mods.sidebar.feedback` `line` or `both`). */
export function showFeedback(key: string, text: string, isOk: boolean): void {
    feedback = { key, text, isOk, at: Date.now() };
}

/** Says what a press did: on the line under its row, as a toast, or both (`mods.sidebar.feedback`). */
export async function pressed(host: Host, key: string, text: string, isOk = true): Promise<void> {
    const mode = (await settingsOf(host)).sidebar.feedback;

    if (mode !== "toast") {
        showFeedback(key, text, isOk);
    }

    if (mode !== "line") {
        host.toast(`${isOk ? "✓" : "✗"} ${text}`);
    }

    host.redraw();
}

/** The line under a row of Buttons: what the last press of one of them did, else the focused one's hint. */
export function hintLine(kit: Kit, actions: readonly Pressable[]): RenderElement | null {
    const { Text } = kit.ui;
    const done = feedback;

    if (done && Date.now() - done.at < FEEDBACK_MS && actions.some((action) => action.key === done.key)) {
        return (
            <Text color={done.isOk ? "green" : "red"} wrap="wrap">
                {`${done.isOk ? "✓" : "✗"} ${done.text}`}
            </Text>
        );
    }

    const focused = kit.hints === false ? undefined : actions.find((action) => action.key === kit.focused);

    return focused?.hint ? (
        <Text dimColor wrap="wrap">
            {`${focused.label}: ${focused.hint}`}
        </Text>
    ) : null;
}

/** The sidebar's body; docked, one column of room at the right, as the diff mod leaves. */
export function sidebarFrame(kit: Kit, body: RenderElement): RenderElement {
    const { Box } = kit.ui;

    return (
        <Box flexDirection="column" paddingRight={kit.placement === "dock" ? 1 : 0}>
            {body}
        </Box>
    );
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

/** One list row: a plain Button as wide as its label, a spacer, then the tail at the right edge. */
export function listRow(kit: Kit, row: Pressable, tail: RenderElement | null = null): RenderElement {
    const { Box, Button } = kit.ui;

    return (
        <Box key={`${row.key}:row`} flexDirection="row">
            <Button key={row.key} plain dimColor={row.isDim} onPress={row.onPress}>
                {row.label}
            </Button>
            <Box flexGrow={1} />
            {tail}
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

    return (
        <Button
            key={action.key}
            dimColor={action.isDim}
            {...(action.isPrimary ? ({ variant: "primary" } as const) : {})}
            onPress={action.onPress}
        >
            {action.label}
        </Button>
    );
}

/** A row of action Buttons, wrapped when the body is narrow, with the focused one's hint or the last press's result under it. */
export function actionRow(kit: Kit, actions: readonly Pressable[]): RenderElement {
    const { Box } = kit.ui;

    return (
        <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {actions.map((action) => actionButton(kit, action))}
            </Box>
            {hintLine(kit, actions)}
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
