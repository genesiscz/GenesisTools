import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { Switch } from "@app/utils/ui/components/switch";
import { LENGTH_PHRASES, TONE_PHRASES } from "@app/utils/ui/components/youtube/summary-controls";
import { OUTPUT_LANGS } from "@app/youtube/lib/languages";
import type { SummaryFormat, SummaryLength, SummaryTone } from "@app/youtube/lib/types";
import type { SettingsTaskKind, TaskDefaultSettings, UserSettings } from "@app/youtube/lib/user-settings";
import { useMe, useUpdateUserSettings, useUserSettings } from "@app/yt/api.hooks";
import { Palette, PanelRightOpen, SlidersHorizontal } from "lucide-react";

const TASK_KINDS: Array<{ kind: SettingsTaskKind; label: string }> = [
    { kind: "summary", label: "Summary" },
    { kind: "insights", label: "Insights" },
    { kind: "ask", label: "Ask" },
];

const TONE_OPTIONS = Object.keys(TONE_PHRASES) as SummaryTone[];
const LENGTH_OPTIONS = Object.keys(LENGTH_PHRASES) as SummaryLength[];
const FORMAT_LABELS: Record<SummaryFormat, string> = { list: "List", qa: "Q&A" };
const PANEL_TABS = ["summary", "insights", "ask", "transcript", "comments"];
const AUTO = "__auto__";

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

