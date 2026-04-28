import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@app/utils/ui/components/alert-dialog";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { Switch } from "@app/utils/ui/components/switch";
import type { YoutubeConfigShape } from "@app/youtube/lib/types";
import { apiClient } from "@app/yt/api.client";
import { useCacheStats, useClearCache, usePatchServerConfig, usePruneCache, useServerConfig } from "@app/yt/api.hooks";
import { Loading } from "@app/yt/components/shared/loading";
import { formatBytes } from "@app/yt/lib/format";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, DatabaseZap, RotateCcw, Save, Server, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const providerOptions = ["local-hf", "cloud", "openai", "groq", "openrouter", "ollama", "anthropic", "google"];

export const Route = createFileRoute("/settings")({
    component: SettingsPage,
});

function SettingsPage() {
    const config = useServerConfig();
    const cache = useCacheStats();
    const patchConfig = usePatchServerConfig();
    const prune = usePruneCache();
    const clear = useClearCache();
    const [draft, setDraft] = useState<YoutubeConfigShape | null>(null);
    const [dryRun, setDryRun] = useState(true);
    const [healthStatus, setHealthStatus] = useState<"idle" | "checking" | "ok" | "failed">("idle");

    useEffect(() => {
        if (config.data?.config) {
            setDraft(config.data.config);
        }
    }, [config.data?.config]);

    const jobsCount = useMemo(() => {
        const jobs = cache.data?.jobs;

        if (!jobs) {
            return 0;
        }

        return Array.isArray(jobs) ? jobs.length : 0;
    }, [cache.data?.jobs]);

    async function onSave() {
        if (!draft) {
            return;
        }

        await patchConfig.mutateAsync(draft);
        toast.success("Settings saved");
    }

    async function onTestConnection() {
        setHealthStatus("checking");
        try {
            await apiClient.health();
            setHealthStatus("ok");
            toast.success("API server is reachable");
        } catch (err) {
            setHealthStatus("failed");
            toast.error(err instanceof Error ? err.message : String(err));
        }
    }

    async function onPrune() {
        const result = await prune.mutateAsync(dryRun);
        toast.success(
            dryRun ? "Dry run complete" : `Pruned ${result.audio + result.video + result.thumb} cache entries`
        );
    }

    async function onClearAll() {
        const result = await clear.mutateAsync({ all: true });
        toast.success(`Cleared ${result.deletedCount} files (${formatBytes(result.freedBytes)})`);
    }

    if (config.isPending || !draft) {
        return <Loading label="Loading settings" />;
    }

    return (
        <div className="mx-auto max-w-5xl space-y-6 pb-24">
            <header className="yt-panel rounded-3xl p-5">
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-secondary">Control room</p>
                <h1 className="mt-2 text-3xl font-bold">Settings</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                    Config path: {config.data?.where ?? "~/.genesis-tools/youtube/server.json"}
                </p>
            </header>

            <SettingsCard icon={<Server className="size-5" />} title="API Endpoint">
                <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <Field label="Base URL">
                        <Input
                            value={draft.apiBaseUrl}
                            onChange={(event) => setDraft({ ...draft, apiBaseUrl: event.target.value })}
                        />
                    </Field>
                    <Button variant="outline" onClick={onTestConnection} disabled={healthStatus === "checking"}>
                        <CheckCircle2 className="mr-2 size-4" />{" "}
                        {healthStatus === "checking" ? "Checking" : "Test connection"}
                    </Button>
                </div>
            </SettingsCard>

            <SettingsCard title="Provider preferences">
                <div className="grid gap-4 md:grid-cols-3">
                    <ProviderSelect
                        label="Transcribe"
                        value={draft.provider.transcribe ?? "local-hf"}
                        onChange={(value) => setDraft({ ...draft, provider: { ...draft.provider, transcribe: value } })}
                    />
                    <ProviderSelect
                        label="Summarize"
                        value={draft.provider.summarize ?? "cloud"}
                        onChange={(value) => setDraft({ ...draft, provider: { ...draft.provider, summarize: value } })}
                    />
                    <ProviderSelect
                        label="QA"
                        value={draft.provider.qa ?? "cloud"}
                        onChange={(value) => setDraft({ ...draft, provider: { ...draft.provider, qa: value } })}
                    />
                </div>
            </SettingsCard>

            <SettingsCard title="Concurrency">
                <div className="grid gap-4 md:grid-cols-4">
                    <NumberField
                        label="Download"
                        value={draft.concurrency.download}
                        onChange={(value) =>
                            setDraft({ ...draft, concurrency: { ...draft.concurrency, download: value } })
                        }
                    />
                    <NumberField
                        label="Local transcribe"
                        value={draft.concurrency.localTranscribe}
                        onChange={(value) =>
                            setDraft({ ...draft, concurrency: { ...draft.concurrency, localTranscribe: value } })
                        }
                    />
                    <NumberField
                        label="Cloud transcribe"
                        value={draft.concurrency.cloudTranscribe}
                        onChange={(value) =>
                            setDraft({ ...draft, concurrency: { ...draft.concurrency, cloudTranscribe: value } })
                        }
                    />
                    <NumberField
                        label="Summarize"
                        value={draft.concurrency.summarize}
                        onChange={(value) =>
                            setDraft({ ...draft, concurrency: { ...draft.concurrency, summarize: value } })
                        }
                    />
                </div>
            </SettingsCard>

            <SettingsCard title="TTLs">
                <div className="grid gap-4 md:grid-cols-4">
                    <TextField
                        label="Audio"
                        value={draft.ttls.audio}
                        onChange={(value) => setDraft({ ...draft, ttls: { ...draft.ttls, audio: value } })}
                    />
                    <TextField
                        label="Video"
                        value={draft.ttls.video}
                        onChange={(value) => setDraft({ ...draft, ttls: { ...draft.ttls, video: value } })}
                    />
                    <TextField
                        label="Thumb"
                        value={draft.ttls.thumb}
                        onChange={(value) => setDraft({ ...draft, ttls: { ...draft.ttls, thumb: value } })}
                    />
                    <TextField
                        label="Channel listing"
                        value={draft.ttls.channelListing}
                        onChange={(value) => setDraft({ ...draft, ttls: { ...draft.ttls, channelListing: value } })}
                    />
                </div>
            </SettingsCard>

            <SettingsCard icon={<DatabaseZap className="size-5" />} title="Cache">
                <div className="grid gap-3 md:grid-cols-4">
                    <Metric label="Channels" value={cache.data?.channels ?? 0} />
                    <Metric label="Videos" value={cache.data?.videos ?? 0} />
                    <Metric label="Audio" value={formatBytes(cache.data?.audioBytes)} />
                    <Metric label="Video" value={formatBytes(cache.data?.videoBytes)} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 rounded-xl border border-secondary/20 bg-secondary/10 px-3 py-2 text-sm">
                        <Switch checked={dryRun} onCheckedChange={setDryRun} /> Dry run
                    </label>
                    <Button variant="outline" onClick={onPrune} disabled={prune.isPending}>
                        Prune expired
                    </Button>
                    <AlertDialog>
                        <AlertDialogTrigger asChild>
                            <Button variant="destructive">
                                <Trash2 className="mr-2 size-4" /> Clear cache
                            </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Clear all cached media?</AlertDialogTitle>
                                <AlertDialogDescription>
                                    This removes cached audio, video, and thumbnail files. Metadata and jobs remain
                                    available.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={onClearAll}>Clear cache</AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                    <span className="text-xs text-muted-foreground">
                        {jobsCount} recent jobs tracked in cache stats.
                    </span>
                </div>
            </SettingsCard>

            <SettingsCard title="Reset to defaults">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                        Reload the last saved server config and discard unsaved changes.
                    </p>
                    <Button variant="outline" onClick={() => setDraft(config.data?.config ?? draft)}>
                        <RotateCcw className="mr-2 size-4" /> Reset draft
                    </Button>
                </div>
            </SettingsCard>

            <div className="sticky bottom-4 z-20 flex justify-end">
                <Button onClick={onSave} disabled={patchConfig.isPending} className="btn-glow min-w-44">
                    <Save className="mr-2 size-4" /> Save settings
                </Button>
            </div>
        </div>
    );
}

function SettingsCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
    return (
        <Card className="yt-panel">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                    {icon}
                    {title}
                </CardTitle>
            </CardHeader>
            <CardContent>{children}</CardContent>
        </Card>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="space-y-2">
            <span className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">{label}</span>
            {children}
        </label>
    );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <Field label={label}>
            <Input value={value} onChange={(event) => onChange(event.target.value)} />
        </Field>
    );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
    return (
        <Field label={label}>
            <Input
                type="number"
                min={1}
                value={value}
                onChange={(event) => onChange(Number.parseInt(event.target.value || "1", 10))}
            />
        </Field>
    );
}

function ProviderSelect({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <Field label={label}>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {providerOptions.map((option) => (
                        <SelectItem key={option} value={option}>
                            {option}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

function Metric({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded-2xl border border-primary/20 bg-black/20 p-4">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-bold text-primary">{value}</p>
        </div>
    );
}
