import { cn } from "@ui/lib/utils";
import { Mic, MicOff } from "lucide-react";

interface VideoParticipantProps {
    name: string;
    /** Short initial(s) shown as avatar placeholder (e.g. "SS") */
    initial: string;
    isMuted?: boolean;
    isSpeaking?: boolean;
    isYou?: boolean;
    className?: string;
}

export function VideoParticipant({
    name,
    initial,
    isMuted = false,
    isSpeaking = false,
    isYou = false,
    className,
}: VideoParticipantProps) {
    return (
        <div className={cn("video-participant", className)}>
            {isSpeaking && (
                <div className="absolute top-2 left-2 flex items-center gap-1.5 z-10">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-timer-pulse" />
                    <span className="text-[10px] text-emerald-500 font-medium">Speaking</span>
                </div>
            )}

            <div className="absolute top-2 right-2 z-10">
                {isMuted ? (
                    <div className="w-6 h-6 rounded-full bg-red-500/20 flex items-center justify-center">
                        <MicOff size={12} className="text-red-400" />
                    </div>
                ) : (
                    <div className="w-6 h-6 rounded-full bg-[#1a1a22]/80 flex items-center justify-center">
                        <Mic size={12} className="text-muted-foreground" />
                    </div>
                )}
            </div>

            <div className="participant-avatar">
                <span className={isYou ? "text-violet-400" : ""}>{initial}</span>
            </div>

            <div className="absolute bottom-2 left-2 z-10">
                <span className="text-[11px] text-white/80 bg-black/50 px-2 py-0.5 rounded-md backdrop-blur-sm">
                    {name}
                    {isYou && <span className="text-violet-400"> (You)</span>}
                </span>
            </div>
        </div>
    );
}
