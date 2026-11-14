import type { PrTriageRowDto, PrTriageVerdict } from "@dd/contract";
import * as Linking from "expo-linking";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { useFixPr, useMergePr, usePrChecks } from "@/features/prs/hooks";
import { confirmWithFaceId } from "@/lib/face-id";
import { idempotencyKey } from "@/lib/idempotency";
import { type ThemeColors, useThemeColors } from "@/theme/colors";

/** A line under a PR: what an action did. */
export interface PrLine {
    text: string;
    ok: boolean;
}

/** How many lines of the failing step's log show before "Show the whole log". */
const LOG_LINES_SHOWN = 14;

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

/**
 * One PR opened: its reasons, the failing step's log tail, Fix with agent, and merge after Face ID. A merge receipt
 * goes to the screen (`onMergeLine`), because a merged PR leaves the open-PR list and this row with it.
 */
export function PrDetail({ pr, onMergeLine }: { pr: PrTriageRowDto; onMergeLine: (line: PrLine) => void }) {
    const c = useThemeColors();
    const checks = usePrChecks(pr.url);
    const [line, setLine] = useState<PrLine | null>(null);
    const [wholeLog, setWholeLog] = useState(false);

    const fix = useFixPr({
        onReceipt: (receipt) =>
            setLine(
                receipt.sent
                    ? { text: `Sent to ${receipt.owner?.slice(0, 8) ?? "the owner"}: ${receipt.file ?? ""}`, ok: true }
                    : { text: `Not sent: ${receipt.error ?? "no owner session"}`, ok: false }
            ),
        onError: (error) => setLine({ text: `Fix failed: ${String(error)}`, ok: false }),
    });

    const merge = useMergePr({
        onReceipt: (receipt) =>
            onMergeLine({
                text: receipt.merged
                    ? `${pr.repo}#${pr.number} merged (${receipt.method}).`
                    : `${pr.repo}#${pr.number} not merged: ${receipt.detail}`,
                ok: receipt.merged,
            }),
        onError: (error) => onMergeLine({ text: `${pr.repo}#${pr.number} merge failed: ${String(error)}`, ok: false }),
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

                        merge.mutate({ url: pr.url, method, idempotencyKey: idempotencyKey() });
                    }),
            },
        ]);
    };

    const failing = checks.data?.failing ?? null;
    const failingUrl = failing?.url ?? undefined;
    const github = pr.provider === "github";

    return (
        <View testID={`pr-detail-${pr.number}`} className="gap-2 pt-2">
            {pr.reasons.map((reason) => (
                <Text key={reason} style={{ color: c.textSecondary, fontSize: 12 }}>
                    {`· ${reason}`}
                </Text>
            ))}
            {checks.isPending ? <ActivityIndicator color={c.accent} /> : null}
            {checks.isError ? (
                <View className="flex-row items-center gap-3">
                    <Text testID="pr-checks-error" className="flex-1" style={{ color: c.danger, fontSize: 12 }}>
                        {`Could not read the checks: ${String(checks.error)}`}
                    </Text>
                    <Pressable
                        testID="pr-checks-retry"
                        accessibilityRole="button"
                        hitSlop={8}
                        disabled={checks.isFetching}
                        onPress={() => void checks.refetch()}
                    >
                        <Text style={{ color: c.accent, fontSize: 12 }}>{checks.isFetching ? "Reading…" : "Retry"}</Text>
                    </Pressable>
                </View>
            ) : null}
            {failing ? (
                <View className="gap-1 rounded-lg p-2" style={{ backgroundColor: c.bgBase, borderWidth: 1, borderColor: c.border }}>
                    <Text style={{ color: c.danger, fontSize: 12, fontWeight: "700" }}>{failing.name}</Text>
                    <Text
                        testID="pr-failing-log"
                        selectable
                        numberOfLines={wholeLog ? undefined : LOG_LINES_SHOWN}
                        style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 10 }}
                    >
                        {failing.lines.join("\n") || failing.error || "no log lines"}
                    </Text>
                    <View className="flex-row gap-4">
                        {failing.lines.length > 0 ? (
                            <Pressable testID="pr-log-toggle" accessibilityRole="button" hitSlop={8} onPress={() => setWholeLog((open) => !open)}>
                                <Text style={{ color: c.accent, fontSize: 12 }}>
                                    {wholeLog ? "Show less" : `Show the whole log (${failing.lines.length} lines)`}
                                </Text>
                            </Pressable>
                        ) : null}
                        {failingUrl ? (
                            <Pressable accessibilityRole="link" hitSlop={8} onPress={() => void Linking.openURL(failingUrl)}>
                                <Text style={{ color: c.accent, fontSize: 12 }}>Open the check</Text>
                            </Pressable>
                        ) : null}
                    </View>
                </View>
            ) : null}
            <View className="flex-row gap-2">
                <ActionButton
                    testID="btn-pr-fix-threads"
                    label={`Fix ${pr.unresolved} thread${pr.unresolved === 1 ? "" : "s"}`}
                    tone={c.accent}
                    disabled={pr.unresolved === 0 || !pr.checkout || fix.isPending}
                    onPress={() =>
                        fix.mutate({ url: pr.url, checkout: pr.checkout ?? "", kind: "threads", idempotencyKey: idempotencyKey() })
                    }
                />
                <ActionButton
                    testID="btn-pr-fix-check"
                    label="Fix failing check"
                    tone={c.warning}
                    disabled={!failingUrl || !pr.checkout || fix.isPending}
                    onPress={() =>
                        fix.mutate({
                            url: pr.url,
                            checkout: pr.checkout ?? "",
                            kind: "check",
                            checkUrl: failingUrl,
                            checkName: failing?.name,
                            idempotencyKey: idempotencyKey(),
                        })
                    }
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

export function PrRow({
    pr,
    open,
    onToggle,
    onMergeLine,
}: {
    pr: PrTriageRowDto;
    open: boolean;
    onToggle: () => void;
    onMergeLine: (line: PrLine) => void;
}) {
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
            {open ? <PrDetail pr={pr} onMergeLine={onMergeLine} /> : null}
        </View>
    );
}
