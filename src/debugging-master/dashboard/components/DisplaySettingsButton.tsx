import { IconPopover } from "@ui/components/icon-button";
import { Wrench } from "lucide-react";
import type { ReactElement } from "react";
import {
    type LineBoundaries,
    LOG_FONT_FAMILY_OPTIONS,
    type LogFontFamily,
    type TimestampMode,
} from "@/lib/display-settings";
import { usePaneWrapLongLines } from "@/lib/use-pane-wrap-long-lines";
import { useDisplaySettings } from "./DisplaySettingsProvider";

function FontSizeField({
    label,
    value,
    onChange,
}: {
    label: string;
    value: number;
    onChange: (value: number) => void;
}): ReactElement {
    return (
        <label className="flex flex-col gap-1.5">
            <span className="dbg-ui-text-xs uppercase tracking-wider text-white/45">{label}</span>
            <div className="flex items-center gap-2">
                <input
                    type="range"
                    min={9}
                    max={18}
                    step={1}
                    value={value}
                    onChange={(event) => {
                        onChange(Number(event.target.value));
                    }}
                    className="flex-1 accent-cyan-400"
                />
                <span className="dbg-ui-text-sm text-white/70 w-8 text-right tabular-nums">{value}px</span>
            </div>
        </label>
    );
}

function SegmentedField<T extends string>({
    legend,
    value,
    options,
    onChange,
}: {
    legend: string;
    value: T;
    options: readonly { value: T; label: string }[];
    onChange: (value: T) => void;
}): ReactElement {
    return (
        <fieldset className="space-y-2">
            <legend className="dbg-ui-text-xs uppercase tracking-wider text-white/45">{legend}</legend>
            <div className="flex flex-wrap gap-2">
                {options.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                            onChange(option.value);
                        }}
                        className={`dbg-ui-text-sm flex-1 min-w-[4.5rem] px-2 py-1.5 rounded-md border tracking-wide transition-colors ${
                            value === option.value
                                ? "border-cyan-400/50 bg-cyan-500/10 text-white/90"
                                : "border-white/10 text-white/45 hover:text-white/75 hover:border-white/20"
                        }`}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
        </fieldset>
    );
}

function LogDisplayFields({
    settings,
    updateSettings,
    onReset,
    resetLabel,
    paneKey,
    showWrap,
}: {
    settings: ReturnType<typeof useDisplaySettings>["settings"];
    updateSettings: ReturnType<typeof useDisplaySettings>["updateSettings"];
    onReset: () => void;
    resetLabel: string;
    paneKey?: string;
    showWrap: boolean;
}): ReactElement {
    const paneWrap = usePaneWrapLongLines(paneKey);

    return (
        <>
            <SegmentedField<TimestampMode>
                legend="Timestamps"
                value={settings.timestampMode}
                options={[
                    { value: "every", label: "Every" },
                    { value: "change", label: "On change" },
                    { value: "never", label: "Never" },
                ]}
                onChange={(timestampMode) => {
                    updateSettings({ timestampMode });
                }}
            />
            <SegmentedField<LineBoundaries>
                legend="Line boundaries"
                value={settings.lineBoundaries}
                options={[
                    { value: "show", label: "Show" },
                    { value: "hide", label: "Hide" },
                ]}
                onChange={(lineBoundaries) => {
                    updateSettings({ lineBoundaries });
                }}
            />
            <SegmentedField<"show" | "hide">
                legend="Line ID"
                value={settings.showLineId ? "show" : "hide"}
                options={[
                    { value: "show", label: "Show" },
                    { value: "hide", label: "Hide" },
                ]}
                onChange={(next) => {
                    updateSettings({ showLineId: next === "show" });
                }}
            />
            {showWrap ? (
                <>
                    <SegmentedField<"wrap" | "nowrap">
                        legend={paneKey ? "Wrap long lines (pane)" : "Wrap long lines"}
                        value={
                            paneKey
                                ? paneWrap.effective
                                    ? "wrap"
                                    : "nowrap"
                                : settings.wrapLongLines
                                  ? "wrap"
                                  : "nowrap"
                        }
                        options={[
                            { value: "wrap", label: "Wrap" },
                            { value: "nowrap", label: "No wrap" },
                        ]}
                        onChange={(next) => {
                            const wrapLongLines = next === "wrap";

                            if (paneKey) {
                                paneWrap.setWrapLongLines(wrapLongLines);
                                return;
                            }

                            updateSettings({ wrapLongLines });
                        }}
                    />
                    {paneKey && paneWrap.override !== undefined ? (
                        <button
                            type="button"
                            onClick={paneWrap.resetToGlobal}
                            className="dbg-ui-text-xs uppercase tracking-wider text-cyan-400/70 hover:text-cyan-300"
                        >
                            use global wrap ({paneWrap.global ? "wrap" : "no wrap"})
                        </button>
                    ) : null}
                </>
            ) : null}
            <button
                type="button"
                onClick={onReset}
                className="dbg-ui-text-xs uppercase tracking-wider text-white/45 hover:text-white/75"
            >
                {resetLabel}
            </button>
        </>
    );
}

