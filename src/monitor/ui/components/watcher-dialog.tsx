import {
    type CheckResult,
    DEFAULT_INTERVAL_SEC,
    DEFAULT_TIMEOUT_MS,
    type WatcherInput,
    type WatcherKind,
    type WatcherPreset,
    type WatcherSummary,
} from "@app/monitor/lib/types";
import {
    useAiAccounts,
    useCreateWatcher,
    usePresets,
    useStatuspageComponents,
    useTargets,
    useTestCheck,
    useUpdateWatcher,
} from "@app/monitor/ui/api.hooks";
import { CHANNEL_SPECS } from "@app/monitor/ui/components/channel-fields";
import { StatusBadge } from "@app/monitor/ui/components/status-badge";
import { KIND_LABEL } from "@app/monitor/ui/lib/format";
import { Button } from "@genesiscz/utils/ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@genesiscz/utils/ui/components/dialog";
import { Input } from "@genesiscz/utils/ui/components/input";
import { Label } from "@genesiscz/utils/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@genesiscz/utils/ui/components/select";
import { Switch } from "@genesiscz/utils/ui/components/switch";
import { cn } from "@genesiscz/utils/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { Bot, FlaskConical, Globe, Loader2, RefreshCw, Rss, Save, Waves } from "lucide-react";
import { useEffect, useState } from "react";

const KIND_OPTIONS: Array<{ kind: WatcherKind; icon: typeof Globe; blurb: string }> = [
    { kind: "website", icon: Globe, blurb: "HTTP request: status, body, latency" },
    { kind: "statuspage", icon: Waves, blurb: "Reads the page's own component data" },
    { kind: "rss", icon: Rss, blurb: "New feed items delivered to your targets" },
    { kind: "ai-provider", icon: Bot, blurb: "Health probe of a configured AI account" },
];

const INTERVALS: Array<{ value: number; label: string }> = [
    { value: 30, label: "30 seconds" },
    { value: 60, label: "1 minute" },
    { value: 120, label: "2 minutes" },
    { value: 300, label: "5 minutes" },
    { value: 900, label: "15 minutes" },
    { value: 3600, label: "1 hour" },
];

interface FormState {
    kind: WatcherKind;
    name: string;
    target: string;
    intervalSec: number;
    timeoutMs: number;
    expectStatus: string;
    expectBody: string;
    degradedAboveMs: string;
    components: string[];
    itemFilter: string;
    deliverItems: boolean;
    notify: boolean;
    enabled: boolean;
    targetIds: number[];
}

function emptyForm(): FormState {
    return {
        kind: "website",
        name: "",
        target: "",
        intervalSec: DEFAULT_INTERVAL_SEC,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        expectStatus: "",
        expectBody: "",
        degradedAboveMs: "",
        components: [],
        itemFilter: "",
        deliverItems: true,
        notify: true,
        enabled: true,
        targetIds: [],
    };
}

function fromWatcher(watcher: WatcherSummary): FormState {
    return {
        kind: watcher.kind,
        name: watcher.name,
        target: watcher.target,
        intervalSec: watcher.intervalSec,
        timeoutMs: watcher.timeoutMs,
        expectStatus: watcher.config.expectStatus?.toString() ?? "",
        expectBody: watcher.config.expectBody ?? "",
        degradedAboveMs: watcher.config.degradedAboveMs?.toString() ?? "",
        components: watcher.config.components ?? [],
        itemFilter: watcher.config.itemFilter?.join(", ") ?? "",
        deliverItems: watcher.config.deliverItems !== false,
        notify: watcher.notify,
        enabled: watcher.enabled,
        targetIds: watcher.targetIds,
    };
}

function fromPreset(preset: WatcherPreset, current: FormState): FormState {
    return {
        ...current,
        kind: preset.kind,
        name: preset.name,
        target: preset.target,
        intervalSec: preset.intervalSec ?? current.intervalSec,
        expectStatus: preset.config?.expectStatus?.toString() ?? "",
        expectBody: preset.config?.expectBody ?? "",
        degradedAboveMs: preset.config?.degradedAboveMs?.toString() ?? "",
        components: preset.config?.components ?? [],
        itemFilter: preset.config?.itemFilter?.join(", ") ?? "",
    };
}

