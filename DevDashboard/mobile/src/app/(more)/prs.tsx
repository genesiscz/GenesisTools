import type { PrFixReceiptDto, PrMergeReceiptDto, PrTriageRowDto, PrTriageVerdict } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { idempotencyKey } from "@/features/answer-queue/units";
import { checksQuery, fixPr, mergePr, triageQuery } from "@/features/prs/queries";
import { confirmWithFaceId } from "@/lib/face-id";
import { type ThemeColors, useThemeColors } from "@/theme/colors";
import { Empty } from "@/ui/Empty";

/** The badge of each readiness verdict. Exhaustive, so a new verdict fails to compile until it has a row. */
const VERDICT_BADGES: Record<PrTriageVerdict, { word: string; tone: keyof Pick<ThemeColors, "accent" | "warning" | "danger" | "textMuted"> }> = {
    ready: { word: "Ready", tone: "accent" },
    waiting: { word: "Waiting", tone: "warning" },
    blocked: { word: "Blocked", tone: "danger" },
    closed: { word: "Closed", tone: "textMuted" },
};

function Badge({ verdict }: { verdict: PrTriageVerdict | null }) {
    const c = useThemeColors();
    const badge = verdict ? VERDICT_BADGES[verdict] : { word: "Unknown", tone: "textMuted" as const };
    const color = c[badge.tone];

    return (
        <View className="self-start rounded-full px-2 py-0.5" style={{ borderWidth: 1, borderColor: color }}>
            <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{badge.word}</Text>
        </View>
    );
}

function ActionButton({
    testID,
    label,
    tone,
    disabled,
    onPress,
}: {
    testID: string;
    label: string;
    tone: string;
    disabled?: boolean;
    onPress: () => void;
}) {
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={label}
            disabled={disabled}
            onPress={onPress}
            className="flex-1 items-center rounded-xl py-2"
            style={{ borderWidth: 1, borderColor: tone, opacity: disabled ? 0.4 : 1 }}
        >
            <Text style={{ color: tone, fontSize: 12, fontWeight: "700" }}>{label}</Text>
        </Pressable>
    );
}

/** One PR opened: its reasons, the failing step's log tail, Fix with agent, and merge after Face ID. */
function PrDetail({ pr }: { pr: PrTriageRowDto }) {
    const c = useThemeColors();
    const client = useDashboardClient();
    const queryClient = useQueryClient();
    const checks = useQuery(checksQuery(client, pr.url, true));
    const [line, setLine] = useState<{ text: string; ok: boolean } | null>(null);

    const fix = useMutation({
        mutationFn: (kind: "threads" | "check") =>
            fixPr(client, {
                url: pr.url,
                checkout: pr.checkout ?? "",
                kind,
                ...(kind === "check" && checks.data?.failing
                    ? { checkUrl: checks.data.failing.url ?? undefined, checkName: checks.data.failing.name }
                    : {}),
                idempotencyKey: idempotencyKey(),
            }),
        onSuccess: (receipt: PrFixReceiptDto) =>
            setLine(
                receipt.sent
                    ? { text: `Sent to ${receipt.owner?.slice(0, 8) ?? "the owner"}: ${receipt.file ?? ""}`, ok: true }
                    : { text: `Not sent: ${receipt.error ?? "no owner session"}`, ok: false }
            ),
        onError: (error) => setLine({ text: `Fix failed: ${String(error)}`, ok: false }),
    });

    const merge = useMutation({
        mutationFn: (method: "rebase" | "squash") => mergePr(client, { url: pr.url, method, idempotencyKey: idempotencyKey() }),
        onSuccess: (receipt: PrMergeReceiptDto) => {
            setLine({ text: receipt.merged ? `Merged (${receipt.method}).` : `Not merged: ${receipt.detail}`, ok: receipt.merged });
            void queryClient.invalidateQueries({ queryKey: ["prs", "triage"] });
        },
        onError: (error) => setLine({ text: `Merge failed: ${String(error)}`, ok: false }),
    });

    const askMerge = (method: "rebase" | "squash") => {
        Alert.alert(`Merge #${pr.number} with ${method}?`, `${pr.repo}: ${pr.title}\n\nThis runs tools github merge --${method} on the Mac.`, [
            { text: "Cancel", style: "cancel" },
            {
                text: "Merge",
                style: "destructive",
                onPress: () =>
                    void confirmWithFaceId(`Merge ${pr.repo}#${pr.number}`).then((gate) => {
                        if (!gate.ok) {
                            setLine({ text: gate.reason, ok: false });
                            return;
                        }

                        merge.mutate(method);
                    }),
            },
        ]);
    };

    const failing = checks.data?.failing ?? null;
    const github = pr.provider === "github";

    return (
        <View testID={`pr-detail-${pr.number}`} className="gap-2 pt-2">
            {pr.reasons.map((reason) => (
                <Text key={reason} style={{ color: c.textSecondary, fontSize: 12 }}>
                    {`· ${reason}`}
                </Text>
            ))}
            {checks.isPending ? <ActivityIndicator color={c.accent} /> : null}
            {failing ? (
                <View className="gap-1 rounded-lg p-2" style={{ backgroundColor: c.bgBase, borderWidth: 1, borderColor: c.border }}>
                    <Text style={{ color: c.danger, fontSize: 12, fontWeight: "700" }}>{failing.name}</Text>
                    <Text testID="pr-failing-log" numberOfLines={14} style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 10 }}>
                        {failing.lines.join("\n") || failing.error || "no log lines"}
                    </Text>
                </View>
            ) : null}
            <View className="flex-row gap-2">
                <ActionButton
                    testID="btn-pr-fix-threads"
                    label={`Fix ${pr.unresolved} thread${pr.unresolved === 1 ? "" : "s"}`}
                    tone={c.accent}
                    disabled={pr.unresolved === 0 || !pr.checkout || fix.isPending}
                    onPress={() => fix.mutate("threads")}
                />
                <ActionButton
                    testID="btn-pr-fix-check"
                    label="Fix failing check"
                    tone={c.warning}
                    disabled={!failing?.url || !pr.checkout || fix.isPending}
                    onPress={() => fix.mutate("check")}
                />
            </View>
            <View className="flex-row gap-2">
                <ActionButton
                    testID="btn-pr-merge-rebase"
                    label="Merge (rebase)"
                    tone={c.danger}
                    disabled={!github || merge.isPending}
                    onPress={() => askMerge("rebase")}
                />
                <ActionButton
                    testID="btn-pr-merge-squash"
                    label="Squash"
                    tone={c.danger}
                    disabled={!github || merge.isPending}
                    onPress={() => askMerge("squash")}
                />
            </View>
            {!github ? (
                <Text style={{ color: c.textMuted, fontSize: 11 }}>A GitLab MR merges from the Mac for now.</Text>
            ) : null}
            {line ? (
                <Text testID="pr-receipt" style={{ color: line.ok ? c.accent : c.danger, fontSize: 12 }}>
                    {line.text}
                </Text>
            ) : null}
        </View>
    );
}

