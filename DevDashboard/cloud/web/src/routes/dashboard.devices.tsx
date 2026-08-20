import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Card, SectionTitle } from "@/components/dashboard/Card";
import { Terminal } from "@/components/landing/icons";
import { listDevices, removeDevice } from "@/lib/dashboard/dashboard.functions";

export const Route = createFileRoute("/dashboard/devices")({
    loader: () => listDevices(),
    component: DevicesPage,
});

type DeviceRow = Awaited<ReturnType<typeof listDevices>>[number];

function DevicesPage() {
    const devices = Route.useLoaderData();

    return (
        <div>
            <SectionTitle
                title="Devices"
                subtitle="Every Mac agent and phone paired to your account. The cloud stores public keys only."
            />

            {devices.length === 0 ? <EmptyState /> : <DeviceList devices={devices} />}
        </div>
    );
}

function EmptyState() {
    return (
        <Card className="reveal in">
            <div className="flex flex-col items-center justify-center py-10 text-center" data-testid="devices-empty">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.03] text-zinc-500 ring-1 ring-white/10">
                    <Terminal className="h-6 w-6" />
                </span>
                <h2 className="mt-5 font-display text-lg font-semibold text-zinc-100">No devices paired yet</h2>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-500">
                    Run the agent on your Mac and pair your phone from the setup wizard. Paired devices show up
                    here with their public key fingerprint.
                </p>
                <a
                    href="/dashboard/setup"
                    className="group mt-7 inline-flex items-center gap-2.5 rounded-full bg-emerald-400 px-5 py-2.5 text-sm font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98]"
                >
                    Open the setup wizard
                </a>
            </div>
        </Card>
    );
}

function DeviceList({ devices }: { devices: readonly DeviceRow[] }) {
    return (
        <Card className="reveal in">
            <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold text-zinc-100">Paired devices</h2>
                <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                    {devices.length} {devices.length === 1 ? "device" : "devices"}
                </span>
            </div>
            <ul className="mt-5 divide-y divide-white/[0.06]" data-testid="devices-list">
                {devices.map((device) => (
                    <DeviceRowItem key={device.id} device={device} />
                ))}
            </ul>
        </Card>
    );
}

function DeviceRowItem({ device }: { device: DeviceRow }) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onRemove() {
        setError(null);
        setPending(true);

        try {
            await removeDevice({ data: { deviceId: device.id } });
            await router.invalidate();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not remove this device.");
        } finally {
            setPending(false);
        }
    }

    const accent =
        device.kind === "agent"
            ? "bg-violet-500/10 text-violet-300 ring-violet-400/20"
            : "bg-emerald-500/10 text-emerald-300 ring-emerald-400/20";

    return (
        <li className="flex items-center justify-between gap-4 py-4" data-testid={`device-row-${device.id}`}>
            <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                    <span className="truncate text-sm font-medium text-zinc-100" data-testid="device-label">
                        {device.label}
                    </span>
                    <span
                        className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1 ${accent}`}
                        data-testid="device-kind"
                    >
                        {device.kind}
                    </span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-zinc-600">
                    paired {device.pairedAt} · key {device.publicKey.slice(0, 16)}…
                </p>
                {error && (
                    <p className="mt-2 font-mono text-[11px] text-red-300" data-testid="device-error">
                        {error}
                    </p>
                )}
            </div>
            <button
                type="button"
                onClick={onRemove}
                disabled={pending}
                data-testid={`device-remove-${device.id}`}
                className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-zinc-400 backdrop-blur-xl transition-colors duration-500 ease-silk hover:bg-white/[0.06] hover:text-zinc-200 active:scale-[0.97] disabled:opacity-50"
            >
                {pending ? "Removing…" : "Remove"}
            </button>
        </li>
    );
}
