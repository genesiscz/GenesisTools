import type { TimesheetFillReceiptDto, TimesheetRowDto } from "@dd/contract";
import { Stack } from "expo-router";
import { memo, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useFillWeek, useTimesheetWeek } from "@/features/timesheet/hooks";
import { acceptedForRevision, allAccepted, dayLine, hours, localDay, type ReviewAcceptance } from "@/features/timesheet/queries";
import { ensureDefaultReminder, setReminder } from "@/features/timesheet/reminder";
import { confirmWithFaceId } from "@/lib/face-id";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

const RowCard = memo(function RowCard({ row, accepted, onToggle }: { row: TimesheetRowDto; accepted: boolean; onToggle: () => void }) {
    const c = useThemeColors();

    return (
        <Pressable
            testID={`timesheet-row-${row.code}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: accepted }}
            onPress={onToggle}
            className="gap-1.5 rounded-2xl p-4"
            style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: accepted ? c.accentGlow : c.border }}
        >
            <View className="flex-row items-center gap-2">
                <Text numberOfLines={1} className="flex-1" style={{ color: c.textPrimary, fontWeight: "600" }}>
                    {row.task}
                </Text>
                <Text style={{ color: c.accent, fontFamily: "monospace" }}>{hours(row.totalMinutes)}</Text>
            </View>
            <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>{row.code}</Text>
            <Text style={{ color: c.textSecondary, fontSize: 12 }}>{dayLine(row)}</Text>
            {row.items.slice(0, 3).map((item) => (
                <Text key={`${item.workItemId}-${item.minutes}`} numberOfLines={1} style={{ color: c.textMuted, fontSize: 12 }}>
                    {`${item.workItemId} ${item.title} · ${hours(item.minutes)}`}
                </Text>
            ))}
            {row.clarityMinutes ? (
                <Text style={{ color: c.warning, fontSize: 12 }}>{`Clarity holds ${hours(row.clarityMinutes)} already`}</Text>
            ) : null}
            <Text style={{ color: accepted ? c.accent : c.textMuted, fontSize: 12 }}>{accepted ? "Accepted" : "Tap to accept"}</Text>
        </Pressable>
    );
});

/**
 * The Friday timesheet swipe (F27): this week's Clarity rows with hours from the time logs and the ADO titles. Accept
 * each row, then confirm the fill with Face ID; the Mac writes the week only if it still matches what this screen
 * showed. A weekly reminder on Friday at 15:00 is on by default and has its own switch.
 */
export default function TimesheetScreen() {
    const c = useThemeColors();
    const [date] = useState(localDay);
    const week = useTimesheetWeek(date);
    const [reviewed, setReviewed] = useState<ReviewAcceptance>({ revision: undefined, codes: new Set() });
    const [receipt, setReceipt] = useState<TimesheetFillReceiptDto | null>(null);
    const [gate, setGate] = useState<string | null>(null);
    const [reminder, setReminderOn] = useState<boolean | null>(null);
    const fill = useFillWeek(date, setReceipt);

    useEffect(() => {
        void ensureDefaultReminder().then(setReminderOn);
    }, []);

    const data = week.data;
    const accepted = acceptedForRevision(data, reviewed);
    const ready = allAccepted(data, accepted) && !fill.isPending;
    const toggle = (code: string) =>
        setReviewed((current) => {
            const next = new Set(acceptedForRevision(data, current));

            if (!next.delete(code)) {
                next.add(code);
            }

            return { revision: data?.revision, codes: next };
        });
    const submit = async () => {
        if (!data) {
            return;
        }

        const confirmed = await confirmWithFaceId(`Write ${hours(data.totalMinutes)} into Clarity`);

        if (!confirmed.ok) {
            setGate(confirmed.reason);
            return;
        }

        setGate(null);
        fill.mutate({ timesheetId: data.timesheetId, revision: data.revision, idempotencyKey: idempotencyKey() });
    };

    return (
        <>
            <Stack.Screen options={{ title: "Timesheet" }} />
            <ScrollView
                testID="screen-timesheet"
                accessibilityLabel="screen-timesheet"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                contentContainerClassName="gap-3 p-4"
            >
                <MockBadge />
                <View className="flex-row items-center gap-3">
                    <Text className="flex-1" style={{ color: c.textSecondary, fontSize: 13 }}>
                        Remind me on Fridays at 15:00
                    </Text>
                    <Switch
                        testID="timesheet-reminder"
                        value={reminder ?? false}
                        disabled={reminder === null}
                        onValueChange={(on) => {
                            setReminderOn(on);
                            void setReminder(on);
                        }}
                    />
                </View>
                {week.isPending ? (
                    <ActivityIndicator color={c.accent} />
                ) : week.isError ? (
                    <Text style={{ color: c.danger }}>{String(week.error)}</Text>
                ) : !data ? (
                    <Empty title="No timesheet this week" hint="Clarity has no timesheet for this week yet." />
                ) : (
                    <>
                        <Text style={{ color: c.textPrimary, fontWeight: "700" }}>
                            {`${data.periodStart} to ${data.periodFinish} · ${hours(data.totalMinutes)}`}
                        </Text>
                        {data.unmapped.length > 0 ? (
                            <Text style={{ color: c.warning, fontSize: 12 }}>
                                {`${data.unmapped.length} work item(s) with no Clarity task are left out: ${hours(data.unmapped.reduce((sum, item) => sum + item.minutes, 0))}`}
                            </Text>
                        ) : null}
                        {data.rows.map((row) => (
                            <RowCard key={row.code} row={row} accepted={accepted.has(row.code)} onToggle={() => toggle(row.code)} />
                        ))}
                        <Pressable
                            testID="timesheet-fill"
                            accessibilityRole="button"
                            disabled={!ready}
                            onPress={() => void submit()}
                            className="items-center rounded-xl py-3"
                            style={{ backgroundColor: c.accent, opacity: ready ? 1 : 0.4 }}
                        >
                            <Text style={{ color: c.bgBase, fontWeight: "700" }}>{fill.isPending ? "Filling…" : "Fill with Face ID"}</Text>
                        </Pressable>
                    </>
                )}
                {gate ? <Text style={{ color: c.danger, fontSize: 13 }}>{gate}</Text> : null}
                {receipt ? (
                    <Text testID="timesheet-receipt" style={{ color: receipt.filled ? c.accent : c.danger, fontSize: 13 }}>
                        {receipt.error ?? `Written ${receipt.written}, failed ${receipt.failed}, skipped ${receipt.skipped}.`}
                    </Text>
                ) : null}
                {fill.isError ? <Text style={{ color: c.danger }}>{String(fill.error)}</Text> : null}
            </ScrollView>
        </>
    );
}
