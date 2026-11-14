import { Feather } from "@expo/vector-icons";
import { type Href, router, Stack } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useMorningBrief } from "@/features/brief/hooks";
import { commuteLine, isStale, overnightLine, resetLine } from "@/features/brief/queries";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

/**
 * One line of the brief; a tap opens the screen that owns it. `summary` is what the line says in words: a button's
 * label replaces the text inside it for VoiceOver, so the label carries the count, the summary or the temperature too.
 */
function BriefLine({
    testID,
    title,
    summary,
    href,
    children,
}: {
    testID: string;
    title: string;
    summary: string;
    href?: Href;
    children: ReactNode;
}) {
    const c = useThemeColors();
    const body = (
        <View className="gap-1 rounded-2xl p-4" style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border }}>
            <View className="flex-row items-center justify-between">
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>{title}</Text>
                {href ? <Feather name="chevron-right" size={14} color={c.textMuted} /> : null}
            </View>
            {children}
        </View>
    );

    if (!href) {
        return <View testID={testID}>{body}</View>;
    }

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={`${title}: ${summary}`}
            onPress={() => router.push(href)}
        >
            {body}
        </Pressable>
    );
}

/**
 * The morning brief (F29): when to leave, the weather, what the agents did overnight, how many decisions wait and when
 * each account's short window resets. The Mac builds it once a day (the `hub-morning-brief` daemon task, one Waze
 * call) and pushes it; this screen reads the stored copy and never asks Waze.
 */
export default function BriefScreen() {
    const c = useThemeColors();
    const query = useMorningBrief();
    const brief = query.data ?? null;
    const commute = brief ? commuteLine(brief) : null;
    const overnight = brief ? overnightLine(brief) : null;
    const weather = brief?.weather
        ? brief.weather.tempC === null
            ? brief.weather.description
            : `${Math.round(brief.weather.tempC)} °C, ${brief.weather.description}`
        : null;
    const decisions = brief && brief.decisionsWaiting !== null ? `${brief.decisionsWaiting} waiting` : "Could not count";
    const resets = (brief?.resets ?? []).map((reset) => ({
        key: `${reset.provider}-${reset.account}`,
        name: `${reset.account} ${reset.label}`,
        line: resetLine(reset),
        high: reset.utilization >= 80,
    }));

    return (
        <>
            <Stack.Screen options={{ title: "Morning brief" }} />
            <ScrollView
                testID="screen-brief"
                accessibilityLabel="screen-brief"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                contentContainerClassName="gap-3 p-4"
                refreshControl={
                    <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} tintColor={c.accent} />
                }
            >
                <View className="flex-row flex-wrap items-center gap-2">
                    {brief ? (
                        <StatusPill
                            label={`Built ${new Date(brief.generatedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`}
                            tone={isStale(brief, new Date()) ? "danger" : "muted"}
                            normalCase
                        />
                    ) : null}
                    <MockBadge />
                </View>
                {query.isPending ? (
                    <View className="items-center py-10">
                        <ActivityIndicator color={c.accent} />
                    </View>
                ) : query.isError ? (
                    <Text testID="brief-error" style={{ color: c.danger }}>{String(query.error)}</Text>
                ) : !brief ? (
                    <Empty
                        title="No brief yet"
                        hint="The Mac builds one each morning once its daemon task is scheduled (tools hub brief schedule)."
                    />
                ) : (
                    <>
                        {commute && brief.commute ? (
                            <BriefLine testID="brief-commute" title={`${brief.commute.from} → ${brief.commute.to}`} summary={commute}>
                                <Text style={{ color: brief.commute.error ? c.danger : c.textPrimary, fontSize: 17, fontWeight: "600" }}>
                                    {commute}
                                </Text>
                            </BriefLine>
                        ) : null}
                        {weather && brief.weather ? (
                            <BriefLine testID="brief-weather" title={`Weather · ${brief.weather.label}`} summary={weather} href="/weather">
                                <Text style={{ color: c.textPrimary, fontSize: 15 }}>{weather}</Text>
                            </BriefLine>
                        ) : null}
                        <BriefLine testID="brief-decisions" title="Decisions" summary={decisions} href="/needs-input-inbox">
                            <Text style={{ color: brief.decisionsWaiting ? c.warning : c.textPrimary, fontSize: 15 }}>
                                {decisions}
                            </Text>
                        </BriefLine>
                        {overnight && brief.overnight ? (
                            <BriefLine
                                testID="brief-overnight"
                                title="Overnight"
                                summary={[overnight, ...brief.overnight.titles].join(". ")}
                                href="/agents"
                            >
                                <Text style={{ color: c.textPrimary, fontSize: 15 }}>{overnight}</Text>
                                {brief.overnight.titles.map((title) => (
                                    <Text key={title} numberOfLines={1} style={{ color: c.textSecondary, fontSize: 12 }}>
                                        {title}
                                    </Text>
                                ))}
                            </BriefLine>
                        ) : null}
                        {resets.length > 0 ? (
                            <BriefLine
                                testID="brief-resets"
                                title="Short windows"
                                summary={resets.map((reset) => `${reset.name} ${reset.line}`).join(". ")}
                                href="/claude-usage"
                            >
                                {resets.map((reset) => (
                                    <View key={reset.key} className="flex-row justify-between">
                                        <Text style={{ color: c.textSecondary, fontSize: 13 }}>{reset.name}</Text>
                                        <Text
                                            style={{
                                                color: reset.high ? c.warning : c.textPrimary,
                                                fontFamily: "monospace",
                                                fontSize: 12,
                                            }}
                                        >
                                            {reset.line}
                                        </Text>
                                    </View>
                                ))}
                            </BriefLine>
                        ) : null}
                        {brief.warnings.map((warning) => (
                            <Text key={warning} style={{ color: c.textMuted, fontSize: 12 }}>
                                {warning}
                            </Text>
                        ))}
                    </>
                )}
            </ScrollView>
        </>
    );
}
