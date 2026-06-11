import { View } from "react-native";
import type { NetStatus } from "@/features/network-status/types";
import { DASH, latencyText, qualityLabel, qualityTone, transportLabel } from "@/features/network-status/units";
import { Card } from "@/ui/Card";
import { KeyValueRow } from "@/ui/KeyValueRow";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";

interface StatusCardProps {
    status: NetStatus;
}

/**
 * Network health card: a quality pill (Healthy/Degraded/Down) + a key/value summary of the active
 * link (transport, latency, SSID, public IP). Mirrors `DaemonStatusHeader`. testIDs are namespaced
 * `network-status-*` so the Appium spec asserts real derived state.
 */
export function StatusCard({ status }: StatusCardProps) {
    return (
        <Card testID="network-status-card" className="gap-3">
            <View className="flex-row items-center justify-between">
                <SectionHeader title="Active link" />
                <StatusPill
                    testID="network-status-pill"
                    label={qualityLabel(status.quality)}
                    tone={qualityTone(status.quality)}
                    dot
                />
            </View>
            <KeyValueRow testID="network-status-transport" label="Transport" value={transportLabel(status.transport)} />
            <KeyValueRow testID="network-status-latency" label="Latency" value={latencyText(status.latencyMs)} />
            <KeyValueRow testID="network-status-ssid" label="Wi-Fi" value={status.ssid ?? DASH} />
            <KeyValueRow testID="network-status-public-ip" label="Public IP" value={status.publicIp ?? DASH} />
        </Card>
    );
}
