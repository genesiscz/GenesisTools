import type { DaemonOverview } from "@dd/contract";
import { View } from "react-native";
import { Card } from "@/ui/Card";
import { KeyValueRow } from "@/ui/KeyValueRow";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";

interface DaemonStatusHeaderProps {
    overview: DaemonOverview;
}

/**
 * Daemon status header (feature-local Tier-2): an install/run status pill + a key/value summary
 * (PID, task count, enabled count). testID `daemon-status-header`; the pill is `daemon-status-pill`.
 */
export function DaemonStatusHeader({ overview }: DaemonStatusHeaderProps) {
    const { status, tasks } = overview;
    const enabledCount = tasks.filter((task) => task.enabled).length;

    const tone = status.running ? "accent" : status.installed ? "muted" : "danger";
    const label = status.running ? "Running" : status.installed ? "Stopped" : "Not installed";

    return (
        <Card testID="daemon-status-header" className="gap-3">
            <View className="flex-row items-center justify-between">
                <SectionHeader title="Daemon" />
                <StatusPill testID="daemon-status-pill" label={label} tone={tone} dot />
            </View>
            <KeyValueRow testID="daemon-pid" label="PID" value={status.pid === null ? "—" : String(status.pid)} />
            <KeyValueRow testID="daemon-task-count" label="Tasks" value={`${enabledCount}/${tasks.length} enabled`} />
        </Card>
    );
}
