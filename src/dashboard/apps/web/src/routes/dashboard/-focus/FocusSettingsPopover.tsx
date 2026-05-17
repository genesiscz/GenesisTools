import type { PomodoroSettings } from "@dashboard/shared";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Slider } from "@ui/components/slider";
import { Settings as SettingsIcon } from "lucide-react";

interface FocusSettingsPopoverProps {
    settings: PomodoroSettings;
    onChange: (patch: Partial<PomodoroSettings>) => void;
}

const minutes = (ms: number) => Math.round(ms / 60_000);
const fromMinutes = (m: number) => m * 60_000;

export function FocusSettingsPopover({ settings, onChange }: FocusSettingsPopoverProps) {
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="hover:bg-amber-500/10 transition-colors">
                    <SettingsIcon className="h-4 w-4 text-amber-500/70" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 bg-card/95 backdrop-blur-xl border border-amber-500/20" align="end">
                <div className="space-y-4">
                    <div>
                        <h4 className="text-sm font-bold mb-1">Focus Cycle</h4>
                        <p className="text-xs text-muted-foreground font-mono">All durations in minutes.</p>
                    </div>

                    <div className="space-y-1">
                        <Label className="text-xs font-mono text-amber-500/80">
                            WORK · {minutes(settings.workDuration)}m
                        </Label>
                        <Slider
                            min={5}
                            max={90}
                            step={5}
                            value={[minutes(settings.workDuration)]}
                            onValueChange={(v) => onChange({ workDuration: fromMinutes(v[0] ?? 25) })}
                        />
                    </div>

                    <div className="space-y-1">
                        <Label className="text-xs font-mono text-emerald-400/80">
                            SHORT BREAK · {minutes(settings.shortBreakDuration)}m
                        </Label>
                        <Slider
                            min={1}
                            max={20}
                            step={1}
                            value={[minutes(settings.shortBreakDuration)]}
                            onValueChange={(v) => onChange({ shortBreakDuration: fromMinutes(v[0] ?? 5) })}
                        />
                    </div>

                    <div className="space-y-1">
                        <Label className="text-xs font-mono text-cyan-400/80">
                            LONG BREAK · {minutes(settings.longBreakDuration)}m
                        </Label>
                        <Slider
                            min={5}
                            max={45}
                            step={5}
                            value={[minutes(settings.longBreakDuration)]}
                            onValueChange={(v) => onChange({ longBreakDuration: fromMinutes(v[0] ?? 15) })}
                        />
                    </div>

                    <div className="space-y-1">
                        <Label className="text-xs font-mono text-muted-foreground">
                            SESSIONS BEFORE LONG BREAK · {settings.sessionsBeforeLongBreak}
                        </Label>
                        <Slider
                            min={2}
                            max={8}
                            step={1}
                            value={[settings.sessionsBeforeLongBreak]}
                            onValueChange={(v) => onChange({ sessionsBeforeLongBreak: v[0] ?? 4 })}
                        />
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
