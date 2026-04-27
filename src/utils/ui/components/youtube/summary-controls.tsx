import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import type { SummaryFormat, SummaryLength, SummaryTone } from "@app/youtube/lib/types";

export interface SummaryControlsState {
    tone: SummaryTone;
    format: SummaryFormat;
    length: SummaryLength;
}

export const DEFAULT_SUMMARY_CONTROLS: SummaryControlsState = {
    tone: "insightful",
    format: "list",
    length: "auto",
};

const TONES: SummaryTone[] = ["insightful", "funny", "actionable", "controversial"];
const FORMATS: SummaryFormat[] = ["list", "qa"];
const LENGTHS: SummaryLength[] = ["short", "auto", "detailed"];

export interface SummaryControlsBarProps {
    value: SummaryControlsState;
    onChange: (next: SummaryControlsState) => void;
    /** Hide the Format dropdown when the surface doesn't support qa (e.g. Long-form Summary). */
    hideFormat?: boolean;
    /** Disabled while a request is in flight. */
    disabled?: boolean;
}

export function SummaryControlsBar({ value, onChange, hideFormat, disabled }: SummaryControlsBarProps) {
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/15 bg-black/30 px-3 py-2">
            <ControlSelect
                label="Tone"
                options={TONES}
                value={value.tone}
                onChange={(next) => onChange({ ...value, tone: next as SummaryTone })}
                disabled={disabled}
            />
            {hideFormat ? null : (
                <ControlSelect
                    label="Format"
                    options={FORMATS}
                    value={value.format}
                    onChange={(next) => onChange({ ...value, format: next as SummaryFormat })}
                    disabled={disabled}
                />
            )}
            <ControlSelect
                label="Length"
                options={LENGTHS}
                value={value.length}
                onChange={(next) => onChange({ ...value, length: next as SummaryLength })}
                disabled={disabled}
            />
        </div>
    );
}

function ControlSelect({
    label,
    options,
    value,
    onChange,
    disabled,
}: {
    label: string;
    options: readonly string[];
    value: string;
    onChange: (next: string) => void;
    disabled?: boolean;
}) {
    return (
        <label className="flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
            {label}
            <Select value={value} onValueChange={onChange} disabled={disabled}>
                <SelectTrigger className="h-8 w-32 border-primary/20 bg-black/40 font-mono text-xs uppercase tracking-[0.18em] text-foreground/90">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem
                            key={option}
                            value={option}
                            className="font-mono text-xs uppercase tracking-[0.18em]"
                        >
                            {option === "qa" ? "Q&A" : option}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </label>
    );
}