function PrRow({ pr, open, onToggle }: { pr: PrTriageRowDto; open: boolean; onToggle: () => void }) {
    const c = useThemeColors();
    const meta = [`${pr.repo}#${pr.number}`, pr.ci ? `CI ${pr.ci}` : null, pr.unresolved ? `${pr.unresolved} unresolved` : null]
        .filter(Boolean)
        .join(" · ");

    return (
        <View className="rounded-xl p-3" style={{ borderWidth: 1, borderColor: c.border, backgroundColor: c.bgPanel }}>
            <Pressable testID={`pr-${pr.number}`} accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} className="gap-1">
                <View className="flex-row items-center gap-2">
                    <Badge verdict={pr.verdict} />
                    {pr.draft ? <Text style={{ color: c.textMuted, fontSize: 11 }}>Draft</Text> : null}
                    <Text numberOfLines={1} className="flex-1" style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                        {meta}
                    </Text>
                </View>
                <Text numberOfLines={2} style={{ color: c.textPrimary, fontWeight: "700" }}>
                    {pr.title}
                </Text>
                <Text numberOfLines={1} style={{ color: c.textSecondary, fontSize: 12 }}>
                    {pr.summary ?? pr.readinessError ?? ""}
                </Text>
            </Pressable>
            {open ? <PrDetail pr={pr} /> : null}
        </View>
    );
}

/**
 * PR triage (F20): every open PR of the Mac's configured projects with its readiness (ready badge, unresolved
 * threads, CI), ready ones first. A PR opens to its failing step's log tail, Fix with agent (its threads or the
 * failed check go to the session that owns the PR) and a merge through `tools github merge` after Face ID.
 */
export default function PrsScreen() {
    const c = useThemeColors();
    const [mine, setMine] = useState(false);
    const [open, setOpen] = useState<string | null>(null);
    const triage = useQuery(triageQuery(useDashboardClient(), mine));

    return (
        <>
            <Stack.Screen options={{ title: "PR triage" }} />
            <View testID="screen-prs" accessibilityLabel="screen-prs" className="flex-1 bg-dd-bg-base">
                <View className="flex-row gap-2 px-4 pt-3">
                    {[false, true].map((value) => (
                        <Pressable
                            key={String(value)}
                            testID={value ? "prs-filter-mine" : "prs-filter-all"}
                            accessibilityRole="button"
                            accessibilityState={{ selected: mine === value }}
                            onPress={() => setMine(value)}
                            className="rounded-full px-3 py-1.5"
                            style={{ borderWidth: 1, borderColor: mine === value ? c.accent : c.border }}
                        >
                            <Text style={{ color: mine === value ? c.accent : c.textSecondary, fontSize: 12 }}>
                                {value ? "Mine" : "All"}
                            </Text>
                        </Pressable>
                    ))}
                </View>
                {triage.isPending ? (
                    <ActivityIndicator style={{ marginTop: 24 }} color={c.accent} />
                ) : triage.isError ? (
                    <Empty testID="prs-error" title="Could not read the PRs" hint={String(triage.error)} />
                ) : (
                    <FlatList
                        testID="prs-list"
                        data={triage.data.prs}
                        keyExtractor={(pr) => pr.url}
                        renderItem={({ item }) => (
                            <PrRow pr={item} open={open === item.url} onToggle={() => setOpen(open === item.url ? null : item.url)} />
                        )}
                        contentContainerClassName="gap-2 p-4"
                        onRefresh={() => void triage.refetch()}
                        refreshing={triage.isRefetching}
                        ListEmptyComponent={<Empty testID="prs-none" title="No open PRs" hint="Nothing waits in the configured projects." />}
                        ListFooterComponent={
                            triage.data.skipped.length > 0 ? (
                                <Text style={{ color: c.warning, fontSize: 11 }}>
                                    {`Not read: ${triage.data.skipped.map((entry) => `${entry.what} (${entry.reason})`).join(", ")}`}
                                </Text>
                            ) : null
                        }
                    />
                )}
            </View>
        </>
    );
}

