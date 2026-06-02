import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, SectionTitle } from "@/components/dashboard/Card";
import { Bell } from "@/components/landing/icons";
import { getSettings, updateSettings } from "@/lib/dashboard/dashboard.functions";

export const Route = createFileRoute("/dashboard/settings")({
    loader: () => getSettings(),
    component: SettingsPage,
});

function SettingsPage() {
    const initial = Route.useLoaderData();
    const [pushAlertsEnabled, setPushAlertsEnabled] = useState(initial.pushAlertsEnabled);
    const [pending, setPending] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function persist(next: boolean) {
        setError(null);
        setSaved(false);
        setPending(true);
        const previous = pushAlertsEnabled;
        setPushAlertsEnabled(next);

        try {
            await updateSettings({ data: { pushAlertsEnabled: next } });
            setSaved(true);
        } catch (err) {
            setPushAlertsEnabled(previous);
            setError(err instanceof Error ? err.message : "Could not save your settings.");
        } finally {
            setPending(false);
        }
    }

    return (
        <div>
            <SectionTitle
                title="Settings"
                subtitle="Account preferences. Everything stays scoped to your account — the cloud never sees your data."
            />

            <Card className="reveal in">
                <div className="flex items-start justify-between gap-6">
                    <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-400/20">
                            <Bell className="h-5 w-5" />
                        </span>
                        <div>
                            <h2 className="text-sm font-medium text-zinc-100">Push alerts</h2>
                            <p className="mt-1 max-w-md text-sm leading-relaxed text-zinc-500">
                                Get a push notification when an agent session needs your input or finishes a run.
                                Alerts are delivered end-to-end — the payload is encrypted to your devices.
                            </p>
                        </div>
                    </div>

                    <Toggle
                        checked={pushAlertsEnabled}
                        disabled={pending}
                        onChange={persist}
                        testId="settings-push-alerts"
                    />
                </div>

                <div className="mt-6 border-t border-white/[0.06] pt-4">
                    {error ? (
                        <p className="font-mono text-[12px] text-red-300" data-testid="settings-error">
                            {error}
                        </p>
                    ) : (
                        <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-600" data-testid="settings-status">
                            {pending ? "Saving…" : saved ? "Saved" : "Up to date"}
                        </p>
                    )}
                </div>
            </Card>
        </div>
    );
}

function Toggle({
    checked,
    disabled,
    onChange,
    testId,
}: {
    checked: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
    testId: string;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            data-testid={testId}
            data-state={checked ? "on" : "off"}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ring-1 transition-colors duration-500 ease-silk disabled:opacity-60 ${
                checked ? "bg-emerald-500/80 ring-emerald-400/30" : "bg-white/[0.06] ring-white/10"
            }`}
        >
            <span
                className={`inline-block h-5 w-5 transform rounded-full bg-zinc-50 shadow transition-transform duration-500 ease-silk ${
                    checked ? "translate-x-5" : "translate-x-0.5"
                }`}
            />
        </button>
    );
}
