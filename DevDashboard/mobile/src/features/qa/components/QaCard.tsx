import type { QaRow } from "@dd/contract";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { QaAnswerHtml } from "@/features/qa/components/QaAnswerHtml";
import { answerPreview, DASH, isAnswerTruncated, relativeTime, tagTone } from "@/features/qa/units";
import { Card } from "@/ui/Card";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface QaCardProps {
    entry: QaRow;
    unread: boolean;
    /** Tap toggles read/unread for this entry (persisted by the screen's mutation). */
    onToggleRead: (id: string, nextUnread: boolean) => void;
}

/**
 * One Q&A entry card (the "Obsidian Terminal" panel look). Shows the project + tag pill + relative
 * time, the question, and a collapsible answer body. An unread entry carries an accent left border +
 * a per-id `new` badge (`qa-unread-badge-<id>` for the Appium mark-read assertion). Tapping the card
 * toggles read/unread; a long answer expands inline. Field access is defensive (thin mock fixtures).
 */
export function QaCard({ entry, unread, onToggleRead }: QaCardProps) {
    const c = useThemeColors();
    const [expanded, setExpanded] = useState(false);
    const truncated = isAnswerTruncated(entry.answerMd);
    const id = entry.id ?? "";

    // Collapsed: cheap plain-text preview. Expanded: rich web-parity HTML in a WebView (heavy, so only
    // mounted on expand) when the server enriched the answer; otherwise the plain markdown text.
    const collapsedAnswer = answerPreview(entry.answerMd);
    const hasRichAnswer = typeof entry.answerHtml === "string" && entry.answerHtml.length > 0;

    return (
        <Pressable
            testID={`qa-card-${id}`}
            accessibilityLabel={`qa-card-${id}`}
            accessibilityRole="button"
            onPress={() => onToggleRead(id, !unread)}
        >
            <Card
                className="gap-3"
                style={{ borderColor: unread ? c.accent : c.border }}
            >
                <View className="flex-row flex-wrap items-center gap-2">
                    {unread ? (
                        <View
                            testID={`qa-unread-badge-${id}`}
                            accessibilityLabel={`qa-unread-badge-${id}`}
                            className="rounded-full px-2 py-0.5"
                            style={{ backgroundColor: c.accentMuted }}
                        >
                            <Text
                                className="text-[10px] font-bold uppercase tracking-widest"
                                style={{ color: c.accent, fontFamily: "monospace" }}
                            >
                                new
                            </Text>
                        </View>
                    ) : null}
                    <StatusPill label={entry.tag ?? "qa"} tone={tagTone(entry.tag)} />
                    <Text className="text-xs" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                        {entry.project || DASH}
                    </Text>
                    <View className="flex-1" />
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {relativeTime(entry.ts)}
                    </Text>
                </View>

                <Text className="text-[10px] uppercase tracking-widest" style={{ color: c.textMuted }}>
                    Question
                </Text>
                <Text className="text-sm font-semibold" style={{ color: c.textPrimary }}>
                    {entry.question || DASH}
                </Text>

                <Text className="text-[10px] uppercase tracking-widest" style={{ color: c.textMuted }}>
                    Answer
                </Text>
                {expanded && hasRichAnswer ? (
                    <QaAnswerHtml testID={`qa-answer-${id}`} html={entry.answerHtml} />
                ) : (
                    <Text testID={`qa-answer-${id}`} className="text-[13px]" style={{ color: c.textPrimary }}>
                        {expanded ? (entry.answerMd ?? DASH) : collapsedAnswer}
                    </Text>
                )}

                {truncated || hasRichAnswer ? (
                    <Pressable
                        testID={`qa-expand-${id}`}
                        accessibilityLabel={`qa-expand-${id}`}
                        accessibilityRole="button"
                        hitSlop={8}
                        onPress={() => setExpanded((v) => !v)}
                    >
                        <Text className="text-xs" style={{ color: c.accent, fontFamily: "monospace" }}>
                            {expanded ? "▴ collapse" : "▾ expand full answer"}
                        </Text>
                    </Pressable>
                ) : null}
            </Card>
        </Pressable>
    );
}
