import type { ChannelView, NotifySettings } from "@app/monitor/lib/notify-settings";
import type { NotifyTarget } from "@app/monitor/lib/types";
import {
    useDeleteTarget,
    useLiveStatus,
    useNotifySettings,
    useTargets,
    useTestNotification,
    useTestTarget,
    useUpdateNotifySettings,
    useUpdateTarget,
} from "@app/monitor/ui/api.hooks";
import { CHANNEL_SPECS, type ChannelDraft, ChannelFields } from "@app/monitor/ui/components/channel-fields";
import { EmptyState } from "@app/monitor/ui/components/empty-state";
import { ErrorPanel, Loading } from "@app/monitor/ui/components/loading";
import { PageHeader } from "@app/monitor/ui/components/page-header";
import { TargetDialog } from "@app/monitor/ui/components/target-dialog";
import { Badge } from "@genesiscz/utils/ui/components/badge";
import { Button } from "@genesiscz/utils/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@genesiscz/utils/ui/components/card";
import { Switch } from "@genesiscz/utils/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { BellRing, Library, Loader2, Pencil, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({
    component: SettingsPage,
});

function describeTargetConfig(target: NotifyTarget): string {
    const config = target.config;

    switch (target.channel) {
        case "system":
            return [
                config.title,
                config.sound ? `sound ${config.sound}` : null,
                config.ignoreDnD ? "bypasses DnD" : null,
            ]
                .filter(Boolean)
                .join(" · ");
        case "say":
            return [
                config.voice ? `voice ${config.voice}` : "default voice",
                config.provider ? `via ${config.provider}` : null,
            ]
                .filter(Boolean)
                .join(" · ");
        case "telegram":
            return `chat ${config.chatId ?? "?"}`;
        case "webhook":
            return typeof config.url === "string" ? config.url : "no url";
    }
}

function TargetCard({ target, onEdit }: { target: NotifyTarget; onEdit: (target: NotifyTarget) => void }) {
    const spec = CHANNEL_SPECS[target.channel];
    const Icon = spec.icon;
    const update = useUpdateTarget();
    const remove = useDeleteTarget();
    const test = useTestTarget();
    const testing = test.isPending && test.variables === target.id;

    return (
        <Card className="mon-panel rounded-3xl">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-secondary/30 bg-secondary/10 text-secondary">
                        <Icon className="size-5" />
                    </div>
                    <div className="min-w-0">
                        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                            <span className="truncate">{target.name}</span>
                            <Badge variant="cyber" className="font-mono text-[0.6rem] uppercase tracking-[0.18em]">
                                {target.channel}
                            </Badge>
                        </CardTitle>
                        <CardDescription className="mt-1 truncate">{describeTargetConfig(target)}</CardDescription>
                        <p className="mt-1 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                            {target.watcherCount === 0
                                ? "not used yet"
                                : `used by ${target.watcherCount} watcher${target.watcherCount === 1 ? "" : "s"}`}
                        </p>
                    </div>
                </div>
                <Switch
                    checked={target.enabled}
                    disabled={update.isPending}
                    onCheckedChange={(checked) => update.mutate({ id: target.id, patch: { enabled: checked } })}
                />
            </CardHeader>
            <CardContent className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" size="sm" disabled={testing} onClick={() => test.mutate(target.id)}>
                    {testing ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />}
                    Send demo
                </Button>
                <Button variant="outline" size="sm" onClick={() => onEdit(target)}>
                    <Pencil className="size-4" /> Edit
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                        if (window.confirm(`Delete "${target.name}"? Watchers using it fall back to the defaults.`)) {
                            remove.mutate(target.id);
                        }
                    }}
                >
                    <Trash2 className="size-4" /> Delete
                </Button>
            </CardContent>
        </Card>
    );
}

function draftFor(view: ChannelView): ChannelDraft {
    const draft: ChannelDraft = {};

    for (const [key, value] of Object.entries(view.resolved)) {
        if (typeof value === "string" || typeof value === "boolean") {
            draft[key] = value;
        }
    }

    return draft;
}

