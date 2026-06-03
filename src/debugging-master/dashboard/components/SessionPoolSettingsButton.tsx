import { IconPopover } from "@ui/components/icon-button";
import { Wrench } from "lucide-react";
import type { ReactElement } from "react";
import { MAX_ACTIVE_SESSION_LIMIT_MINUTES, MIN_ACTIVE_SESSION_LIMIT_MINUTES } from "@/lib/session-pool-settings";
import { useSessionPoolSettings } from "./SessionPoolSettingsProvider";

export function SessionPoolSettingsButton(): ReactElement {
    const { settings, updateSettings, resetSettings } = useSessionPoolSettings();

    return (
        <IconPopover
            tooltip="Mosaic & live session pool"
            align="start"
            contentClassName="w-72 bg-[#0d0d18] border-white/10 text-white p-4 space-y-4 dbg-ui-text"
            trigger={
                <button
                    type="button"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-white/10 text-white/55 hover:text-white/90 hover:border-cyan-500/40 hover:bg-white/5 transition-colors shrink-0"
                    aria-label="Mosaic and live session settings"
                >
                    <Wrench className="w-4 h-4" />
                </button>
            }
        >
            <div>
                <p className="dbg-ui-text-sm uppercase tracking-widest text-white/50">Live sessions</p>
                <p className="dbg-ui-text-xs text-white/35 mt-1">Saved in this browser.</p>
            </div>

            <label className="flex flex-col gap-1.5">
                <span className="dbg-ui-text-xs uppercase tracking-wider text-white/45">Active session limit</span>
                <div className="flex items-center gap-2">
                    <input
                        type="range"
                        min={MIN_ACTIVE_SESSION_LIMIT_MINUTES}
                        max={MAX_ACTIVE_SESSION_LIMIT_MINUTES}
                        step={5}
                        value={settings.activeSessionLimitMinutes}
                        onChange={(event) => {
                            updateSettings({ activeSessionLimitMinutes: Number(event.target.value) });
                        }}
                        className="flex-1 accent-cyan-400"
                    />
                    <span className="dbg-ui-text-sm text-white/70 w-14 text-right tabular-nums">
                        {settings.activeSessionLimitMinutes}m
                    </span>
                </div>
                <p className="dbg-ui-text-xs text-white/35 leading-relaxed">
                    Exited sessions stay in the live pool and mosaic pills for this long after their last activity.
                </p>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                    type="checkbox"
                    checked={settings.keepAllAlive}
                    onChange={(event) => {
                        updateSettings({ keepAllAlive: event.target.checked });
                    }}
                    className="mt-0.5 accent-cyan-400"
                />
                <span className="space-y-1">
                    <span className="dbg-ui-text-sm text-white/85 block">Keep all alive</span>
                    <span className="dbg-ui-text-xs text-white/35 block leading-relaxed">
                        Show every live-pool session in the mosaic grid. When off, at most six tiles are shown and the
                        rest stay as pills only.
                    </span>
                </span>
            </label>

            <button
                type="button"
                onClick={resetSettings}
                className="dbg-ui-text-xs uppercase tracking-wider text-white/45 hover:text-white/75"
            >
                reset defaults
            </button>
        </IconPopover>
    );
}
