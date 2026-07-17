import { Button } from "@app/utils/ui/components/button";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import { Loader2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const RATES = [1, 1.25, 1.5] as const;
/** A YouTube-time jump bigger than this between two 1 Hz samples means "the video started playing," not clock jitter. */
const PLAYER_MOVE_THRESHOLD_SEC = 0.5;

export interface SummaryAudioPlayerProps {
    /** "5 💎" — shown on the pre-synthesis button. Empty string hides the suffix. */
    priceLabel: string;
    /** POSTs the synthesis request and resolves the authenticated `<audio src>` URL. */
    onPrepare: () => Promise<string>;
    /** Pauses the YouTube player via the existing postMessage bridge — called right before this audio starts. */
    onPlayVideo?: () => void;
    /** Current YouTube playback second (1 Hz bridge) — a jump pauses this audio (mutual exclusivity). */
    playerTime?: number | null;
}

export function SummaryAudioPlayer({ priceLabel, onPrepare, onPlayVideo, playerTime }: SummaryAudioPlayerProps) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [src, setSrc] = useState<string | null>(null);
    const [state, setState] = useState<"idle" | "preparing" | "ready" | "error">("idle");
    const [error, setError] = useState<string | null>(null);
    const [playing, setPlaying] = useState(false);
    const [pos, setPos] = useState(0);
    const [dur, setDur] = useState(0);
    const [rateIdx, setRateIdx] = useState(0);
    const lastPlayerTimeRef = useRef<number | null>(null);

    async function onPrepareClick(): Promise<void> {
        setState("preparing");
        setError(null);

        try {
            const url = await onPrepare();
            setSrc(url);
            setState("ready");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setState("error");
        }
    }

    function togglePlay(): void {
        const audio = audioRef.current;

        if (!audio) {
            return;
        }

        if (playing) {
            audio.pause();
            setPlaying(false);
            return;
        }

        onPlayVideo?.();
        void audio.play();
        setPlaying(true);
    }

    // Exclusivity, direction 2: YouTube starts moving → pause this audio.
    // `playerTime` only jumps while the video is actually playing (paused
    // video reports the same second on consecutive 1 Hz samples).
    useEffect(() => {
        if (playerTime === null || playerTime === undefined) {
            return;
        }

        const last = lastPlayerTimeRef.current;
        lastPlayerTimeRef.current = playerTime;

        if (last !== null && Math.abs(playerTime - last) > PLAYER_MOVE_THRESHOLD_SEC && playing) {
            audioRef.current?.pause();
            setPlaying(false);
        }
    }, [playerTime, playing]);

    if (state === "error") {
        return (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                <p className="font-medium text-destructive">Audio generation failed</p>
                <p className="mt-1 break-words text-destructive/90">{error}</p>
                <Button variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={onPrepareClick}>
                    Retry
                </Button>
            </div>
        );
    }

    if (state === "idle" || state === "preparing") {
        return (
            <Button size="sm" variant="outline" disabled={state === "preparing"} onClick={onPrepareClick}>
                {state === "preparing" ? (
                    <>
                        <Loader2 className="size-4 animate-spin" /> Preparing audio…
                    </>
                ) : (
                    <>Listen{priceLabel ? ` · ${priceLabel}` : ""}</>
                )}
            </Button>
        );
    }

    return (
        <div className="flex items-center gap-3 rounded-2xl border border-border/50 bg-black/20 px-3 py-2">
            <audio
                ref={audioRef}
                src={src ?? undefined}
                preload="none"
                onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
                onEnded={() => setPlaying(false)}
            >
                <track kind="captions" />
            </audio>
            <Button size="sm" variant="ghost" className="size-7 p-0" onClick={togglePlay}>
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <input
                type="range"
                className="yt-audio-range flex-1"
                min={0}
                max={dur || 1}
                step={0.1}
                value={pos}
                onChange={(e) => {
                    const t = Number(e.target.value);

                    if (audioRef.current) {
                        audioRef.current.currentTime = t;
                    }

                    setPos(t);
                }}
            />
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                {formatTimecode(pos)} / {formatTimecode(dur)}
            </span>
            <button
                type="button"
                onClick={() => {
                    const next = (rateIdx + 1) % RATES.length;
                    setRateIdx(next);

                    if (audioRef.current) {
                        audioRef.current.playbackRate = RATES[next];
                    }
                }}
                className="font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
                {RATES[rateIdx]}×
            </button>
        </div>
    );
}
