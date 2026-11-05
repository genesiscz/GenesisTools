import { ENDPOINTS } from "@dd/contract";
import * as Notifications from "expo-notifications";
import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useDashboardClient, useIsMockClient } from "@/api/client-provider";
import { idempotencyKey } from "@/features/answer-queue/units";
import { getPref, setPref } from "@/lib/storage/kv";
import { pushIdentity } from "@/push/push-keys";
import { registerForPush } from "@/push/push";
import { useThemeColors } from "@/theme/colors";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";

type Registration = { state: "working" } | { state: "registered" } | { state: "refused"; reason: string };

/**
 * Push to this phone (F2): the permission, the registration with the connected Mac, and a test notice with two answer
 * buttons. Long-press the notice on the lock screen to see the buttons; they answer nothing (their tokens are dummies).
 */
export default function NotificationsScreen() {
    const c = useThemeColors();
    const client = useDashboardClient();
    const isMock = useIsMockClient();
    const [permission, setPermission] = useState<string>("…");
    const [registration, setRegistration] = useState<Registration>({ state: "working" });
    const [test, setTest] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [badge, setBadge] = useState(true);

    useEffect(() => {
        void getPref("dd.iconBadge").then((saved) => setBadge(saved !== "off"));
    }, []);

    const toggleBadge = (on: boolean) => {
        setBadge(on);
        void setPref("dd.iconBadge", on ? "waiting" : "off");
    };

    const register = useCallback(async () => {
        setRegistration({ state: "working" });

        try {
            const reason = await registerForPush();
            setRegistration(reason ? { state: "refused", reason } : { state: "registered" });
        } catch (err) {
            setRegistration({ state: "refused", reason: err instanceof Error ? err.message : String(err) });
        }

        setPermission((await Notifications.getPermissionsAsync()).status);
    }, [client]);

    useEffect(() => {
        void register();
    }, [register]);

    const sendTest = async () => {
        setSending(true);

        try {
            const { id } = await pushIdentity();
            const receipt = await client.call(ENDPOINTS.pushTest, { id }, { idempotencyKey: idempotencyKey() });
            setTest(receipt.ok ? "Sent. Lock the phone or look at the notification list." : (receipt.detail ?? "Not sent."));
        } catch (err) {
            setTest(err instanceof Error ? err.message : String(err));
        } finally {
            setSending(false);
        }
    };

    const pill =
        registration.state === "registered"
            ? { label: "registered", tone: "accent" as const }
            : registration.state === "working"
              ? { label: "registering", tone: "muted" as const }
              : { label: "not registered", tone: "danger" as const };

    return (
        <>
            <Stack.Screen options={{ title: "Notifications" }} />
            <ScrollView testID="screen-notifications" contentContainerClassName="gap-4 p-4">
                {isMock ? <MockBadge /> : null}
                <SectionHeader title="This phone" />
                <View className="gap-2 rounded-2xl p-4" style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border }}>
                    <View className="flex-row items-center gap-2">
                        <StatusPill label={pill.label} tone={pill.tone} normalCase />
                        <Text style={{ color: c.textMuted, fontSize: 12 }}>{`Permission: ${permission}`}</Text>
                    </View>
                    {registration.state === "refused" ? (
                        <Text style={{ color: c.textSecondary, fontSize: 13 }}>{registration.reason}</Text>
                    ) : null}
                    <Text style={{ color: c.textMuted, fontSize: 12 }}>
                        The Mac pushes each decision that waits for you, with a button per option letter. A button answers
                        unlocks and opens the app before submitting your answer; the receipt arrives as a notice.
                    </Text>
                </View>
                <Pressable
                    testID="btn-push-test"
                    accessibilityRole="button"
                    accessibilityLabel="Send a test notification"
                    disabled={registration.state !== "registered" || sending}
                    onPress={() => void sendTest()}
                    className="items-center rounded-xl py-3"
                    style={{
                        backgroundColor: c.bgPanel,
                        borderWidth: 1,
                        borderColor: c.border,
                        opacity: registration.state === "registered" ? 1 : 0.5,
                    }}
                >
                    {sending ? (
                        <ActivityIndicator color={c.textPrimary} />
                    ) : (
                        <Text style={{ color: c.textPrimary, fontWeight: "600" }}>Send a test notification</Text>
                    )}
                </Pressable>
                {test ? <Text style={{ color: c.textSecondary, fontSize: 13 }}>{test}</Text> : null}
                <View
                    className="flex-row items-center gap-3 rounded-2xl p-4"
                    style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border }}
                >
                    <View className="flex-1 gap-1">
                        <Text style={{ color: c.textPrimary, fontWeight: "600" }}>Waiting count on the app icon</Text>
                        <Text style={{ color: c.textMuted, fontSize: 12 }}>
                            Decisions, forms, open dialogs and tool calls that wait for you. Applies from the next start.
                        </Text>
                    </View>
                    <Switch
                        testID="switch-icon-badge"
                        accessibilityLabel="Waiting count on the app icon"
                        value={badge}
                        onValueChange={toggleBadge}
                    />
                </View>
                <Pressable
                    testID="btn-push-register"
                    accessibilityRole="button"
                    accessibilityLabel="Register again"
                    onPress={() => void register()}
                    className="items-center py-2"
                >
                    <Text style={{ color: c.textMuted, fontSize: 13 }}>Register again</Text>
                </Pressable>
            </ScrollView>
        </>
    );
}
