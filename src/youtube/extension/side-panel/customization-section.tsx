import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { Switch } from "@app/utils/ui/components/switch";
import { OUTPUT_LANGS } from "@app/utils/ui/components/youtube/output-langs";
import { LENGTH_PHRASES, TONE_PHRASES } from "@app/utils/ui/components/youtube/summary-controls";
import type { SummaryFormat, SummaryLength, SummaryTone } from "@app/youtube/lib/types";
import type { SettingsTaskKind, TaskDefaultSettings, UserSettings } from "@app/youtube/lib/user-settings";
import { useMe, useModels, useSettings, useUpdateSettings } from "@ext/api.hooks";
import type { ReactNode } from "react";

const TASK_KINDS: Array<{ kind: SettingsTaskKind; label: string }> = [
    { kind: "summary", label: "Summary" },
    { kind: "insights", label: "Insights" },
    { kind: "ask", label: "Ask" },
];

const TONE_OPTIONS = Object.keys(TONE_PHRASES) as SummaryTone[];
const LENGTH_OPTIONS = Object.keys(LENGTH_PHRASES) as SummaryLength[];
const FORMAT_LABELS: Record<SummaryFormat, string> = { list: "List", qa: "Q&A" };
const PANEL_TABS = ["summary", "insights", "ask", "transcript", "comments"];
/** Sentinel Select value = "no per-task lang, follow the account output language". */
const ACCOUNT_LANG = "__account__";

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Customization surface (spec §6) for the extension settings dialog — theme,
 * density, per-task generation defaults, and panel behavior. Every control
 * auto-persists on change (optimistic via `useUpdateSettings`, no save button —
 * Martin's requirement). Model per task is admin/dev only. The panel actually
 * consumes these (theme/density on the shadow root, taskDefaults seed the tab
 * controls, panel rules seed initial tab/collapse) — see side-panel.tsx.
 */
export function CustomizationSection() {
    const me = useMe();
    const settings = useSettings();
    const update = useUpdateSettings();
    const isPower = me.data?.role === "admin" || me.data?.role === "dev";
    const models = useModels(isPower);

    if (!settings.data) {
        return null;
    }

    const value = settings.data.settings;

    function patch(next: UserSettings) {
        update.mutate(next);
    }

    function patchTask(kind: SettingsTaskKind, entry: TaskDefaultSettings) {
        patch({ taskDefaults: { [kind]: entry } });
    }

    return (
        <div className="space-y-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">customization</p>

            <div className="grid grid-cols-2 gap-2">
                <Field label="Theme">
                    <Select
                        value={value.theme ?? "system"}
                        onValueChange={(next) => patch({ theme: next as UserSettings["theme"] })}
                    >
                        <SelectTrigger className="h-8 w-full text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="system">System</SelectItem>
                            <SelectItem value="light">Light</SelectItem>
                            <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                    </Select>
                </Field>
                <Field label="Density">
                    <Select
                        value={value.density ?? "comfortable"}
                        onValueChange={(next) => patch({ density: next as UserSettings["density"] })}
                    >
                        <SelectTrigger className="h-8 w-full text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="comfortable">Comfortable</SelectItem>
                            <SelectItem value="compact">Compact</SelectItem>
                        </SelectContent>
                    </Select>
                </Field>
            </div>

            <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Per-action defaults</p>
                {TASK_KINDS.map(({ kind, label }) => {
                    const task = value.taskDefaults?.[kind] ?? {};

                    return (
                        <div key={kind} className="space-y-1.5 rounded-2xl border border-white/8 bg-black/20 p-2.5">
                            <p className="text-sm font-semibold text-foreground/95">{label}</p>
                            <div className="grid grid-cols-2 gap-1.5">
                                <Select
                                    value={task.tone ?? "insightful"}
                                    onValueChange={(next) => patchTask(kind, { tone: next as SummaryTone })}
                                >
                                    <SelectTrigger className="h-7 w-full text-xs" aria-label={`${label} tone`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {TONE_OPTIONS.map((tone) => (
                                            <SelectItem key={tone} value={tone}>
                                                {capitalize(tone)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select
                                    value={task.length ?? "auto"}
                                    onValueChange={(next) => patchTask(kind, { length: next as SummaryLength })}
                                >
                                    <SelectTrigger className="h-7 w-full text-xs" aria-label={`${label} length`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {LENGTH_OPTIONS.map((length) => (
                                            <SelectItem key={length} value={length}>
                                                {capitalize(length)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select
                                    value={task.format ?? "list"}
                                    onValueChange={(next) => patchTask(kind, { format: next as SummaryFormat })}
                                >
                                    <SelectTrigger className="h-7 w-full text-xs" aria-label={`${label} format`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {(Object.keys(FORMAT_LABELS) as SummaryFormat[]).map((format) => (
                                            <SelectItem key={format} value={format}>
                                                {FORMAT_LABELS[format]}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select
                                    value={task.lang ?? ACCOUNT_LANG}
                                    onValueChange={(next) =>
                                        patchTask(kind, next === ACCOUNT_LANG ? {} : { lang: next })
                                    }
                                >
                                    <SelectTrigger className="h-7 w-full text-xs" aria-label={`${label} language`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={ACCOUNT_LANG}>Account language</SelectItem>
                                        {OUTPUT_LANGS.map((lang) => (
                                            <SelectItem key={lang.code} value={lang.code}>
                                                <span className="font-mono text-[12px] uppercase">{lang.code}</span>{" "}
                                                {lang.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            {isPower ? (
                                <Select
                                    value={task.model ?? ACCOUNT_LANG}
                                    onValueChange={(next) =>
                                        patchTask(kind, next === ACCOUNT_LANG ? {} : { model: next })
                                    }
                                >
                                    <SelectTrigger className="h-7 w-full text-xs" aria-label={`${label} model`}>
                                        <SelectValue placeholder="Model · dev" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={ACCOUNT_LANG}>Server default model</SelectItem>
                                        {(models.data?.presets ?? []).map((preset) => (
                                            <SelectItem key={preset.label} value={preset.model}>
                                                {preset.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Panel behavior</p>
                <Field label="Default tab">
                    <Select
                        value={value.panel?.defaultTab ?? "summary"}
                        onValueChange={(next) => patch({ panel: { defaultTab: next } })}
                    >
                        <SelectTrigger className="h-8 w-full text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {PANEL_TABS.map((tab) => (
                                <SelectItem key={tab} value={tab}>
                                    {capitalize(tab)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <ToggleRow
                    label="Auto-open on video pages"
                    checked={value.panel?.autoOpen ?? true}
                    onChange={(checked) => patch({ panel: { autoOpen: checked } })}
                />
                <ToggleRow
                    label="Remember collapsed state"
                    checked={value.panel?.rememberCollapse ?? false}
                    onChange={(checked) => patch({ panel: { rememberCollapse: checked } })}
                />
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function ToggleRow({
    label,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-foreground/90">
            {label}
            <Switch checked={checked} onCheckedChange={onChange} />
        </label>
    );
}
