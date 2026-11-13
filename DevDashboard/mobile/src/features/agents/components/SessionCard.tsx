import type { AgentBoardChild, AgentBoardSession } from "@dd/contract";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { PhaseBadge } from "@/features/agents/components/PhaseBadge";
import { useThemeColors } from "@/theme/colors";

/**
 * How many sub-agents a card lists before "Show N more"; a long-running lead can hold a hundred. The card is the only
 * place that lists them (the session screen shows the transcript), so the rest opens in place.
 */
const CHILDREN_SHOWN = 4;

/** "4 min ago" from epoch ms; the board refreshes often enough that minutes are the right grain. */
export function ago(ms: number | null, now: number): string {
    if (ms === null) {
        return "";
    }

    const minutes = Math.max(0, Math.round((now - ms) / 60_000));

    if (minutes < 1) {
        return "now";
    }

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    return `${Math.round(minutes / 60)} h ago`;
}

function ChildRow({ child, depth }: { child: AgentBoardChild; depth: number }) {
    const c = useThemeColors();

    return (
        <>
            <View
                testID={`agent-child-${child.id}`}
                className="flex-row items-center gap-2"
                style={{ paddingLeft: 12 * depth }}
            >
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>└</Text>
                <Text numberOfLines={1} className="flex-1" style={{ color: c.textSecondary, fontSize: 12 }}>
                    {child.name ?? child.id}
                </Text>
                {child.liveLabel ? (
                    <PhaseBadge label={child.liveLabel} />
                ) : (
                    <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 10 }}>{child.status}</Text>
                )}
            </View>
            {child.children.map((grandchild) => (
                <ChildRow key={grandchild.id} child={grandchild} depth={depth + 1} />
            ))}
        </>
    );
}

/**
 * The card's spoken name: two sessions in one project and phase differ by their title or newest prompt and account,
 * so those are part of it.
 */
export function sessionAccessibilityLabel(session: AgentBoardSession): string {
    return [session.project ?? session.provider, session.label, session.title ?? session.lastPrompt, session.account]
        .filter(Boolean)
        .join(", ");
}

interface SessionCardProps {
    session: AgentBoardSession;
    now: number;
    onOpen: (key: string) => void;
}

/** One live session on the board: phase badge, project, provider, account and model, the newest prompt, sub-agents. */
export const SessionCard = memo(function SessionCard({ session, now, onOpen }: SessionCardProps) {
    const c = useThemeColors();
    const meta = [session.provider, session.account, session.model].filter(Boolean).join(" · ");
    const [expanded, setExpanded] = useState(false);
    const hidden = expanded ? 0 : Math.max(0, session.children.length - CHILDREN_SHOWN);
    const showAll = () => setExpanded(true);

    return (
        <Pressable
            testID={`agent-row-${session.key}`}
            accessibilityRole="button"
            accessibilityLabel={sessionAccessibilityLabel(session)}
            accessibilityActions={hidden > 0 ? [{ name: "showSubAgents", label: `Show ${hidden} more sub-agents` }] : []}
            onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "showSubAgents") {
                    showAll();
                }
            }}
            onPress={() => onOpen(session.key)}
            className="gap-2 rounded-2xl p-4"
            style={{
                backgroundColor: c.bgPanel,
                borderWidth: 1,
                borderColor: session.stalled ? c.danger : c.border,
            }}
        >
            <View className="flex-row items-center gap-2">
                <PhaseBadge label={session.label} testID={`agent-phase-${session.key}`} />
                <Text numberOfLines={1} className="flex-1 text-base font-bold" style={{ color: c.textPrimary }}>
                    {session.project ?? "Unknown project"}
                </Text>
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                    {ago(session.lastActivityAt, now)}
                </Text>
            </View>
            <Text numberOfLines={1} style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 11 }}>
                {meta}
            </Text>
            {session.stuck ? (
                <Text testID={`agent-stuck-${session.key}`} numberOfLines={2} style={{ color: c.danger, fontSize: 12 }}>
                    {session.stuck.detail}
                </Text>
            ) : null}
            {session.lastPrompt ? (
                <Text numberOfLines={2} style={{ color: c.textPrimary, fontSize: 13 }}>
                    <Text style={{ color: c.accent, fontFamily: "monospace" }}>{"› "}</Text>
                    {session.lastPrompt}
                </Text>
            ) : null}
            {session.children.length > 0 ? (
                <View className="gap-1 pt-1">
                    {(expanded ? session.children : session.children.slice(0, CHILDREN_SHOWN)).map((child) => (
                        <ChildRow key={child.id} child={child} depth={0} />
                    ))}
                    {hidden > 0 ? (
                        <Pressable
                            testID={`agent-children-more-${session.key}`}
                            accessibilityRole="button"
                            hitSlop={8}
                            onPress={showAll}
                        >
                            <Text style={{ color: c.accent, fontFamily: "monospace", fontSize: 11 }}>
                                {`Show ${hidden} more`}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
        </Pressable>
    );
});
