import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { applyPairingUri } from "@/lib/apply-pairing";
import { Screen } from "@/ui/Screen";

/**
 * Deep-link pairing landing route. iOS routes `devdashboard://pair?tier=…&baseUrl=…&username=…`
 * (the desktop "open on phone" hand-off, and the URI the Appium e2e specs inject) here, since
 * expo-router treats the `pair` host as a route path — without this screen it falls through to
 * "Unmatched Route". Reconstructs the canonical pairing URI from the (decoded) query params,
 * applies it through the same path as a scanned QR, then continues into the app on success.
 */
export default function PairScreen() {
    const params = useLocalSearchParams<{
        tier?: string;
        baseUrl?: string;
        username?: string;
        password?: string;
        fp?: string;
        apk?: string;
        relay?: string;
    }>();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function run(): Promise<void> {
            const query = new URLSearchParams();
            for (const key of ["tier", "baseUrl", "username", "fp", "apk", "relay"] as const) {
                const value = params[key];
                if (typeof value === "string" && value.length > 0) {
                    query.set(key, value);
                }
            }

            const uri = `devdashboard://pair?${query.toString()}`;
            const password = typeof params.password === "string" ? params.password : "";
            const result = await applyPairingUri(uri, password);

            if (cancelled) {
                return;
            }

            if (result.ok) {
                router.replace("/");
                return;
            }

            // Reachability failed (or bad payload) — hand off to the connect screen so the user can
            // finish manually (enter a tunnel password, retry, pick another tier).
            setError(result.error ?? "Could not reach the agent with that pairing.");
        }

        void run();

        return () => {
            cancelled = true;
        };
        // params is a fresh object each render; key on the stable string values instead.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params.tier, params.baseUrl, params.username]);

    return (
        <Screen testID="pair-screen">
            <View className="flex-1 items-center justify-center gap-4 p-6">
                {error ? (
                    <>
                        <Text accessibilityLabel="pair-error" className="text-center text-sm text-dd-danger">
                            {error}
                        </Text>
                        <Pressable
                            accessibilityLabel="pair-open-connect"
                            onPress={() => router.replace("/connect")}
                            className="rounded-xl border border-dd-border bg-dd-bg-panel px-4 py-3"
                        >
                            <Text className="text-center text-sm font-medium text-dd-text-primary">
                                Connect manually
                            </Text>
                        </Pressable>
                    </>
                ) : (
                    <>
                        <ActivityIndicator />
                        <Text accessibilityLabel="pair-status" className="text-sm text-dd-text-secondary">
                            Pairing with your agent…
                        </Text>
                    </>
                )}
            </View>
        </Screen>
    );
}
