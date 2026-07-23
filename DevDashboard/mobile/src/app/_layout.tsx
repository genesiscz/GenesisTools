import "@/global.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ClientProvider } from "@/api/client-provider";
import { queryClient, wireAppStateFocus } from "@/lib/query";
import { useConnection } from "@/state/connection";
import { useConnectionStore } from "@/state/connection-store";
import { ErrorBoundary } from "@/ui/ErrorBoundary";
import { ScreenLoader } from "@/ui/ScreenLoader";

export default function RootLayout() {
    useEffect(() => wireAppStateFocus(), []);

    // Boot-time rehydration: rebuild the last active connection's transport (incl. its SecureStore
    // password) and re-open the gate, so a relaunch lands back in the app instead of dropping to
    // /connect. `restore` swallows its own failures (logs + flips `restored`), so this is safe to
    // fire-and-forget on mount.
    useEffect(() => {
        void useConnectionStore.getState().restore();
    }, []);

    const baseUrl = useConnection((s) => s.baseUrl);
    const restored = useConnectionStore((s) => s.restored);

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaProvider>
                <QueryClientProvider client={queryClient}>
                    <ClientProvider>
                        <ErrorBoundary>
                            {restored ? (
                                // Mount the navigator only AFTER restore resolves, so the
                                // `Stack.Protected` guard sees the final baseUrl on its FIRST render
                                // and picks (tabs) vs connect as the initial route. expo-router does
                                // not auto-navigate when a guard flips later — gating the whole Stack
                                // on `restored` is what makes a paired relaunch land in the app
                                // instead of flashing /connect.
                                <Stack screenOptions={{ headerShown: false }}>
                                    <Stack.Protected guard={baseUrl !== null}>
                                        <Stack.Screen name="(tabs)" />
                                        <Stack.Screen name="(more)" />
                                    </Stack.Protected>
                                    {/* connect/pair stay ALWAYS available (not gated): the
                                        Connections config screen routes to /connect to add a tunnel
                                        while already connected. When baseUrl is null the (tabs) group
                                        is gated out, so the router anchors here at first mount. */}
                                    <Stack.Screen name="connect" />
                                    <Stack.Screen name="pair" />
                                </Stack>
                            ) : (
                                <ScreenLoader />
                            )}
                        </ErrorBoundary>
                    </ClientProvider>
                </QueryClientProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}