interface Props {
    variant?: "full" | "log";
    paneKey?: string;
}

function ResetDefaultsButton({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
    return (
        <button
            type="button"
            onClick={onClick}
            className="dbg-ui-text-xs uppercase tracking-wider text-white/45 hover:text-white/75"
        >
            {label}
        </button>
    );
}

export function DisplaySettingsButton({ variant = "full", paneKey }: Props): ReactElement {
    const { settings, updateSettings, resetTypographySettings, resetLogSettings } = useDisplaySettings();
    const isLogOnly = variant === "log";

    return (
        <IconPopover
            tooltip={isLogOnly ? "Log display settings" : "Display settings"}
            align="end"
            contentClassName="w-72 bg-[#0d0d18] border-white/10 text-white p-4 space-y-4 dbg-ui-text"
            trigger={
                <button
                    type="button"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-white/10 text-white/55 hover:text-white/90 hover:border-cyan-500/40 hover:bg-white/5 transition-colors"
                >
                    <Wrench className="w-4 h-4" />
                </button>
            }
        >
            <div>
                <p className="dbg-ui-text-sm uppercase tracking-widest text-white/50">
                    {isLogOnly ? "Log display" : "Display"}
                </p>
                <p className="dbg-ui-text-xs text-white/35 mt-1">Settings persist in this browser.</p>
            </div>
            {!isLogOnly ? (
                <>
                    <FontSizeField
                        label="UI text"
                        value={settings.uiFontSize}
                        onChange={(uiFontSize) => {
                            updateSettings({ uiFontSize });
                        }}
                    />
                    <FontSizeField
                        label="Session headers"
                        value={settings.headerFontSize}
                        onChange={(headerFontSize) => {
                            updateSettings({ headerFontSize });
                        }}
                    />
                    <FontSizeField
                        label="Log lines"
                        value={settings.logFontSize}
                        onChange={(logFontSize) => {
                            updateSettings({ logFontSize });
                        }}
                    />
                    <SegmentedField<LogFontFamily>
                        legend="Log font"
                        value={settings.logFontFamily}
                        options={LOG_FONT_FAMILY_OPTIONS}
                        onChange={(logFontFamily) => {
                            updateSettings({ logFontFamily });
                        }}
                    />
                    <ResetDefaultsButton label="reset typography defaults" onClick={resetTypographySettings} />
                    <SegmentedField<"wrap" | "nowrap">
                        legend="Wrap long lines (global)"
                        value={settings.wrapLongLines ? "wrap" : "nowrap"}
                        options={[
                            { value: "wrap", label: "Wrap" },
                            { value: "nowrap", label: "No wrap" },
                        ]}
                        onChange={(next) => {
                            updateSettings({ wrapLongLines: next === "wrap" });
                        }}
                    />
                    <p className="dbg-ui-text-xs text-white/30">
                        Global wrap applies to all panes; per-pane wrench can override.
                    </p>
                </>
            ) : null}
            <LogDisplayFields
                settings={settings}
                updateSettings={updateSettings}
                onReset={resetLogSettings}
                resetLabel={isLogOnly ? "reset log defaults" : "reset log display defaults"}
                paneKey={isLogOnly ? paneKey : undefined}
                showWrap={isLogOnly}
            />
        </IconPopover>
    );
}
