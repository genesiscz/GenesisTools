import { DASH } from "@/features/pulse/units";
import { Card } from "@/ui/Card";
import { KeyValueRow } from "@/ui/KeyValueRow";
import { SectionHeader } from "@/ui/SectionHeader";

interface NetworkInfoProps {
    wifiSsid: string | null;
    publicIp: string | null;
}

export function NetworkInfo({ wifiSsid, publicIp }: NetworkInfoProps) {
    return (
        <Card testID="pulse-network-card" className="gap-2">
            <SectionHeader title="Network" />
            <KeyValueRow label="Wi-Fi" value={wifiSsid ?? DASH} />
            <KeyValueRow label="Public IP" value={publicIp ?? DASH} />
        </Card>
    );
}
