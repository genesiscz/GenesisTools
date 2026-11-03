import { router } from "expo-router";
import { useReducer, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { QrScanner } from "@/components/connect/QrScanner";
import { ReachabilityBadge } from "@/components/connect/ReachabilityBadge";
import { TierPicker } from "@/components/connect/TierPicker";
import { applyPairingUri } from "@/lib/apply-pairing";
import { parseScannedPairing } from "@/lib/qr";
import { type ConnectResult, useConnectionStore } from "@/state/connection-store";
import { useThemeColors } from "@/theme/colors";
import { useZeroconfDiscovery } from "@/transport/lan-discovery";
import { FAILURE_MESSAGE, reachabilityReducer } from "@/transport/reachability";
import { TIERS } from "@/transport/tiers";
import { openTailscaleApp } from "@/transport/tiers/tailscale";
import type { TransportTier } from "@/transport/Transport";
import { Card } from "@/ui/Card";
import { Screen } from "@/ui/Screen";

const inputClass =
    "rounded-2xl border border-white/10 bg-dd-bg-base px-4 py-3.5 text-[15px] text-dd-text-primary";
const placeholderColor = "#5b6670";

/**
 * Soft mesh-orb glow layer (the Obsidian-Terminal background "wow"). RN can't do CSS radial
 * gradients / blur pseudo-elements, so this fakes the look with large, very-translucent rounded
 * Views — an emerald orb top-left, a violet orb mid-right, a fainter emerald orb bottom. Purely
 * decorative + non-interactive; sits behind the `relative z-10`-equivalent content stack.
 */
function MeshOrbs() {
    const c = useThemeColors();

    return (
        <View pointerEvents="none" className="absolute inset-0 overflow-hidden">
            <View
                className="absolute h-80 w-80 rounded-full opacity-[0.18]"
                style={{ backgroundColor: c.accent, top: -120, left: -90 }}
            />
            <View
                className="absolute h-72 w-72 rounded-full opacity-[0.14]"
                style={{ backgroundColor: "#8b5cf6", top: "32%", right: -110 }}
            />
            <View
                className="absolute h-64 w-64 rounded-full opacity-[0.10]"
                style={{ backgroundColor: c.accent, bottom: -110, left: "22%" }}
            />
        </View>
    );
}

/** Mono uppercase eyebrow label — the "signature tell" of this design system. */
function Eyebrow({ label, tone = "accent" }: { label: string; tone?: "accent" | "violet" }) {
    const c = useThemeColors();
    const fg = tone === "violet" ? "#a78bfa" : c.accent;

    return (
        <View className="self-start rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
            <Text className="text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: fg, fontFamily: "monospace" }}>
                {label}
            </Text>
        </View>
    );
}

/** Primary emerald pressable (the design system's CTA), keeps the caller's accessibility label. */
function PrimaryButton({
    label,
    onPress,
    accessibilityLabel,
}: {
    label: string;
    onPress: () => void;
    accessibilityLabel: string;
}) {
    return (
        <Pressable
            accessibilityLabel={accessibilityLabel}
            onPress={onPress}
            className="rounded-2xl bg-dd-accent-from px-5 py-3.5 active:scale-[0.98]"
            style={{ borderCurve: "continuous" }}
        >
            <Text className="text-center text-[15px] font-bold text-dd-bg-base">{label}</Text>
        </Pressable>
    );
}

/** Ghost pressable (secondary action) — translucent glass with hairline border. */
function GhostButton({
    label,
    onPress,
    accessibilityLabel,
}: {
    label: string;
    onPress: () => void;
    accessibilityLabel: string;
}) {
    return (
        <Pressable
            accessibilityLabel={accessibilityLabel}
            onPress={onPress}
            className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3.5 active:opacity-80"
            style={{ borderCurve: "continuous" }}
        >
            <Text className="text-center text-[15px] font-semibold text-dd-text-primary">{label}</Text>
        </Pressable>
    );
}

/**
 * Connect / Pair screen (plan 02), restyled to the "Obsidian Terminal" design system: mesh-orb
 * glow background, double-bezel section cards, mono uppercase eyebrows, emerald primary + violet
 * secondary accents. Tier picker → per-tier reachability + pairing flow: LAN (zeroconf discovery
 * + creds), Tailscale (deep-link + probe), self-cloudflared / managed (scan the pairing QR).
 * Every interactive element keeps the stable `accessibilityLabel` that the ConnectPage Appium
 * Page Object + e2e specs locate by.
 *
 * MERGE-TODO: load a Fontshare display font (Clash Display / General Sans) via expo-font and apply
 * it to the headings/eyebrows; until then headings use the system default and labels use the system
 * mono so nothing renders as a silent fallback to an unloaded family.
 */
export default function ConnectScreen() {
    const c = useThemeColors();
    const [tier, setTier] = useState<TransportTier | null>(null);
    const [reach, dispatchReach] = useReducer(reachabilityReducer, { kind: "idle" } as const);
    const [error, setError] = useState<string | null>(null);

    // LAN / cloudflared credentials (a tunnel/LAN endpoint is Basic-auth protected).
    const [lanHost, setLanHost] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");

    const connect = useConnectionStore((s) => s.connect);
    const [deviceCode, setDeviceCode] = useState("");
    // F5: the LAN discovery hook (mDNS `_devdashboard._tcp`) fills the address with one tap.
    const discovery = useZeroconfDiscovery();

    /** Shows a connect result on the badge; a failure committed nothing, so the app stays on its old Mac. */
    function show(result: ConnectResult): void {
        if (result.ok) {
            dispatchReach({ type: "probe-ok" });
            return;
        }

        setError(result.error ?? FAILURE_MESSAGE[result.failure]);
        dispatchReach({ type: "probe-fail", failure: result.failure === "error" ? "unreachable" : result.failure });
    }

    async function connectLan(): Promise<void> {
        setError(null);

        try {
            const cleaned = lanHost.replace(/\/+$/, "");
            const url = new URL(cleaned.startsWith("http") ? cleaned : `http://${cleaned}`);
            const port = url.port ? Number.parseInt(url.port, 10) : 3042;
            // D38: the iOS simulator resolves `localhost` to IPv6 `::1`, but dev-dashboard agents
            // bind IPv4-only — so a probe to `http://localhost:3042` reaches nothing. Rewrite the
            // literal hostname `localhost` to `127.0.0.1` (only that exact host) so the baseUrl
            // targets the IPv4 loopback the agent is actually listening on.
            const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
            const baseUrl = `http://${host}:${port}`;
            console.log(`[connect] connectLan tier=lan baseUrl=${baseUrl}`);
            dispatchReach({ type: "probe-start" });
            show(await connect({ tier: "lan", label: host, baseUrl, host, port, username, password }));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function connectTailscale(): Promise<void> {
        setError(null);

        try {
            const [host, portStr] = lanHost.replace(/^https?:\/\//, "").split(":");
            const port = portStr ? Number.parseInt(portStr, 10) : 3042;

            // Unlike connectLan this path never goes through `new URL()`, so nothing has rejected a
            // non-numeric or out-of-range port yet; without this it persists as `http://host:NaN`.
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error("Invalid port. Use a value between 1 and 65535.");
            }

            const baseUrl = `http://${host}:${port}`;
            console.log(`[connect] connectTailscale tier=tailscale baseUrl=${baseUrl}`);
            dispatchReach({ type: "probe-start" });
            show(await connect({ tier: "tailscale", baseUrl, host, port, username, password }));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    /** Returns whether the code was accepted, so the scanner can keep scanning after a rejection. */
    async function onQrScanned(data: string): Promise<boolean> {
        setError(null);

        if (!parseScannedPairing(data)) {
            setError("That QR is not a DevDashboard pairing code.");
            return false;
        }

        // Same path as a deep-link pair (see app/pair.tsx): applyPairingUri connects through the session, which
        // pairs, probes and commits only on success; the local reducer drives the badge.
        dispatchReach({ type: "probe-start" });
        const result = await applyPairingUri(data, { password, deviceCode });

        if (result.ok) {
            dispatchReach({ type: "probe-ok" });
            return true;
        }

        setError(result.error ?? "Pairing failed.");
        dispatchReach({ type: "probe-fail", failure: tier ? TIERS[tier].probeFailure : "unreachable" });
        return false;
    }

    return (
        <Screen testID="connect-screen">
            <MeshOrbs />

            <View className="gap-6">
                <View className="gap-3 pt-2">
                    <Eyebrow label="Pair · DevDashboard" />
                    <Text
                        accessibilityLabel="connect-title"
                        className="text-[34px] font-bold leading-[1.05] tracking-[-0.02em] text-dd-text-primary"
                    >
                        Connect to your Mac
                    </Text>
                    <Text className="text-[15px] leading-6 text-dd-text-secondary">
                        Pick how this device reaches your DevDashboard agent.
                    </Text>
                </View>

                <Card bezel className="gap-4">
                    <View className="flex-row items-center justify-between">
                        <Eyebrow label="Transport" />
                        <ReachabilityBadge state={reach} />
                    </View>
                    <TierPicker selected={tier} onSelect={setTier} />
                </Card>

                {tier === "lan" ? (
                    <Card bezel featured className="gap-4">
                        <Eyebrow label="LAN · credentials" />
                        <View accessibilityLabel="lan-agent-list" className="gap-3">
                            <Text className="text-xs leading-5 text-dd-text-muted">
                                {discovery.scanning ? "Looking for Macs on this network…" : "Tap a Mac found on this network, or type its address."}
                            </Text>
                            {discovery.agents.map((agent) => (
                                <GhostButton
                                    key={agent.baseUrl}
                                    accessibilityLabel={`lan-found-${agent.host}`}
                                    label={`${agent.name} · ${agent.host}:${agent.port}`}
                                    onPress={() => setLanHost(`${agent.host}:${agent.port}`)}
                                />
                            ))}
                            <TextInput
                                accessibilityLabel="lan-host"
                                value={lanHost}
                                onChangeText={setLanHost}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                placeholder="192.168.1.10:3042"
                                placeholderTextColor={placeholderColor}
                                className={inputClass}
                            />
                            <TextInput
                                accessibilityLabel="lan-username"
                                value={username}
                                onChangeText={setUsername}
                                autoCapitalize="none"
                                autoCorrect={false}
                                placeholder="username"
                                placeholderTextColor={placeholderColor}
                                className={inputClass}
                            />
                            <TextInput
                                accessibilityLabel="lan-password"
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                placeholder="password"
                                placeholderTextColor={placeholderColor}
                                className={inputClass}
                            />
                            <PrimaryButton accessibilityLabel="lan-connect" label="Connect" onPress={connectLan} />
                        </View>
                    </Card>
                ) : null}

                {tier === "tailscale" ? (
                    <Card bezel featured className="gap-4">
                        <Eyebrow label="Tailscale · WireGuard" />
                        <View accessibilityLabel="tailscale-panel" className="gap-3">
                            <Text className="text-sm leading-5 text-dd-text-secondary">
                                Turn on the Tailscale VPN, then probe reachability.
                            </Text>
                            <TextInput
                                accessibilityLabel="tailscale-host"
                                value={lanHost}
                                onChangeText={setLanHost}
                                autoCapitalize="none"
                                autoCorrect={false}
                                placeholder="mac.tailnet-name.ts.net:3042"
                                placeholderTextColor={placeholderColor}
                                className={inputClass}
                            />
                            <TextInput
                                accessibilityLabel="tailscale-username"
                                value={username}
                                onChangeText={setUsername}
                                autoCapitalize="none"
                                autoCorrect={false}
                                placeholder="username"
                                placeholderTextColor={placeholderColor}
                                className={inputClass}
                            />
                            <TextInput
                                accessibilityLabel="tailscale-password"
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                placeholder="password"
                                placeholderTextColor={placeholderColor}
                                className={inputClass}
                            />
                            <GhostButton accessibilityLabel="open-tailscale" label="Open Tailscale" onPress={openTailscaleApp} />
                            <PrimaryButton
                                accessibilityLabel="tailscale-probe"
                                label="Check reachability"
                                onPress={connectTailscale}
                            />
                        </View>
                    </Card>
                ) : null}

                {tier === "cloudflared-self" || tier === "managed" ? (
                    <Card bezel featured className="gap-4">
                        <Eyebrow label={tier === "managed" ? "Managed · scan" : "Cloudflare · scan"} tone="violet" />
                        <View accessibilityLabel="pair-panel" className="gap-3">
                            {TIERS[tier].pairing === "device-code" ? (
                                <TextInput
                                    accessibilityLabel="pair-device-code"
                                    value={deviceCode}
                                    onChangeText={setDeviceCode}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="number-pad"
                                    textContentType="oneTimeCode"
                                    placeholder="pairing code shown on your Mac"
                                    placeholderTextColor={placeholderColor}
                                    className={inputClass}
                                />
                            ) : null}
                            {tier === "cloudflared-self" ? (
                                <TextInput
                                    accessibilityLabel="pair-password"
                                    value={password}
                                    onChangeText={setPassword}
                                    secureTextEntry
                                    placeholder="password (for your tunnel's Basic auth)"
                                    placeholderTextColor={placeholderColor}
                                    className={inputClass}
                                />
                            ) : null}
                            <Text className="text-xs leading-5 text-dd-text-muted">
                                Scan the pairing QR shown by your DevDashboard agent.
                            </Text>
                            <View
                                className="h-80 overflow-hidden rounded-[20px] border border-white/10 bg-black/40"
                                style={{ borderCurve: "continuous" }}
                            >
                                <QrScanner onScanned={onQrScanned} />
                            </View>
                        </View>
                    </Card>
                ) : null}

                {error ? (
                    <View
                        className="rounded-2xl border px-4 py-3"
                        style={{ borderCurve: "continuous", borderColor: c.danger, backgroundColor: "rgba(248,113,113,0.10)" }}
                    >
                        <Text accessibilityLabel="connect-error" selectable className="text-xs leading-5 text-dd-danger">
                            {error}
                        </Text>
                    </View>
                ) : null}

                {reach.kind === "reachable" ? (
                    <PrimaryButton
                        accessibilityLabel="connect-continue"
                        label="Continue"
                        onPress={() => router.replace("/")}
                    />
                ) : null}
            </View>
        </Screen>
    );
}
