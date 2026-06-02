import type { CmuxSnapshot, TmuxHubSession, TtydSession } from "@dd/contract";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import {
    useCmuxAttach,
    useCmuxSnapshot,
    useCreateTmux,
    useKillTtyd,
    useRenameTmux,
    useRenameTtyd,
    useSpawnTtyd,
    useTmuxSessions,
    useTtydSessions,
} from "@/features/terminals/hooks";
import { SwipeableActionRow } from "@/features/terminals/components/SwipeableActionRow";
import { Card } from "@/ui/Card";
import { Empty } from "@/ui/Empty";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

/**
 * The session inventory across tmux / ttyd / cmux (D12, parity with the web dashboard). Reads via
 * the Terminals hooks (D32 — never raw useQuery) and exposes the actions: Open/Attach a tmux session
 * (spawning a ttyd for it when none exists), Open/Rename/Kill a ttyd session, Rename a tmux session,
 * create a new tmux session, and focus a cmux pane in the native cmux app. Rows are table-like
 * (hairline separators, generous vertical rhythm) and swipe right-to-left to reveal contextual
 * actions.
 *
 * `accessibilityLabel`s (`session-row-<name>`, `btn-open-<name>`, `btn-attach-<name>`,
 * `btn-rename-tmux-<name>`, `btn-open-ttyd-<id>`, `btn-rename-<id>`, `btn-kill-<id>`,
 * `cmux-row-<id>`, `btn-new-session`) are baked in for Appium — swipe actions render as hidden
 * `Pressable`s so each testID is reachable without performing the gesture.
 */

interface SessionsListProps {
    /** Open a ttyd session id in the terminal view (the screen drives the renderer attach). */
    onOpen: (ttydId: string, title?: string) => void;
}

// Element types derived from the exported snapshot — the contract does not re-export the element
// types directly, but they are reachable through the snapshot's array fields.
type CmuxWorkspace = CmuxSnapshot["workspaces"][number];
type CmuxPane = CmuxSnapshot["panes"][number];

function ActionButton({
    label,
    onPress,
    testID,
    tone = "accent",
}: {
    label: string;
    onPress: () => void;
    testID: string;
    tone?: "accent" | "danger";
}) {
    const c = useThemeColors();
    const fg = tone === "danger" ? c.danger : c.accent;

    return (
        <Pressable
            testID={testID}
            accessibilityLabel={testID}
            accessibilityRole="button"
            onPress={onPress}
            style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                marginLeft: 8,
                borderRadius: 7,
                borderWidth: 1,
                borderColor: fg,
            }}
        >
            <Text style={{ color: fg, fontFamily: "monospace", fontSize: 12 }}>{label}</Text>
        </Pressable>
    );
}

/** Table-like row surface: a solid panel row with comfortable padding; the caller adds a separator. */
function RowSurface({
    children,
    testID,
    onPress,
}: {
    children: ReactNode;
    testID: string;
    onPress?: () => void;
}) {
    const c = useThemeColors();
    const body = (
        <View
            style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingVertical: 12,
                paddingHorizontal: 14,
                backgroundColor: c.bgPanel,
            }}
        >
            {children}
        </View>
    );

    if (onPress) {
        return (
            <Pressable testID={testID} accessibilityLabel={testID} accessibilityRole="button" onPress={onPress}>
                {body}
            </Pressable>
        );
    }

    return (
        <View testID={testID} accessibilityLabel={testID}>
            {body}
        </View>
    );
}

/** A thin hairline shown between rows (skipped before the first row) for the table look. */
function RowSeparator() {
    const c = useThemeColors();

    return <View style={{ height: 1, backgroundColor: c.border }} />;
}

/** Shell commands not worth surfacing as an auto-name — fall back to tmux/command instead. */
const UNINTERESTING_TTYD_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "login", "tmux"]);

/**
 * Best display name for a ttyd terminal, mirroring the server's `deriveTtydDisplayName` precedence so
 * a MANUAL rename always wins and the auto-name never overwrites it:
 * manual `name` → live `lastCommand` (when meaningful) → tmux session → spawn command.
 */
function ttydDisplayName(s: TtydSession): string {
    const manual = s.name?.trim();

    if (manual) {
        return manual;
    }

    const lastCommand = s.lastCommand?.trim();

    if (lastCommand && !UNINTERESTING_TTYD_COMMANDS.has(lastCommand)) {
        return lastCommand;
    }

    return s.tmuxSessionName ?? s.command;
}

