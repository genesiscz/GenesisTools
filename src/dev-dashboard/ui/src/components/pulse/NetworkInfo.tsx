interface NetworkInfoProps {
    wifiSsid: string | null;
    publicIp: string | null;
}

function Row({ label, value }: { label: string; value: string | null }) {
    return (
        <div className="flex items-center justify-between font-mono text-sm">
            <span style={{ color: "var(--dd-text-muted)" }}>{label}</span>
            <span style={{ color: "var(--dd-text-primary)" }}>{value ?? "—"}</span>
        </div>
    );
}

export function NetworkInfo({ wifiSsid, publicIp }: NetworkInfoProps) {
    return (
        <div className="dd-panel flex flex-col gap-2 p-4">
            <h3 className="dd-accent-text mb-1 text-sm font-bold tracking-widest">NETWORK</h3>
            <Row label="Wi-Fi" value={wifiSsid} />
            <Row label="Public IP" value={publicIp} />
        </div>
    );
}
