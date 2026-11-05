import type { ApprovalDetailDto, ApprovalReceiptDto, ApprovalVerdictDto, PendingApprovalDto } from "@dd/contract";
import { Stack } from "expo-router";
import { memo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useAnswerApproval, usePendingApprovals } from "@/features/approvals/hooks";
import { BACKEND_LABELS, DIALOG_LABELS, receiptLine } from "@/features/approvals/queries";
import { confirmWithFaceId } from "@/lib/face-id";
import { useThemeColors } from "@/theme/colors";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { StatusPill } from "@/ui/StatusPill";

/** Lines of a diff or a plan shown before "+N more lines". */
const DETAIL_LINES = 24;

function clipped(text: string): { shown: string; more: number } {
    const lines = text.split("\n");
    return { shown: lines.slice(0, DETAIL_LINES).join("\n"), more: Math.max(0, lines.length - DETAIL_LINES) };
}

export function Mono({ text, testID }: { text: string; testID?: string }) {
    const c = useThemeColors();
    const [expanded, setExpanded] = useState(false);
    const { shown, more } = clipped(text);

    return (
        <View className="gap-1 rounded-xl p-3" style={{ backgroundColor: c.bgBase }}>
            <Text testID={testID} selectable style={{ color: c.textPrimary, fontFamily: "monospace", fontSize: 12 }}>
                {expanded ? text : shown}
            </Text>
            {more > 0 ? (
                <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Show fewer lines" : "Show full approval details"}
                    accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)}>
                    <Text style={{ color: c.textMuted, fontSize: 11 }}>
                        {expanded ? "Show fewer lines" : `Show all ${more} more lines`}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

function Detail({ detail, id }: { detail: ApprovalDetailDto; id: string }) {
    const c = useThemeColors();

    if (detail.kind === "command") {
        return (
            <View className="gap-1">
                {detail.description ? <Text style={{ color: c.textSecondary, fontSize: 13 }}>{detail.description}</Text> : null}
                <Mono text={detail.command} testID={`approval-command-${id}`} />
                {detail.cwd ? (
                    <Text numberOfLines={1} style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                        {`in ${detail.cwd}`}
                    </Text>
                ) : null}
            </View>
        );
    }

    if (detail.kind === "file-change") {
        return (
            <View className="gap-2">
                {detail.changes.map((change) => (
                    <View key={change.path} className="gap-1">
                        <Text numberOfLines={1} style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 12 }}>
                            {change.path}
                        </Text>
                        {change.diff !== undefined || change.content !== undefined ? (
                            <Mono text={change.diff ?? change.content ?? ""} />
                        ) : null}
                    </View>
                ))}
            </View>
        );
    }

    return <Mono text={detail.kind === "plan" ? detail.plan : detail.input} testID={`approval-detail-${id}`} />;
}

const VERDICT_LABELS: Readonly<Record<ApprovalVerdictDto, string>> = {
    allow: "Allow",
    "allow-always": "Allow always",
    deny: "Deny",
};

const VERDICTS: readonly ApprovalVerdictDto[] = ["allow", "allow-always", "deny"];

