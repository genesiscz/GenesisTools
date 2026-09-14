import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import { ConnectionForm, type ConnectionFormValues } from "@/features/connections/ConnectionForm";
import { ConnectionRow } from "@/features/connections/ConnectionRow";
import { Eyebrow, GhostButton, MeshOrbs, PrimaryButton } from "@/features/connections/components";
import type { SavedConnection } from "@/features/connections/types";
import { useConnectionStore } from "@/state/connection-store";
import { useThemeColors } from "@/theme/colors";
import { Card } from "@/ui/Card";
import { Empty } from "@/ui/Empty";
import { Loading } from "@/ui/Loading";
import { Screen } from "@/ui/Screen";
import { SectionHeader } from "@/ui/SectionHeader";

interface ParsedHost {
    host: string;
    port: number;
    baseUrl: string;
}

/**
 * Parses a free-form `host[:port]` (or full URL) the same way the Connect screen does: defaults the
 * port to 3042 and rewrites the literal `localhost` to the IPv4 loopback (the iOS simulator resolves
 * `localhost` to IPv6 `::1`, but dev-dashboard agents bind IPv4-only).
 */
function parseHostInput(value: string): ParsedHost {
    const cleaned = value.replace(/\/+$/, "");
    const url = new URL(cleaned.startsWith("http") ? cleaned : `http://${cleaned}`);
    const port = url.port ? Number.parseInt(url.port, 10) : 3042;
    const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
    return { host, port, baseUrl: `http://${host}:${port}` };
}

type Mode = { kind: "list" } | { kind: "add" } | { kind: "edit"; connection: SavedConnection };

