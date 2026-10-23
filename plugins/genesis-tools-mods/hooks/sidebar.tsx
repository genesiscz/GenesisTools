// The sidebar every feature of this plugin opens from the band: a pane the surface docks beside the transcript in
// fullscreen and shows as a dialog above the prompt otherwise, as Claude Code's own `/diff` mod does
// (github.com/anthropics/claude-code, mods/diff/hooks/views). A feature lists its sidebars in `Feature.sidebars`;
// `register.tsx` holds the one `Pane` hook that draws them. The parts below copy the diff mod's look: a header line
// with its controls at the right edge, list rows that are plain dim Buttons with their counts at the right edge,
// dim rules and dim notes.
import type { ElementTable, RenderElement } from "claude-code";
import type { Host } from "./shared";

/** What a sidebar draws with: the surface's elements and the body's size and seat. */
export interface Kit {
    ui: ElementTable;
    columns: number;
    rows: number;
    placement: "dock" | "inline";
}

export interface Sidebar {
    id: string;
    title: string;
    draw: (host: Host, kit: Kit) => RenderElement | Promise<RenderElement>;
}

/** One action or row: its address, its text, and what a press does. */
export interface Pressable {
    key: string;
    label: string;
    onPress: () => void;
    isDim?: boolean;
    isPrimary?: boolean;
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
