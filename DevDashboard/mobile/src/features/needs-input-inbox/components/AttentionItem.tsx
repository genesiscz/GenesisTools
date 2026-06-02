import type { AttentionItem as AttentionItemModel } from "@dd/contract";
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useAttentionTargetStore } from "@/features/needs-input-inbox/attention-target-store";
import { attentionItemTestId, relativeTime } from "@/features/needs-input-inbox/select";
import { Card } from "@/ui/Card";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface AttentionItemProps {
    item: AttentionItemModel;
    /** Marks the QA entry behind a qa-kind item read (the screen's mutation). */
    onResolve: (qaId: string) => void;
}

const KIND_LABEL: Record<AttentionItemModel["kind"], string> = {
    "agent-question": "agent-question",
    "agent-session": "agent-session",
};

/**
 * One attention-queue item (the "Obsidian Terminal" bezel card). Shows a kind pill, the title,
 * subtitle, and relative time. Tapping a terminal item stashes its ttyd id and jumps to Terminals
 * (the deep-link handoff via the target store); tapping a question item resolves it (mark read).
 */
export function AttentionItem({ item, onResolve }: AttentionItemProps) {
    const c = useThemeColors();
    const testId = attentionItemTestId(item.id);
    const tone = item.kind === "agent-question" ? "accent" : "muted";

    const onPress = () => {
        if (item.deepLink.kind === "terminal") {
            useAttentionTargetStore.getState().setPendingTtydId(item.deepLink.ttydTabId);
            router.navigate("/terminals");
        } else {
            onResolve(item.deepLink.qaId);
        }
    };

    return (
        <Pressable testID={testId} accessibilityLabel={testId} accessibilityRole="button" onPress={onPress}>
            <Card bezel className="gap-2">
                <View className="flex-row flex-wrap items-center gap-2">
                    <StatusPill
                        testID={`needs-input-inbox-item-kind-${item.id.replace(/:/g, "-")}`}
                        label={KIND_LABEL[item.kind]}
                        tone={tone}
                        normalCase
                    />
                    <View className="flex-1" />
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {relativeTime(item.ts)}
                    </Text>
                </View>

                <Text className="text-sm font-semibold" style={{ color: c.textPrimary }}>
                    {item.title}
                </Text>
                <Text className="text-xs" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                    {item.subtitle}
                </Text>
            </Card>
        </Pressable>
    );
}