export function ConnectionsScreen() {
    const c = useThemeColors();
    const connections = useConnectionStore((s) => s.connections);
    const activeId = useConnectionStore((s) => s.activeId);
    const listConnections = useConnectionStore((s) => s.listConnections);
    const addConnection = useConnectionStore((s) => s.addConnection);
    const activateConnection = useConnectionStore((s) => s.activateConnection);
    const updateConnection = useConnectionStore((s) => s.updateConnection);
    const removeConnection = useConnectionStore((s) => s.removeConnection);

    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [mode, setMode] = useState<Mode>({ kind: "list" });
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            await listConnections();
        } catch (err) {
            console.warn("[connections] failed to list connections", err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [listConnections]);

    // Re-sync on focus (not just mount) so a connection paired via the Connect screen shows up when
    // the user navigates back here.
    useFocusEffect(
        useCallback(() => {
            void refresh();
        }, [refresh]),
    );

    async function onActivate(id: string): Promise<void> {
        if (busy) {
            return;
        }

        setError(null);
        setBusy(true);

        try {
            await activateConnection(id);
        } catch (err) {
            console.warn(`[connections] failed to activate ${id}`, err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function onAdd(values: ConnectionFormValues): Promise<void> {
        if (busy) {
            return;
        }

        setError(null);

        if (!values.host) {
            setError("Enter the agent host (e.g. 192.168.1.10:3042).");
            return;
        }

        setBusy(true);

        try {
            const { host, port, baseUrl } = parseHostInput(values.host);
            const id = await addConnection({
                tier: "lan",
                label: values.label || undefined,
                baseUrl,
                host,
                port,
                username: values.username,
                password: values.password,
            });
            await activateConnection(id);
            setMode({ kind: "list" });
        } catch (err) {
            console.warn("[connections] failed to add connection", err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function onEdit(connection: SavedConnection, values: ConnectionFormValues): Promise<void> {
        if (busy) {
            return;
        }

        setError(null);
        setBusy(true);

        try {
            const parsed = values.host ? parseHostInput(values.host) : null;
            await updateConnection(connection.id, {
                label: values.label || undefined,
                host: parsed?.host,
                port: parsed?.port,
                baseUrl: parsed?.baseUrl,
                username: values.username,
                password: values.password ? values.password : undefined,
            });
            setMode({ kind: "list" });
        } catch (err) {
            console.warn(`[connections] failed to edit ${connection.id}`, err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function onDelete(connection: SavedConnection): void {
        Alert.alert(
            "Delete connection",
            `Remove "${connection.label}"? Its saved password will be erased.`,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => {
                        void (async () => {
                            setError(null);

                            try {
                                await removeConnection(connection.id);
                            } catch (err) {
                                console.warn(`[connections] failed to delete ${connection.id}`, err);
                                setError(err instanceof Error ? err.message : String(err));
                            }
                        })();
                    },
                },
            ],
        );
    }

    if (loading) {
        return (
            <Screen testID="screen-connections">
                <Loading label="Loading connections…" />
            </Screen>
        );
    }

    return (
        <Screen testID="screen-connections">
            <MeshOrbs />

            <View className="gap-6">
                <View className="gap-3 pt-2">
                    <Eyebrow label="Connections · DevDashboard" />
                    <Text className="text-[30px] font-bold leading-[1.05] tracking-[-0.02em] text-dd-text-primary">
                        Your Macs
                    </Text>
                    <Text className="text-[15px] leading-6 text-dd-text-secondary">
                        Save multiple agents and switch between them. Activating one re-points the
                        whole app at that machine.
                    </Text>
                </View>

                {error ? (
                    <View
                        className="rounded-2xl border px-4 py-3"
                        style={{
                            borderCurve: "continuous",
                            borderColor: c.danger,
                            backgroundColor: "rgba(248,113,113,0.10)",
                        }}
                    >
                        <Text
                            accessibilityLabel="connections-error"
                            selectable
                            className="text-xs leading-5 text-dd-danger"
                        >
                            {error}
                        </Text>
                    </View>
                ) : null}

                {mode.kind === "add" ? (
                    <ConnectionForm
                        mode="add"
                        onSubmit={onAdd}
                        onCancel={() => setMode({ kind: "list" })}
                    />
                ) : null}

                {mode.kind === "edit" ? (
                    <ConnectionForm
                        mode="edit"
                        initial={mode.connection}
                        onSubmit={(values) => onEdit(mode.connection, values)}
                        onCancel={() => setMode({ kind: "list" })}
                    />
                ) : null}

                {mode.kind === "list" ? (
                    <View className="gap-4">
                        <SectionHeader title="Saved" />

                        {connections.length === 0 ? (
                            <Card bezel className="gap-4">
                                <Empty
                                    testID="connections-empty"
                                    title="No saved connections"
                                    hint="Add one below, or pair from Connect to get started."
                                />
                                <PrimaryButton
                                    testID="btn-empty-connect"
                                    accessibilityLabel="btn-empty-connect"
                                    label="Pair from Connect"
                                    onPress={() => router.push("/connect")}
                                />
                            </Card>
                        ) : (
                            <View className="gap-4">
                                {connections.map((connection) => (
                                    <ConnectionRow
                                        key={connection.id}
                                        connection={connection}
                                        active={connection.id === activeId}
                                        onActivate={() => onActivate(connection.id)}
                                        onEdit={() => setMode({ kind: "edit", connection })}
                                        onDelete={() => onDelete(connection)}
                                    />
                                ))}
                            </View>
                        )}

                        <View className="gap-3 pt-1">
                            <PrimaryButton
                                testID="btn-add-connection"
                                accessibilityLabel="btn-add-connection"
                                label="Add LAN connection"
                                onPress={() => {
                                    setError(null);
                                    setMode({ kind: "add" });
                                }}
                            />
                            <GhostButton
                                testID="btn-pair-connect"
                                accessibilityLabel="btn-pair-connect"
                                label="Pair another way (Tailscale · Cloudflare)"
                                onPress={() => router.push("/connect")}
                            />
                        </View>
                    </View>
                ) : null}

                {busy ? (
                    <Text className="text-center text-xs text-dd-text-muted">Working…</Text>
                ) : null}
            </View>
        </Screen>
    );
}
