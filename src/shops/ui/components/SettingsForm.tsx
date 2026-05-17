import type { SettingsPayload } from "@app/shops/types";
import { SafeJSON } from "@app/utils/json";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { Switch } from "@app/utils/ui/components/switch";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface SettingsFormProps {
    initial: SettingsPayload;
}

export function SettingsForm({ initial }: SettingsFormProps) {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState<SettingsPayload>(initial);
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        setDraft(initial);
        setDirty(false);
    }, [initial]);

    const updateDraft = <K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]) => {
        setDraft((prev) => ({ ...prev, [key]: value }));
        setDirty(true);
    };

    const updateChannel = <K extends keyof SettingsPayload["notification_channels"]>(
        key: K,
        value: SettingsPayload["notification_channels"][K]
    ) => {
        setDraft((prev) => ({
            ...prev,
            notification_channels: { ...prev.notification_channels, [key]: value },
        }));
        setDirty(true);
    };

    const saveMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify(draft),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({ error: `PATCH failed: ${res.status}` }));
                throw new Error(body.error ?? `PATCH failed: ${res.status}`);
            }

            return res.json();
        },
        onSuccess: () => {
            toast.success("Settings saved");
            setDirty(false);
            queryClient.invalidateQueries({ queryKey: ["settings"] });
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    return (
        <div className="space-y-5">
            <Card>
                <CardHeader>
                    <CardTitle className="font-mono text-xs tracking-[0.25em] text-muted-foreground uppercase">
                        Appearance & Defaults
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Field label="Theme">
                        <Select
                            value={draft.theme}
                            onValueChange={(v) => updateDraft("theme", v as SettingsPayload["theme"])}
                        >
                            <SelectTrigger className="w-44 font-mono text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="cyberpunk">cyberpunk</SelectItem>
                                <SelectItem value="wow">wow</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>

                    <Field label="Default Landing">
                        <Select
                            value={draft.default_landing_view}
                            onValueChange={(v) =>
                                updateDraft("default_landing_view", v as SettingsPayload["default_landing_view"])
                            }
                        >
                            <SelectTrigger className="w-44 font-mono text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="/watchlist">/watchlist</SelectItem>
                                <SelectItem value="/">/ (home)</SelectItem>
                                <SelectItem value="/browse">/browse</SelectItem>
                                <SelectItem value="/live">/live</SelectItem>
                                <SelectItem value="/workspace">/workspace</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="font-mono text-xs tracking-[0.25em] text-muted-foreground uppercase">
                        Notifications
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <SwitchField
                        label="macOS notifications"
                        checked={draft.notification_channels.macos}
                        onChange={(v) => updateChannel("macos", v)}
                    />
                    <SwitchField
                        label="Web SSE (in-dashboard toasts)"
                        checked={draft.notification_channels.web_sse}
                        onChange={(v) => updateChannel("web_sse", v)}
                    />
                    <SwitchField
                        label="Telegram"
                        checked={draft.notification_channels.telegram}
                        onChange={(v) => updateChannel("telegram", v)}
                    />
                    {draft.notification_channels.telegram && (
                        <>
                            <Field label="Telegram bot token">
                                <Input
                                    type="password"
                                    value={draft.notification_channels.telegram_bot_token ?? ""}
                                    onChange={(e) => updateChannel("telegram_bot_token", e.target.value || null)}
                                    className="font-mono text-xs"
                                    placeholder="123456:AAH-..."
                                />
                            </Field>
                            <Field label="Telegram chat id">
                                <Input
                                    value={draft.notification_channels.telegram_chat_id ?? ""}
                                    onChange={(e) => updateChannel("telegram_chat_id", e.target.value || null)}
                                    className="font-mono text-xs"
                                />
                            </Field>
                        </>
                    )}
                    <Field label="Default cooldown (hours)">
                        <Input
                            type="number"
                            min={0}
                            max={168}
                            value={draft.default_cooldown_hours}
                            onChange={(e) => updateDraft("default_cooldown_hours", Number(e.target.value))}
                            className="w-28 font-mono text-xs"
                        />
                    </Field>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="font-mono text-xs tracking-[0.25em] text-muted-foreground uppercase">
                        Crawler & Storage
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Field label="Default rate limit (req/sec)">
                        <Input
                            type="number"
                            min={0.1}
                            step={0.1}
                            value={draft.default_rate_limit_per_second}
                            onChange={(e) => updateDraft("default_rate_limit_per_second", Number(e.target.value))}
                            className="w-28 font-mono text-xs"
                        />
                    </Field>
                    <Field label="HTTP requests retention (days)">
                        <Input
                            type="number"
                            min={1}
                            max={365}
                            value={draft.http_requests_retention_days}
                            onChange={(e) => updateDraft("http_requests_retention_days", Number(e.target.value))}
                            className="w-28 font-mono text-xs"
                        />
                    </Field>
                </CardContent>
            </Card>

            <div className="flex items-center justify-end gap-3">
                {dirty && (
                    <span className="font-mono text-[10px] tracking-[0.15em] text-amber-400 uppercase">
                        unsaved changes
                    </span>
                )}
                <Button
                    onClick={() => saveMutation.mutate()}
                    disabled={!dirty || saveMutation.isPending}
                    className="font-mono text-xs tracking-[0.15em] uppercase"
                >
                    Save
                </Button>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-xs tracking-[0.15em] text-muted-foreground uppercase">{label}</span>
            {children}
        </div>
    );
}

function SwitchField({
    label,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-foreground">{label}</span>
            <Switch checked={checked} onCheckedChange={onChange} />
        </div>
    );
}
