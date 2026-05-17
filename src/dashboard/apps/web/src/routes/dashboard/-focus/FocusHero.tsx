import { Button } from "@ui/components/button";
import { AlertBlock, EmptyState, FloatingActionButton, KbdShortcut, PageLoadingSpinner } from "@ui/custom";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { Pause, Play, RotateCcw, ShieldAlert, SkipForward, Target } from "lucide-react";
import { useEffect, useState } from "react";
import { useDistractions } from "@/lib/assistant/hooks";
import { FocusSessionComplete } from "@/routes/assistant/-components/celebrations/FocusSessionComplete";
import { DistractionLogModal } from "@/routes/assistant/-components/distractions";
import "@/components/auth/cyberpunk.css";
import { useAssistantTasksQuery } from "@/lib/assistant/hooks/useAssistantQueries";
import { FocusSettingsPopover } from "./FocusSettingsPopover";
import { FocusStatsRow } from "./FocusStatsRow";
import { PhaseBadge } from "./PhaseBadge";
import { useFocusSession } from "./useFocusSession";
import { useAggregatedFocusStats } from "./useFocusStats";
import { usePhaseColor } from "./usePhaseColor";

/** Dev fallback userId when no WorkOS session is present. */
const DEV_USER_ID = "dev-user";

function formatMMSS(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function FocusHero({ linkedTaskId }: { linkedTaskId?: string }) {
    const f = useFocusSession();
    const color = usePhaseColor(f.phase);
    const { user } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const { logDistraction } = useDistractions(userId);
    const focusStats = useAggregatedFocusStats(userId);
    const tasksQuery = useAssistantTasksQuery(userId);
    const linkedTask = linkedTaskId ? tasksQuery.data?.find((t) => t.id === linkedTaskId) : undefined;
    const [distractionOpen, setDistractionOpen] = useState(false);

    // Keyboard shortcuts
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }

            if (e.code === "Space") {
                e.preventDefault();

                if (f.isRunning) {
                    f.pause();
                } else {
                    f.start();
                }
            } else if (e.code === "KeyR") {
                f.reset();
            } else if (e.code === "KeyS") {
                f.skipPhase();
            }
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [f.isRunning, f.pause, f.start, f.reset, f.skipPhase]);

    if (f.isLoading) {
        return <PageLoadingSpinner label="Loading focus session..." />;
    }

    if (f.error) {
        return <AlertBlock color="rose">Failed to load focus: {String(f.error)}</AlertBlock>;
    }

    if (!f.focusTimer) {
        return (
            <EmptyState
                icon={Target}
                title="Start a focus session"
                description="Pomodoro: deep work in 25-minute blocks, short breaks between. Long break every 4 sessions."
                cta={
                    <Button variant="brand" size="lg" onClick={() => void f.ensureFocusTimer()} disabled={f.isCreating}>
                        Begin First Session
                    </Button>
                }
            />
        );
    }

    const scanlineOpacity =
        f.phase === "work"
            ? color.scanlineBase + (0.35 - color.scanlineBase) * Math.min(1, f.progressRatio)
            : color.scanlineBase;

    const glowIntensity = 0.2 + 0.4 * f.progressRatio;
    const glowSize = Math.round(20 + 20 * f.progressRatio);

    return (
        <div className="relative isolate overflow-hidden min-h-[calc(100vh-3.5rem)]">
            {/* Ambient orbs */}
            <div
                className={`absolute top-0 right-0 w-[40rem] h-[40rem] rounded-full blur-3xl -translate-y-1/3 translate-x-1/3 transition-colors duration-1000 pointer-events-none ${color.orbRight}`}
            />
            <div
                className={`absolute bottom-0 left-0 w-[32rem] h-[32rem] rounded-full blur-3xl translate-y-1/3 -translate-x-1/3 transition-colors duration-1000 pointer-events-none ${color.orbLeft}`}
            />

            {/* Scanlines */}
            <div
                className="absolute inset-0 scan-lines pointer-events-none"
                style={{ opacity: scanlineOpacity, transition: "opacity 1s ease-in-out" }}
            />

            {/* Sticky phase bar */}
            <div
                className={`sticky top-14 z-20 backdrop-blur-xl bg-[#030308]/70 border-b transition-colors duration-1000 ${color.headerBorder}`}
            >
                <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 flex-wrap">
                        <PhaseBadge
                            phase={f.phase}
                            sessionCount={f.sessionCount}
                            cycleLength={f.settings.sessionsBeforeLongBreak}
                        />
                        <div className="hidden md:flex items-center gap-2">
                            <KbdShortcut keys={["Space"]} />
                            <span className="text-[10px] text-muted-foreground font-mono">play/pause</span>
                            <KbdShortcut keys={["R"]} />
                            <span className="text-[10px] text-muted-foreground font-mono">reset</span>
                            <KbdShortcut keys={["S"]} />
                            <span className="text-[10px] text-muted-foreground font-mono">skip</span>
                        </div>
                    </div>
                    <FocusSettingsPopover settings={f.settings} onChange={f.updateSettings} />
                </div>
            </div>

            {/* Hero content */}
            <div className="relative z-10 max-w-5xl mx-auto px-4 py-16 flex flex-col items-center gap-12">
                {/* Countdown digits */}
                <div className="text-center">
                    <h1
                        className={`font-mono font-bold tracking-[-0.02em] ${color.gradientClass} bg-clip-text text-transparent transition-colors duration-1000`}
                        style={{
                            fontSize: "clamp(4rem, 14vw, 10rem)",
                            textShadow: `0 0 ${glowSize}px rgb(${color.glowRgb} / ${glowIntensity})`,
                        }}
                    >
                        {formatMMSS(f.remainingMs)}
                    </h1>
                    <p className="text-xs font-mono tracking-widest uppercase text-muted-foreground mt-4">
                        {f.phase === "work" ? "deep focus" : f.phase === "short_break" ? "step away" : "recharge"}
                    </p>
                    {linkedTask && (
                        <p className="mt-3 font-mono text-xs uppercase tracking-widest text-amber-400/80">
                            Focusing on: {linkedTask.title}
                        </p>
                    )}
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button
                        variant="brand"
                        size="lg"
                        className="h-14 px-8 text-base font-mono"
                        onClick={() => {
                            if (f.isRunning) {
                                f.pause();
                            } else {
                                f.start();
                            }
                        }}
                    >
                        {f.isRunning ? <Pause className="h-5 w-5 mr-2" /> : <Play className="h-5 w-5 mr-2" />}
                        {f.isRunning ? "Pause" : f.elapsedMs > 0 ? "Resume" : "Start Focus"}
                    </Button>
                    <Button
                        variant="outline"
                        size="lg"
                        onClick={f.reset}
                        className="border-amber-500/30 hover:border-amber-500/60 transition-all"
                    >
                        <RotateCcw className="h-4 w-4 mr-2" />
                        Reset
                    </Button>
                    <Button
                        variant="outline"
                        size="lg"
                        onClick={f.skipPhase}
                        className="border-amber-500/30 hover:border-amber-500/60 transition-all"
                    >
                        <SkipForward className="h-4 w-4 mr-2" />
                        Skip Phase
                    </Button>
                </div>

                {/* Stats row — live from activity_logs aggregation */}
                <FocusStatsRow
                    timeFocusedTodayMs={focusStats.timeFocusedTodayMs}
                    sessionsToday={focusStats.sessionsToday}
                    dayStreak={focusStats.dayStreak}
                />
            </div>

            {/* Distraction FAB — work phase only */}
            {f.phase === "work" && (
                <FloatingActionButton
                    icon={ShieldAlert}
                    label="Log Distraction"
                    onClick={() => setDistractionOpen(true)}
                    className="bg-rose-600 hover:bg-rose-500 border-rose-400/30 shadow-rose-500/25"
                />
            )}

            {distractionOpen && (
                <DistractionLogModal
                    open={distractionOpen}
                    onOpenChange={setDistractionOpen}
                    onLog={async (source, _description, taskInterrupted) => {
                        await logDistraction({ source, taskInterrupted });
                        setDistractionOpen(false);
                    }}
                />
            )}

            {/* Phase-complete celebration (work → break only) */}
            {f.pendingTransition?.fromPhase === "work" && (
                <FocusSessionComplete
                    focusMinutes={Math.round(f.settings.workDuration / 60_000)}
                    onDismiss={f.dismissTransition}
                />
            )}
        </div>
    );
}