function toInput(form: FormState): WatcherInput {
    const config: WatcherInput["config"] = {};

    if (form.expectStatus.trim()) {
        config.expectStatus = Number(form.expectStatus);
    }

    if (form.expectBody.trim()) {
        config.expectBody = form.expectBody.trim();
    }

    if (form.degradedAboveMs.trim()) {
        config.degradedAboveMs = Number(form.degradedAboveMs);
    }

    if (form.components.length > 0) {
        config.components = form.components;
    }

    if (form.itemFilter.trim()) {
        config.itemFilter = form.itemFilter
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    }

    if (form.kind === "rss") {
        config.deliverItems = form.deliverItems;
    }

    return {
        name: form.name.trim(),
        kind: form.kind,
        target: form.target.trim(),
        config,
        intervalSec: form.intervalSec,
        timeoutMs: form.timeoutMs,
        notify: form.notify,
        enabled: form.enabled,
        targetIds: form.targetIds,
    };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <Label className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">{label}</Label>
            {children}
            {hint && <p className="text-[0.7rem] text-muted-foreground/80">{hint}</p>}
        </div>
    );
}

const CHIP_ON =
    "rounded-full border border-amber-400/55 bg-amber-400/15 px-3 py-1 font-mono text-[0.68rem] text-amber-100 shadow-[0_0_18px_rgba(245,158,11,0.15)] transition";
const CHIP_OFF =
    "rounded-full border border-border/60 bg-black/30 px-3 py-1 font-mono text-[0.68rem] text-muted-foreground transition hover:border-amber-400/30 hover:text-amber-100";

/** Components read live from the status page; tick the ones this watcher cares about. */
function ComponentPicker({
    target,
    selected,
    onChange,
}: {
    target: string;
    selected: string[];
    onChange: (next: string[]) => void;
}) {
    const fetchComponents = useStatuspageComponents();
    const components = fetchComponents.data?.components ?? [];
    const known = new Set(components.map((component) => component.name));

    function toggle(name: string) {
        onChange(selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name]);
    }

    return (
        <div className="space-y-2 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
                <Label className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
                    Components
                </Label>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!target.trim() || fetchComponents.isPending}
                    onClick={() => fetchComponents.mutate(target)}
                >
                    {fetchComponents.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="size-3.5" />
                    )}
                    {fetchComponents.data ? "Reload from page" : "Load from page"}
                </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
                {selected
                    .filter((name) => !known.has(name))
                    .map((name) => (
                        <button key={name} type="button" className={CHIP_ON} onClick={() => toggle(name)}>
                            {name}
                        </button>
                    ))}
                {components.map((component) => {
                    const active = selected.includes(component.name);
                    const bad = component.status !== "operational";

                    return (
                        <button
                            key={component.name}
                            type="button"
                            className={active ? CHIP_ON : CHIP_OFF}
                            title={component.status.replace(/_/g, " ")}
                            onClick={() => toggle(component.name)}
                        >
                            <span
                                className={cn(
                                    "mr-1.5 inline-block size-1.5 rounded-full align-middle",
                                    bad ? "bg-amber-400" : "bg-emerald-400"
                                )}
                            />
                            {component.name}
                        </button>
                    );
                })}
            </div>
            <p className="text-[0.7rem] text-muted-foreground/80">
                {fetchComponents.data
                    ? `${fetchComponents.data.page ?? "Page"} lists ${components.length} components. None ticked = the whole page counts.`
                    : "Nothing ticked = the whole page counts. Load the list to pick e.g. only the API."}
            </p>
        </div>
    );
}

/** Library targets as toggle chips. Empty = the monitor defaults. */
function TargetPicker({ selected, onChange }: { selected: number[]; onChange: (next: number[]) => void }) {
    const targets = useTargets();
    const list = targets.data ?? [];

    function toggle(id: number) {
        onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
    }

    return (
        <div className="space-y-2">
            <Label className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
                Notify via
            </Label>
            {list.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    The library is empty, so this watcher uses the defaults.{" "}
                    <Link to="/settings" className="text-secondary hover:underline">
                        Add targets
                    </Link>
                    .
                </p>
            ) : (
                <div className="flex flex-wrap gap-1.5">
                    {list.map((target) => {
                        const Icon = CHANNEL_SPECS[target.channel].icon;
                        const active = selected.includes(target.id);

                        return (
                            <button
                                key={target.id}
                                type="button"
                                className={cn(active ? CHIP_ON : CHIP_OFF, !target.enabled && "opacity-60")}
                                title={target.enabled ? target.channel : `${target.channel} · paused`}
                                onClick={() => toggle(target.id)}
                            >
                                <Icon className="mr-1.5 inline size-3 align-[-2px]" />
                                {target.name}
                            </button>
                        );
                    })}
                </div>
            )}
            <p className="text-[0.7rem] text-muted-foreground/80">
                {selected.length === 0
                    ? "Nothing selected = the default channels from the Notifications page."
                    : `${selected.length} target${selected.length === 1 ? "" : "s"} selected; defaults are skipped.`}
            </p>
        </div>
    );
}

