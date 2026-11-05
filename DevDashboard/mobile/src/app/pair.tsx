import { parsePairingPayload } from "@dd/contract";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { applyPairingUri, type PairingSecrets } from "@/lib/apply-pairing";
import { TIERS } from "@/transport/tiers";
import { Screen } from "@/ui/Screen";

const inputClass =
    "w-full rounded-2xl border border-white/10 bg-dd-bg-base px-4 py-3.5 text-[15px] text-dd-text-primary";

/**
 * Deep-link pairing landing route. iOS routes `devdashboard://pair?tier=…&baseUrl=…&username=…&pk=…` (the desktop
 * "open on phone" hand-off, and the URI the Appium e2e specs inject) here. It rebuilds the canonical pairing URI from
 * the query and connects through the same path as a scanned QR.
 *
 * F5: a link never carries a secret. A `password` in the link is ignored (a link lands in browser history, logs and
 * the clipboard). A link never connects by itself: the screen shows its address and waits for a Pair tap, so a link
 * from anyone cannot point the phone at their server. A tunnel that answers without a password then connects; one
 * that refuses asks for its password here. A managed pairing asks for the one-time code the Mac shows before it
 * connects. `pk` is the agent key the QR codec writes; the older `apk` name is still read.
 */
export default function PairScreen() {
    const params = useLocalSearchParams<{
        tier?: string;
        baseUrl?: string;
        username?: string;
        pk?: string;
        apk?: string;
    }>();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [asking, setAsking] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [secret, setSecret] = useState("");

    const { tier, baseUrl, username, pk, apk } = params;
    const uri = useMemo(() => {
        const fields = { tier, baseUrl, username };
        const query = new URLSearchParams();

        for (const key of ["tier", "baseUrl", "username"] as const) {
            const value = fields[key];

            if (typeof value === "string" && value.length > 0) {
                query.set(key, value);
            }
        }

        const key = pk ?? apk;

        if (typeof key === "string" && key.length > 0) {
            query.set("pk", key);
        }

        return `devdashboard://pair?${query.toString()}`;
    }, [tier, baseUrl, username, pk, apk]);

    const pairing = parsePairingPayload(uri);
    const needsCode = pairing ? TIERS[pairing.tier].pairing === "device-code" : false;

    const pair = useCallback(
        async (secrets: PairingSecrets): Promise<boolean> => {
            setBusy(true);
            setError(null);
            let result: Awaited<ReturnType<typeof applyPairingUri>>;

            try {
                result = await applyPairingUri(uri, secrets);
            } catch (err) {
                result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            } finally {
                setBusy(false);
            }

            if (result.ok) {
                router.replace("/");
                return true;
            }

            setError(result.error ?? "Could not reach the agent with that pairing.");
            return false;
        },
        [uri]
    );

    useEffect(() => {
        // A second link can land while this screen is still mounted: drop what the last link left first.
        setError(null);
        setAsking(false);
        setConfirming(false);
        setSecret("");

        if (!pairing) {
            setError("That is not a DevDashboard pairing link.");
            return;
        }

        if (needsCode) {
            setAsking(true);
            return;
        }

        // The user confirms the address first; then a tunnel without Basic auth connects with no secret.
        setConfirming(true);
        // Key on the link itself; `pairing` is a fresh object each render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uri]);

    const submit = () => void pair(needsCode ? { deviceCode: secret } : { password: secret });
    const confirm = () => {
        setConfirming(false);
        // A refusal asks for the password below.
        void pair({}).then((ok) => setAsking(!ok));
    };

    return (
        <Screen testID="pair-screen">
            <View className="flex-1 items-center justify-center gap-4 p-6">
                {confirming && pairing ? (
                    <View className="w-full gap-3">
                        <Text accessibilityLabel="pair-target" className="text-center text-sm text-dd-text-secondary">
                            {`Connect to ${pairing.baseUrl}?`}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="pair-confirm"
                            disabled={busy}
                            onPress={confirm}
                            className="min-h-11 items-center justify-center rounded-xl bg-dd-accent-from px-4 py-3"
                            style={{ opacity: busy ? 0.6 : 1 }}
                        >
                            <Text className="text-center text-sm font-bold text-dd-bg-base">Pair</Text>
                        </Pressable>
                    </View>
                ) : null}

                {asking && pairing ? (
                    <View className="w-full gap-3">
                        <Text accessibilityLabel="pair-ask" className="text-center text-sm text-dd-text-secondary">
                            {needsCode
                                ? "Type the pairing code your Mac shows."
                                : "This tunnel asks for its password."}
                        </Text>
                        <TextInput
                            accessibilityLabel={needsCode ? "pair-device-code" : "pair-password"}
                            value={secret}
                            onChangeText={setSecret}
                            secureTextEntry={!needsCode}
                            keyboardType={needsCode ? "ascii-capable" : "default"}
                            textContentType={needsCode ? "oneTimeCode" : "password"}
                            autoCapitalize={needsCode ? "characters" : "none"}
                            autoCorrect={false}
                            onSubmitEditing={submit}
                            className={inputClass}
                        />
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="pair-submit"
                            disabled={busy || secret.trim().length === 0}
                            onPress={submit}
                            className="min-h-11 items-center justify-center rounded-xl bg-dd-accent-from px-4 py-3"
                            style={{ opacity: busy || secret.trim().length === 0 ? 0.6 : 1 }}
                        >
                            <Text className="text-center text-sm font-bold text-dd-bg-base">
                                {busy ? "Pairing…" : "Pair"}
                            </Text>
                        </Pressable>
                    </View>
                ) : null}

                {error ? (
                    <Text accessibilityLabel="pair-error" className="text-center text-sm text-dd-danger">
                        {error}
                    </Text>
                ) : null}

                {busy && !asking ? (
                    <>
                        <ActivityIndicator />
                        <Text accessibilityLabel="pair-status" className="text-sm text-dd-text-secondary">
                            Pairing with your agent…
                        </Text>
                    </>
                ) : null}

                {error ? (
                    <Pressable
                        accessibilityLabel="pair-open-connect"
                        onPress={() => router.replace("/connect")}
                        className="rounded-xl border border-dd-border bg-dd-bg-panel px-4 py-3"
                    >
                        <Text className="text-center text-sm font-medium text-dd-text-primary">Connect manually</Text>
                    </Pressable>
                ) : null}
            </View>
        </Screen>
    );
}
