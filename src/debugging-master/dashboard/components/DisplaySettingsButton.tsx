import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Wrench } from "lucide-react";
import type { ReactElement } from "react";
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
            <span className="text-[10px] uppercase tracking-wider text-white/45">{label}</span>
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
                <span className="text-[11px] text-white/70 w-8 text-right tabular-nums">{value}px</span>
            </div>
        </label>
    );
}

export function DisplaySettingsButton(): ReactElement {
    const { settings, updateSettings, resetSettings } = useDisplaySettings();

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-white/10 text-white/55 hover:text-white/90 hover:border-cyan-500/40 hover:bg-white/5 transition-colors"
                    title="Display settings"
                    aria-label="Display settings"
                >
                    <Wrench className="w-4 h-4" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 bg-[#0d0d18] border-white/10 text-white p-4 space-y-4">
                <div>
                    <p className="text-[11px] uppercase tracking-widest text-white/50">Display</p>
                    <p className="text-[10px] text-white/35 mt-1">Font sizes persist in this browser.</p>
                </div>
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
                <button
                    type="button"
                    onClick={resetSettings}
                    className="text-[10px] uppercase tracking-wider text-white/45 hover:text-white/75"
                >
                    reset defaults
                </button>
            </PopoverContent>
        </Popover>
    );
}
