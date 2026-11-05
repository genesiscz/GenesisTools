import "@/global.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { type ReactNode, useEffect, useMemo } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ClientProvider } from "@/api/client-provider";
import { wireAppStateFocus } from "@/lib/query";
import { LiveCacheProvider } from "@/live/provider";
import { GlanceBadge } from "@/features/glance/GlanceBadge";
import { registerForPush, startPush } from "@/push/push";
import { createConnectionQueryClient } from "@/lib/query-client";
import { useConnectionStore } from "@/state/connection-store";
import { ErrorBoundary } from "@/ui/ErrorBoundary";
import { ScreenLoader } from "@/ui/ScreenLoader";

// Before React mounts: an answer pressed on the lock screen launches the app in the background (F7).
startPush();

export default function RootLayout() {
    useEffect(() => wireAppStateFocus(), []);

    // Boot-time rehydration: rebuild the last active connection's transport (incl. its SecureStore
    // password) and re-open the gate, so a relaunch lands back in the app instead of dropping to
    // /connect. `restore` swallows its own failures (logs + flips `restored`), so this is safe to
    // fire-and-forget on mount.
    useEffect(() => {
        void useConnectionStore.getState().restore();
    }, []);

    // Every connect registers this install for push with that Mac (F2): a new token or a new Mac is picked up.
    const transport = useConnectionStore((s) => s.transport);
    useEffect(() => {
        if (!transport) {
            return;
        }

        void registerForPush()
            .then((reason) => reason && console.warn(`[push] not registered: ${reason}`))
            .catch((err: unknown) => console.warn("[push] register", err));
    }, [transport]);

    const connected = useConnectionStore((s) => s.transport !== null);
    const restored = useConnectionStore((s) => s.restored);
    const sessionGeneration = useConnectionStore((s) => s.sessionGeneration);

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaProvider>
                <ConnectionSession key={sessionGeneration}>
                    <ErrorBoundary>
                        {restored ? (
                            // Mount the navigator only AFTER restore resolves, so the
                            // `Stack.Protected` guard sees the final transport on its FIRST render
                            // and picks (tabs) vs connect as the initial route. expo-router does
                            // not auto-navigate when a guard flips later — gating the whole Stack
                            // on `restored` is what makes a paired relaunch land in the app
                            // instead of flashing /connect.
                            <Stack screenOptions={{ headerShown: false }}>
                                <Stack.Protected guard={connected}>
                                    <Stack.Screen name="(tabs)" />
                                    <Stack.Screen name="(more)" />
                                </Stack.Protected>
                                {/* connect/pair stay ALWAYS available (not gated): the
                                        Connections config screen routes to /connect to add a tunnel
                                        while already connected. With no transport the (tabs) group
                                        is gated out, so the router anchors here at first mount. */}
                                <Stack.Screen name="connect" />
                                <Stack.Screen name="pair" />
                            </Stack>
                        ) : (
                            <ScreenLoader />
                        )}
                    </ErrorBoundary>
                </ConnectionSession>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}

function ConnectionSession({ children }: { children: ReactNode }) {
    const queryClient = useMemo(() => createConnectionQueryClient(), []);

    useEffect(
        () => () => {
            queryClient.clear();
        },
        [queryClient]
    );

    return (
        <QueryClientProvider client={queryClient}>
            <ClientProvider>
                <LiveCacheProvider>
                    <GlanceBadge />
                    {children}
                </LiveCacheProvider>
            </ClientProvider>
        </QueryClientProvider>
    );
}