const ApprovalCard = memo(function ApprovalCard({ approval }: { approval: PendingApprovalDto }) {
    const c = useThemeColors();
    const [reason, setReason] = useState("");
    const [receipt, setReceipt] = useState<ApprovalReceiptDto | null>(null);
    const [gateError, setGateError] = useState<string | null>(null);
    const answer = useAnswerApproval(setReceipt);

    // An allow runs something on the Mac, so it needs Face ID; a deny only stops the agent.
    const send = async (verdict: ApprovalVerdictDto) => {
        setGateError(null);

        if (verdict !== "deny") {
            const gate = await confirmWithFaceId(`${VERDICT_LABELS[verdict]} ${approval.tool} on the Mac`);

            if (!gate.ok) {
                setGateError(gate.reason);
                return;
            }
        }

        answer.mutate({
            id: approval.id,
            verdict,
            ...(verdict === "deny" && reason.trim() ? { reason: reason.trim() } : {}),
            idempotencyKey: idempotencyKey(),
        });
    };

    const refusals = VERDICTS
        .map((verdict) => approval.verdicts[verdict])
        .flatMap((support) => (support.supported ? [] : [support.reason]));

    return (
        <View
            testID={`approval-${approval.id}`}
            className="gap-3 rounded-2xl p-4"
            style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.warning }}
        >
            <View className="flex-row flex-wrap items-center gap-2">
                <StatusPill label={DIALOG_LABELS[approval.dialog]} tone="danger" normalCase />
                <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                    {`${approval.provider} · ${BACKEND_LABELS[approval.backend]} · ${approval.tool}`}
                </Text>
            </View>
            {approval.cwd ? (
                <Text numberOfLines={1} style={{ color: c.textSecondary, fontSize: 12 }}>
                    {approval.cwd}
                </Text>
            ) : null}
            <Detail detail={approval.detail} id={approval.id} />
            <TextInput
                testID={`approval-reason-${approval.id}`}
                value={reason}
                onChangeText={setReason}
                placeholder="Reason for a deny (optional)"
                placeholderTextColor={c.textMuted}
                className="rounded-xl px-3 py-2"
                style={{ color: c.textPrimary, borderWidth: 1, borderColor: c.border }}
            />
            <View className="flex-row gap-2">
                {VERDICTS.map((verdict) => {
                    const supported = approval.verdicts[verdict].supported;
                    const tone = verdict === "deny" ? c.danger : c.accent;
                    return (
                        <Pressable
                            key={verdict}
                            testID={`approval-${verdict}-${approval.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={`${VERDICT_LABELS[verdict]} ${approval.tool}`}
                            accessibilityState={{ disabled: !supported || answer.isPending }}
                            disabled={!supported || answer.isPending}
                            onPress={() => void send(verdict)}
                            className="flex-1 items-center rounded-xl py-2.5"
                            style={{
                                borderWidth: 1,
                                borderColor: tone,
                                opacity: !supported ? 0.35 : answer.isPending ? 0.6 : 1,
                            }}
                        >
                            <Text style={{ color: tone, fontWeight: "600" }}>{VERDICT_LABELS[verdict]}</Text>
                        </Pressable>
                    );
                })}
            </View>
            {refusals.map((why) => (
                <Text key={why} style={{ color: c.textMuted, fontSize: 11 }}>
                    {why}
                </Text>
            ))}
            {receipt ? (
                <Text
                    testID={`approval-receipt-${approval.id}`}
                    style={{ color: receipt.outcome === "sent" ? c.accent : c.danger, fontSize: 12 }}
                >
                    {receiptLine(receipt)}
                </Text>
            ) : null}
            {gateError ? <Text style={{ color: c.danger, fontSize: 12 }}>{gateError}</Text> : null}
            {answer.isError ? <Text style={{ color: c.danger, fontSize: 12 }}>{String(answer.error)}</Text> : null}
        </View>
    );
});

/**
 * Approvals (F8): every tool call that waits for allow or deny on the Mac, a terminal's permission or plan dialog or a
 * codex worker's request, with the exact command and folder, the file changes or the plan. Allow asks for Face ID;
 * a deny can carry words for the agent. The receipt says "key sent" or shows the guard's refusal.
 */
export default function ApprovalsScreen() {
    const c = useThemeColors();
    const approvals = usePendingApprovals();
    const pending = approvals.data?.pending ?? [];

    return (
        <>
            <Stack.Screen options={{ title: "Approvals" }} />
            <ScrollView
                testID="screen-approvals"
                accessibilityLabel="screen-approvals"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                keyboardShouldPersistTaps="handled"
                contentContainerClassName="gap-3 p-4"
                refreshControl={
                    <RefreshControl
                        refreshing={approvals.isRefetching}
                        onRefresh={() => void approvals.refetch()}
                        tintColor={c.accent}
                    />
                }
            >
                <View className="flex-row flex-wrap items-center gap-2">
                    <StatusPill label={`${pending.length} waiting`} tone={pending.length > 0 ? "danger" : "muted"} normalCase />
                    <MockBadge />
                </View>
                {approvals.isPending ? (
                    <View className="items-center gap-2 py-10">
                        <ActivityIndicator color={c.accent} />
                    </View>
                ) : approvals.isError ? (
                    <Text testID="approvals-error" style={{ color: c.danger }}>
                        {String(approvals.error)}
                    </Text>
                ) : pending.length === 0 ? (
                    <Empty title="Nothing waits for approval" hint="Permission and plan dialogs, and codex worker requests, show here." />
                ) : (
                    pending.map((approval) => <ApprovalCard key={approval.id} approval={approval} />)
                )}
            </ScrollView>
        </>
    );
}