function DefaultChannelCard({ view }: { view: ChannelView }) {
    const spec = CHANNEL_SPECS[view.name];
    const Icon = spec.icon;
    const update = useUpdateNotifySettings();
    const test = useTestNotification();
    const [draft, setDraft] = useState<ChannelDraft>(() => draftFor(view));
    const [dirty, setDirty] = useState(false);
    const enabled = draft.enabled === true;
    const testing = test.isPending && test.variables === view.name;

    useEffect(() => {
        if (!dirty) {
            setDraft(draftFor(view));
        }
    }, [view, dirty]);

    function set(key: string, value: string | boolean) {
        setDraft((current) => ({ ...current, [key]: value }));
        setDirty(true);
    }

    async function toggle(next: boolean) {
        set("enabled", next);
        await update.mutateAsync({ channels: { [view.name]: { enabled: next } } });
        setDirty(false);
        toast.success(`${spec.title} ${next ? "enabled" : "disabled"} for monitor`);
    }

    async function save() {
        const override: Record<string, string | boolean> = { enabled };

        for (const [key, value] of Object.entries(draft)) {
            if (key === "enabled" || key.endsWith("Set")) {
                continue;
            }

            if (typeof value === "boolean" || (typeof value === "string" && value !== "")) {
                override[key] = value;
            }
        }

        await update.mutateAsync({ channels: { [view.name]: override } });
        setDirty(false);
        toast.success(`${spec.title} saved`);
    }

    async function reset() {
        await update.mutateAsync({ channels: { [view.name]: null } });
        setDirty(false);
        toast.success(`${spec.title} follows the global notify config again`);
    }

    return (
        <Card className="mon-panel rounded-3xl">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-secondary/30 bg-secondary/10 text-secondary">
                        <Icon className="size-5" />
                    </div>
                    <div>
                        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                            {spec.title}
                            {view.overridden.length > 0 ? (
                                <Badge variant="cyber" className="font-mono text-[0.6rem] uppercase tracking-[0.18em]">
                                    monitor override
                                </Badge>
                            ) : (
                                <Badge
                                    variant="outline"
                                    className="font-mono text-[0.6rem] uppercase tracking-[0.18em]"
                                >
                                    global default
                                </Badge>
                            )}
                        </CardTitle>
                        <CardDescription className="mt-1">{spec.blurb}</CardDescription>
                    </div>
                </div>
                <Switch checked={enabled} onCheckedChange={toggle} disabled={update.isPending} />
            </CardHeader>
            <CardContent className="space-y-4">
                <ChannelFields
                    channel={view.name}
                    draft={draft}
                    onChange={set}
                    secretsSet={{ botToken: view.resolved.botTokenSet === true }}
                />
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" disabled={testing} onClick={() => test.mutate(view.name)}>
                        {testing ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />}
                        Send demo
                    </Button>
                    {view.overridden.length > 0 && (
                        <Button variant="ghost" size="sm" onClick={reset} disabled={update.isPending}>
                            <RotateCcw className="size-4" /> Use global
                        </Button>
                    )}
                    <Button size="sm" className="btn-glow" onClick={save} disabled={!dirty || update.isPending}>
                        {update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        Save
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

function EventsCard({ settings }: { settings: NotifySettings }) {
    const update = useUpdateNotifySettings();

    return (
        <Card className="mon-panel rounded-3xl">
            <CardHeader>
                <CardTitle className="text-lg">Which transitions notify</CardTitle>
                <CardDescription>
                    A watcher going down always notifies (when its own "notify" switch is on). Tune the softer edges
                    here.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2 text-sm">
                    <Switch
                        checked={settings.meta.onDegraded}
                        disabled={update.isPending}
                        onCheckedChange={(checked) => update.mutate({ meta: { onDegraded: checked } })}
                    />
                    Degraded
                </label>
                <label className="flex items-center gap-2 text-sm">
                    <Switch
                        checked={settings.meta.onRecover}
                        disabled={update.isPending}
                        onCheckedChange={(checked) => update.mutate({ meta: { onRecover: checked } })}
                    />
                    Recovered
                </label>
            </CardContent>
        </Card>
    );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
    return (
        <div className="space-y-1">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-secondary">{title}</h2>
            <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
    );
}

function SettingsPage() {
    const live = useLiveStatus();
    const settings = useNotifySettings();
    const targets = useTargets();
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<NotifyTarget | null>(null);

    if (settings.isPending || targets.isPending) {
        return <Loading label="Loading notification settings" cards={3} />;
    }

    if (settings.isError || !settings.data || targets.isError) {
        return <ErrorPanel title="Couldn't load notification settings." />;
    }

    const library = targets.data ?? [];

    return (
        <div className="space-y-8">
            <PageHeader
                eyebrow="Notifications"
                live={live}
                title="How monitor gets your attention"
                description="Build a library of named targets (several webhooks, several voices, a loud banner, a Telegram chat), then pick which ones each watcher uses. Watchers with no targets fall back to the defaults below."
                actions={
                    <Button className="btn-glow" onClick={() => setAdding(true)}>
                        <Plus className="size-4" /> New target
                    </Button>
                }
            />

            <section className="space-y-4">
                <SectionTitle
                    title="Library"
                    hint="Assign these per watcher in its edit dialog (Notify via). Every card has its own demo button."
                />
                {library.length === 0 ? (
                    <EmptyState
                        icon={Library}
                        title="No targets yet"
                        body="Add a webhook, a voice or a banner style. Until then every watcher uses the defaults below."
                        cta={
                            <Button className="btn-glow" onClick={() => setAdding(true)}>
                                <Plus className="size-4" /> Add the first target
                            </Button>
                        }
                    />
                ) : (
                    <div className="grid gap-4 xl:grid-cols-2">
                        {library.map((target) => (
                            <TargetCard key={target.id} target={target} onEdit={setEditing} />
                        ))}
                    </div>
                )}
            </section>

            <section className="space-y-4">
                <SectionTitle
                    title="Defaults"
                    hint="Used by watchers that have no library targets. Overrides for the monitor app on top of the shared notify config (tools notify config)."
                />
                <EventsCard settings={settings.data} />
                <div className="grid gap-4 xl:grid-cols-2">
                    {settings.data.channels.map((view) => (
                        <DefaultChannelCard key={view.name} view={view} />
                    ))}
                </div>
            </section>

            <TargetDialog open={adding} onOpenChange={setAdding} />
            <TargetDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} target={editing} />
        </div>
    );
}