export function WatcherDialog({
    open,
    onOpenChange,
    watcher,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When set, the dialog edits this watcher instead of creating one. */
    watcher?: WatcherSummary | null;
}) {
    const [form, setForm] = useState<FormState>(emptyForm);
    const [testResult, setTestResult] = useState<CheckResult | null>(null);
    const presets = usePresets();
    const accounts = useAiAccounts(open && form.kind === "ai-provider");
    const create = useCreateWatcher();
    const update = useUpdateWatcher();
    const test = useTestCheck();
    const editing = watcher ?? null;
    const saving = create.isPending || update.isPending;

    useEffect(() => {
        if (open) {
            setForm(editing ? fromWatcher(editing) : emptyForm());
            setTestResult(null);
        }
    }, [open, editing]);

    function patch(changes: Partial<FormState>) {
        setForm((current) => ({ ...current, ...changes }));
        setTestResult(null);
    }

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault();
        const input = toInput(form);

        try {
            if (editing) {
                await update.mutateAsync({ id: editing.id, patch: input });
            } else {
                await create.mutateAsync(input);
            }
        } catch {
            // The mutation hook already toasted the failure; keep the dialog open.
            return;
        }

        onOpenChange(false);
    }

    async function onTest() {
        try {
            const result = await test.mutateAsync(toInput(form));
            setTestResult(result.check);
        } catch {
            // Toasted by the hook; a stale green result must not outlive a failed test.
            setTestResult(null);
        }
    }

    const canSubmit = form.name.trim().length > 0 && form.target.trim().length > 0;
    const visiblePresets = (presets.data ?? []).filter((preset) => preset.kind === form.kind);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="mon-panel mon-scroll max-h-[92vh] overflow-y-auto border-primary/30 sm:max-w-2xl">
                <form onSubmit={onSubmit} className="space-y-6">
                    <DialogHeader>
                        <DialogTitle className="gradient-text text-2xl">
                            {editing ? `Edit ${editing.name}` : "New watcher"}
                        </DialogTitle>
                        <DialogDescription>
                            {editing
                                ? "Changes apply on the next scheduled check."
                                : "Pick a kind, paste a target, and the first check runs the moment you save."}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2 sm:grid-cols-4">
                        {KIND_OPTIONS.map((option) => {
                            const Icon = option.icon;
                            const active = form.kind === option.kind;

                            return (
                                <button
                                    key={option.kind}
                                    type="button"
                                    onClick={() => patch({ kind: option.kind, target: "", components: [] })}
                                    className={cn(
                                        "flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition",
                                        active
                                            ? "border-primary/60 bg-primary/15 text-primary shadow-[0_0_24px_rgba(245,158,11,0.15)]"
                                            : "border-border/60 bg-card/40 text-muted-foreground hover:border-primary/30 hover:text-foreground"
                                    )}
                                >
                                    <span className="flex items-center gap-2 text-sm font-semibold">
                                        <Icon className="size-4" /> {KIND_LABEL[option.kind]}
                                    </span>
                                    <span className="text-[0.7rem] leading-4 opacity-80">{option.blurb}</span>
                                </button>
                            );
                        })}
                    </div>

                    {!editing && visiblePresets.length > 0 && (
                        <div className="space-y-2">
                            <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
                                Presets
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {visiblePresets.map((preset) => (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        title={preset.description}
                                        onClick={() => patch(fromPreset(preset, form))}
                                        className="rounded-full border border-secondary/30 bg-secondary/10 px-3 py-1 font-mono text-[0.68rem] text-secondary transition hover:border-secondary/60 hover:bg-secondary/20"
                                    >
                                        {preset.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Name">
                            <Input
                                value={form.name}
                                onChange={(event) => patch({ name: event.target.value })}
                                placeholder="Claude API"
                                autoFocus
                            />
                        </Field>

                        {form.kind === "ai-provider" ? (
                            <Field label="Account" hint="Accounts from tools ai config account list">
                                <Select value={form.target} onValueChange={(value) => patch({ target: value })}>
                                    <SelectTrigger>
                                        <SelectValue
                                            placeholder={accounts.isPending ? "Loading accounts…" : "Choose an account"}
                                        />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {(accounts.data ?? []).map((account) => (
                                            <SelectItem
                                                key={account.id}
                                                value={account.id}
                                                disabled={!account.hasHealth}
                                            >
                                                {account.name} · {account.provider}
                                                {account.hasHealth ? "" : " (no health probe)"}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        ) : (
                            <Field
                                label={
                                    form.kind === "statuspage"
                                        ? "Status page URL"
                                        : form.kind === "rss"
                                          ? "Feed URL"
                                          : "URL"
                                }
                                hint={
                                    form.kind === "statuspage"
                                        ? "Statuspage, incident.io or status.x.ai. The page's component data is read, not the HTML."
                                        : form.kind === "rss"
                                          ? "RSS 2.0 or Atom, e.g. status.x.ai/feed.xml"
                                          : undefined
                                }
                            >
                                <Input
                                    value={form.target}
                                    onChange={(event) => patch({ target: event.target.value })}
                                    placeholder={
                                        form.kind === "statuspage"
                                            ? "status.claude.com"
                                            : form.kind === "rss"
                                              ? "https://status.x.ai/feed.xml"
                                              : "https://example.com"
                                    }
                                    className="font-mono"
                                />
                            </Field>
                        )}

                        <Field label="Check every">
                            <Select
                                value={String(form.intervalSec)}
                                onValueChange={(value) => patch({ intervalSec: Number(value) })}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {INTERVALS.map((option) => (
                                        <SelectItem key={option.value} value={String(option.value)}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>

                        <Field label="Timeout (ms)">
                            <Input
                                type="number"
                                min={1000}
                                max={120000}
                                step={500}
                                value={form.timeoutMs}
                                onChange={(event) => {
                                    const next = Number(event.target.value);
                                    patch({
                                        timeoutMs: event.target.value === "" || !next ? DEFAULT_TIMEOUT_MS : next,
                                    });
                                }}
                            />
                        </Field>

                        {form.kind === "website" && (
                            <>
                                <Field label="Expected status" hint="Empty = any status below 400">
                                    <Input
                                        type="number"
                                        min={100}
                                        max={599}
                                        value={form.expectStatus}
                                        onChange={(event) => patch({ expectStatus: event.target.value })}
                                        placeholder="200"
                                    />
                                </Field>
                                <Field label="Body must contain">
                                    <Input
                                        value={form.expectBody}
                                        onChange={(event) => patch({ expectBody: event.target.value })}
                                        placeholder="optional text"
                                    />
                                </Field>
                            </>
                        )}

                        {(form.kind === "website" || form.kind === "ai-provider") && (
                            <Field label="Degraded above (ms)" hint="Slower answers count as degraded">
                                <Input
                                    type="number"
                                    min={1}
                                    value={form.degradedAboveMs}
                                    onChange={(event) => patch({ degradedAboveMs: event.target.value })}
                                    placeholder="2000"
                                />
                            </Field>
                        )}

                        {form.kind === "statuspage" && (
                            <ComponentPicker
                                target={form.target}
                                selected={form.components}
                                onChange={(components) => patch({ components })}
                            />
                        )}

                        {form.kind === "rss" && (
                            <>
                                <Field label="Only items containing" hint="Comma-separated words; empty = every item">
                                    <Input
                                        value={form.itemFilter}
                                        onChange={(event) => patch({ itemFilter: event.target.value })}
                                        placeholder="outage, API"
                                    />
                                </Field>
                                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                                    <Switch
                                        checked={form.deliverItems}
                                        onCheckedChange={(checked) => patch({ deliverItems: checked })}
                                    />
                                    Deliver new items
                                </label>
                            </>
                        )}
                    </div>

                    <TargetPicker selected={form.targetIds} onChange={(targetIds) => patch({ targetIds })} />

                    <div className="flex flex-wrap items-center gap-6">
                        <label className="flex items-center gap-2 text-sm">
                            <Switch checked={form.notify} onCheckedChange={(checked) => patch({ notify: checked })} />
                            Notify
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <Switch checked={form.enabled} onCheckedChange={(checked) => patch({ enabled: checked })} />
                            Enabled
                        </label>
                    </div>

                    {testResult && (
                        <div className="flex items-start gap-3 rounded-2xl border border-border/60 bg-card/40 p-3">
                            <StatusBadge status={testResult.status} className="mt-0.5" />
                            <p className="text-sm text-muted-foreground">{testResult.detail}</p>
                        </div>
                    )}

                    <DialogFooter className="gap-2 sm:justify-between">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={!canSubmit || test.isPending}
                            onClick={onTest}
                        >
                            {test.isPending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <FlaskConical className="size-4" />
                            )}
                            Test now
                        </Button>
                        <div className="flex gap-2">
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!canSubmit || saving} className="btn-glow">
                                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                                {editing ? "Save changes" : "Add watcher"}
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
