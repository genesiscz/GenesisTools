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

/** Human phrasing for the live dialog description — reads as a sentence
 *  fragment after "written with". */
export const TONE_PHRASES: Record<SummaryTone, string> = {
    insightful: "an insightful, analytical voice",
    funny: "a light, playful voice",
    actionable: "a focus on practical takeaways",
    controversial: "the boldest, most debated angles front and center",
};

export const LENGTH_PHRASES: Record<SummaryLength, string> = {
    short: "kept brief",
    auto: "sized to the video",
    detailed: "with extra detail",
};

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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-primary/15 bg-black/30 px-3 py-2">
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
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {label}
            <Select value={value} onValueChange={onChange} disabled={disabled}>
                <SelectTrigger className="h-8 border-primary/20 bg-black/40 text-xs capitalize text-foreground/90">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem key={option} value={option} className="text-xs capitalize">
                            {option === "qa" ? "Q&A" : option}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </label>
    );
}
