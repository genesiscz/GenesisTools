import { router, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { type PairingLinkParams, usePairingLink } from "@/features/connections/use-pairing-link";
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
 * from anyone cannot point the phone at their server. That holds for a managed link too, before it asks for the
 * one-time code. A tunnel that answers without a password then connects; one that answers 401 asks for its password
 * here. The state and its rules live in `usePairingLink`.
 */
export default function PairScreen() {
    const params = useLocalSearchParams<PairingLinkParams>();
    const { pairing, needsCode, error, busy, asking, confirming, secret, setSecret, submit, confirm } =
        usePairingLink(params);

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
                                ? `Type the pairing code your Mac shows to pair with ${pairing.baseUrl}.`
                                : `${pairing.baseUrl} asks for its password.`}
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