export function CustomizationSection() {
    const me = useMe();
    const settings = useUserSettings();
    const update = useUpdateUserSettings();

    if (!me.data) {
        return null;
    }

    if (!settings.data) {
        return null;
    }

    const value = settings.data;
    const isPower = me.data.role === "admin" || me.data.role === "dev";

    function patch(next: Partial<UserSettings>) {
        update.mutate(next);
    }

    function patchTask(kind: SettingsTaskKind, entry: Partial<TaskDefaultSettings>) {
        patch({ taskDefaults: { [kind]: entry } });
    }

    return (
        <>
            <Card className="yt-panel">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-xl">
                        <Palette className="size-5" /> Appearance
                    </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                    <SettingRow label="Theme" hint="System follows your device.">
                        <Select
                            value={value.theme ?? "system"}
                            onValueChange={(next) => patch({ theme: next as UserSettings["theme"] })}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="system">System</SelectItem>
                                <SelectItem value="light">Light</SelectItem>
                                <SelectItem value="dark">Dark</SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingRow>
                    <SettingRow label="Density" hint="Compact tightens spacing.">
                        <Select
                            value={value.density ?? "comfortable"}
                            onValueChange={(next) => patch({ density: next as UserSettings["density"] })}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="comfortable">Comfortable</SelectItem>
                                <SelectItem value="compact">Compact</SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingRow>
                </CardContent>
            </Card>

            <Card className="yt-panel">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-xl">
                        <SlidersHorizontal className="size-5" /> Task defaults
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                        Applied to each action when you don't override it in the moment.
                    </p>
                </CardHeader>
                <CardContent className="space-y-6">
                    {TASK_KINDS.map(({ kind, label }) => {
                        const task = value.taskDefaults?.[kind] ?? {};

                        return (
                            <div
                                key={kind}
                                className="space-y-3 rounded-2xl border border-secondary/15 bg-black/10 p-4"
                            >
                                <p className="font-mono text-xs uppercase tracking-[0.22em] text-secondary">{label}</p>
                                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                    <SettingRow label="Tone">
                                        <AutoSelect
                                            value={task.tone}
                                            placeholder="Auto"
                                            onChange={(next) => patchTask(kind, { tone: next as SummaryTone })}
                                            options={TONE_OPTIONS.map((tone) => ({
                                                value: tone,
                                                label: `${capitalize(tone)} · ${TONE_PHRASES[tone]}`,
                                            }))}
                                        />
                                    </SettingRow>
                                    <SettingRow label="Length">
                                        <AutoSelect
                                            value={task.length}
                                            placeholder="Auto"
                                            onChange={(next) => patchTask(kind, { length: next as SummaryLength })}
                                            options={LENGTH_OPTIONS.map((len) => ({
                                                value: len,
                                                label: `${capitalize(len)} · ${LENGTH_PHRASES[len]}`,
                                            }))}
                                        />
                                    </SettingRow>
                                    <SettingRow label="Format">
                                        <AutoSelect
                                            value={task.format}
                                            placeholder="Auto"
                                            onChange={(next) => patchTask(kind, { format: next as SummaryFormat })}
                                            options={(Object.keys(FORMAT_LABELS) as SummaryFormat[]).map((fmt) => ({
                                                value: fmt,
                                                label: FORMAT_LABELS[fmt],
                                            }))}
                                        />
                                    </SettingRow>
                                    <SettingRow label="Language">
                                        <AutoSelect
                                            value={task.lang}
                                            placeholder="Auto"
                                            onChange={(next) => patchTask(kind, { lang: next })}
                                            options={OUTPUT_LANGS.map((lang) => ({
                                                value: lang.code,
                                                label: lang.label,
                                            }))}
                                        />
                                    </SettingRow>
                                    {isPower ? (
                                        <SettingRow label="Model" hint="Admin/dev only.">
                                            <Input
                                                value={task.model ?? ""}
                                                placeholder="provider/model"
                                                onChange={(event) => patchTask(kind, { model: event.target.value })}
                                            />
                                        </SettingRow>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </CardContent>
            </Card>

            <Card className="yt-panel">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-xl">
                        <PanelRightOpen className="size-5" /> Panel behavior
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                        Controls the in-page companion panel (mainly the browser extension).
                    </p>
                </CardHeader>
                <CardContent className="space-y-3">
                    <SettingRow label="Default tab" hint="Which tab the panel opens on.">
                        <Select
                            value={value.panel?.defaultTab ?? PANEL_TABS[0]}
                            onValueChange={(next) => patch({ panel: { defaultTab: next } })}
                        >
                            <SelectTrigger>
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
                    </SettingRow>
                    <ToggleRow
                        label="Auto-open"
                        hint="Open the panel automatically on video pages."
                        checked={value.panel?.autoOpen ?? false}
                        onChange={(checked) => patch({ panel: { autoOpen: checked } })}
                    />
                    <ToggleRow
                        label="Start collapsed"
                        hint="Open minimized until you expand it."
                        checked={value.panel?.collapsed ?? false}
                        onChange={(checked) => patch({ panel: { collapsed: checked } })}
                    />
                    <ToggleRow
                        label="Floating panel"
                        hint="Float over the page instead of docking inline."
                        checked={value.panel?.floating ?? false}
                        onChange={(checked) => patch({ panel: { floating: checked } })}
                    />
                    <ToggleRow
                        label="Remember collapse"
                        hint="Keep the collapse state per video."
                        checked={value.panel?.rememberCollapse ?? false}
                        onChange={(checked) => patch({ panel: { rememberCollapse: checked } })}
                    />
                </CardContent>
            </Card>
        </>
    );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="space-y-1.5">
            <span className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">{label}</span>
            {children}
            {hint ? <span className="block text-xs text-muted-foreground/70">{hint}</span> : null}
        </label>
    );
}

function ToggleRow({
    label,
    hint,
    checked,
    onChange,
}: {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <label className="flex items-center justify-between gap-4 rounded-xl border border-secondary/15 bg-black/10 px-4 py-3">
            <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
            </span>
            <Switch checked={checked} onCheckedChange={onChange} />
        </label>
    );
}

function AutoSelect({
    value,
    placeholder,
    options,
    onChange,
}: {
    value: string | undefined;
    placeholder: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
}) {
    return (
        <Select
            value={value ?? AUTO}
            onValueChange={(next) => {
                if (next !== AUTO) {
                    onChange(next);
                }
            }}
        >
            <SelectTrigger>
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={AUTO}>{placeholder}</SelectItem>
                {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