export function SessionsList({ onOpen }: SessionsListProps) {
    const c = useThemeColors();
    const tmux = useTmuxSessions();
    const ttyd = useTtydSessions();
    const cmux = useCmuxSnapshot();
    const spawn = useSpawnTtyd();
    const kill = useKillTtyd();
    const renameTtyd = useRenameTtyd();
    const renameTmux = useRenameTmux();
    const createTmux = useCreateTmux();
    const cmuxAttach = useCmuxAttach();

    const tmuxSessions: TmuxHubSession[] = tmux.data?.sessions ?? [];
    const ttydSessions: TtydSession[] = ttyd.data?.sessions ?? [];
    const cmuxWorkspaces: CmuxWorkspace[] = cmux.data?.snapshot.workspaces ?? [];
    const cmuxPanes: CmuxPane[] = cmux.data?.snapshot.panes ?? [];

    const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

    // The selected cmux workspace; defaults to the first as soon as a snapshot arrives.
    const workspace = useMemo<CmuxWorkspace | null>(() => {
        if (cmuxWorkspaces.length === 0) {
            return null;
        }

        return cmuxWorkspaces.find((w) => w.id === activeWorkspace) ?? cmuxWorkspaces[0];
    }, [cmuxWorkspaces, activeWorkspace]);

    // Panes belonging to the active workspace (the web reference flattens panes by workspaceId).
    const visiblePanes = useMemo<CmuxPane[]>(() => {
        if (!workspace) {
            return cmuxPanes;
        }

        return cmuxPanes.filter((p) => p.workspaceId === workspace.id);
    }, [workspace, cmuxPanes]);

    const promptRenameTtyd = (id: string, current: string) => {
        // Alert.prompt is iOS-only (RN core); this app is iOS-first. On platforms without it the
        // button is a no-op rather than a crash (the hook itself is platform-agnostic).
        if (typeof Alert.prompt !== "function") {
            return;
        }

        Alert.prompt(
            "Rename terminal",
            undefined,
            (next) => {
                const name = next?.trim();
                if (name) {
                    renameTtyd.mutate({ id, name });
                }
            },
            "plain-text",
            current,
        );
    };

    const promptRenameTmux = (current: string) => {
        if (typeof Alert.prompt !== "function") {
            return;
        }

        Alert.prompt(
            "Rename tmux session",
            undefined,
            (next) => {
                const to = next?.trim();
                if (to && to !== current) {
                    renameTmux.mutate({ from: current, to });
                }
            },
            "plain-text",
            current,
        );
    };

    const openTmux = async (session: TmuxHubSession) => {
        const existing = session.ttydTabIds[0];
        if (existing) {
            onOpen(existing, session.name);
            return;
        }

        const res = await spawn.mutateAsync({ tmuxSessionName: session.name });
        onOpen(res.session.id, session.name);
    };

    // When the snapshot resolves a pane's tmux-backed terminal to a ttyd session (`ttydSessionId`,
    // populated server-side by enrichPanesWithTtyd), tapping the pane OPENS it as a real terminal —
    // the same surface the tmux/ttyd rows use. Otherwise (browser/editor panes, or no ttyd) fall back
    // to focusing it in the native cmux app via `cmux.attach`, the web pane-toolbar action.
    const openCmuxPane = (pane: CmuxPane) => {
        if (pane.ttydSessionId) {
            onOpen(pane.ttydSessionId, pane.title);
            return;
        }

        cmuxAttach.mutate({ workspaceId: pane.workspaceId, paneId: pane.id });
    };

    return (
        <View style={{ gap: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <SectionHeader title="tmux sessions" testID="terminals-tmux-header" />
                <ActionButton label="+ New" testID="btn-new-session" onPress={() => createTmux.mutate({})} />
            </View>
            <Card testID="terminals-tmux-card" className="overflow-hidden p-0">
                {tmuxSessions.length === 0 ? (
                    <Empty title="No tmux sessions" />
                ) : (
                    tmuxSessions.map((s, i) => {
                        const isAttached = s.attached > 0;

                        return (
                            <View key={s.name}>
                                {i > 0 ? <RowSeparator /> : null}
                                <SwipeableActionRow
                                    actions={[
                                        {
                                            label: "Rename",
                                            testID: `btn-rename-tmux-${s.name}`,
                                            onPress: () => promptRenameTmux(s.name),
                                        },
                                        {
                                            label: isAttached ? "Attach" : "Open",
                                            testID: isAttached ? `btn-attach-${s.name}` : `btn-open-${s.name}`,
                                            onPress: () => void openTmux(s),
                                        },
                                    ]}
                                >
                                    <RowSurface testID={`session-row-${s.name}`}>
                                        <Text
                                            numberOfLines={1}
                                            style={{ color: c.textSecondary, fontFamily: "monospace", flex: 1, paddingRight: 8 }}
                                        >
                                            {s.name}  ·  {s.windows}w
                                        </Text>
                                        <View style={{ flexDirection: "row", alignItems: "center" }}>
                                            {isAttached ? <StatusPill label="attached" tone="accent" dot /> : null}
                                            {s.inCmux ? <StatusPill label="cmux" tone="muted" /> : null}
                                            <ActionButton
                                                label={isAttached ? "Attach" : "Open"}
                                                testID={isAttached ? `btn-attach-${s.name}` : `btn-open-${s.name}`}
                                                onPress={() => void openTmux(s)}
                                            />
                                        </View>
                                    </RowSurface>
                                </SwipeableActionRow>
                            </View>
                        );
                    })
                )}
            </Card>

            <SectionHeader title="ttyd terminals" testID="terminals-ttyd-header" />
            <Card testID="terminals-ttyd-card" className="overflow-hidden p-0">
                {ttydSessions.length === 0 ? (
                    <Empty title="No live ttyd terminals" />
                ) : (
                    ttydSessions.map((s, i) => {
                        const label = ttydDisplayName(s);

                        return (
                            <View key={s.id}>
                                {i > 0 ? <RowSeparator /> : null}
                                <SwipeableActionRow
                                    actions={[
                                        {
                                            label: "Rename",
                                            testID: `btn-rename-${s.id}`,
                                            onPress: () => promptRenameTtyd(s.id, label),
                                        },
                                        {
                                            label: "Kill",
                                            tone: "danger",
                                            testID: `btn-kill-${s.id}`,
                                            onPress: () => kill.mutate({ id: s.id }),
                                        },
                                    ]}
                                >
                                    <RowSurface testID={`ttyd-row-${s.id}`}>
                                        <View style={{ flex: 1, paddingRight: 8 }}>
                                            <Text numberOfLines={1} style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                                                {label}
                                            </Text>
                                            <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11, marginTop: 2 }}>
                                                :{s.port}
                                            </Text>
                                        </View>
                                        <View style={{ flexDirection: "row", alignItems: "center" }}>
                                            <ActionButton
                                                label="Open"
                                                testID={`btn-open-ttyd-${s.id}`}
                                                onPress={() => onOpen(s.id, label)}
                                            />
                                            <ActionButton
                                                label="Kill"
                                                tone="danger"
                                                testID={`btn-kill-${s.id}`}
                                                onPress={() => kill.mutate({ id: s.id })}
                                            />
                                        </View>
                                    </RowSurface>
                                </SwipeableActionRow>
                            </View>
                        );
                    })
                )}
            </Card>

            <SectionHeader title="cmux panes" testID="terminals-cmux-header" />
            {cmuxWorkspaces.length > 1 ? (
                <View testID="cmux-workspace-tabs" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {cmuxWorkspaces.map((w) => {
                        const isActive = w.id === workspace?.id;
                        const count = cmuxPanes.filter((p) => p.workspaceId === w.id).length;

                        return (
                            <Pressable
                                key={w.id}
                                testID={`cmux-workspace-${w.id}`}
                                accessibilityLabel={`cmux-workspace-${w.id}`}
                                accessibilityRole="button"
                                accessibilityState={{ selected: isActive }}
                                onPress={() => setActiveWorkspace(w.id)}
                                style={{
                                    paddingHorizontal: 12,
                                    paddingVertical: 6,
                                    borderRadius: 8,
                                    borderWidth: 1,
                                    borderColor: isActive ? c.accent : c.border,
                                    backgroundColor: isActive ? c.accentMuted : c.bgPanel,
                                }}
                            >
                                <Text
                                    style={{
                                        color: isActive ? c.accent : c.textSecondary,
                                        fontFamily: "monospace",
                                        fontSize: 12,
                                    }}
                                >
                                    {w.name} · {count}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            ) : null}
            <Card testID="terminals-cmux-card" className="overflow-hidden p-0">
                {visiblePanes.length === 0 ? (
                    <Empty title="cmux not available" />
                ) : (
                    visiblePanes.map((p, i) => (
                        <View key={p.id}>
                            {i > 0 ? <RowSeparator /> : null}
                            <RowSurface testID={`cmux-row-${p.id}`} onPress={() => openCmuxPane(p)}>
                                <View style={{ flex: 1, paddingRight: 8 }}>
                                    <Text numberOfLines={1} style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                                        {p.title}
                                    </Text>
                                    {p.cwd ? (
                                        <Text
                                            numberOfLines={1}
                                            style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11, marginTop: 2 }}
                                        >
                                            {p.cwd}
                                        </Text>
                                    ) : null}
                                </View>
                                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                                    {p.active ? <StatusPill label="active" tone="accent" dot /> : null}
                                    <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                                        {p.surfaceCount} surface{p.surfaceCount === 1 ? "" : "s"}
                                    </Text>
                                </View>
                            </RowSurface>
                        </View>
                    ))
                )}
            </Card>

            {tmux.isError || ttyd.isError ? (
                <Text testID="terminals-error" style={{ color: c.danger, fontFamily: "monospace", fontSize: 12 }}>
                    Some session sources are unavailable.
                </Text>
            ) : null}
        </View>
    );
}
