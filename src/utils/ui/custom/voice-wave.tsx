import { cn } from "@ui/lib/utils";

const BARS = [0.3, 0.8, 0.5, 1, 0.6, 0.9, 0.4];

interface VoiceWaveProps {
    className?: string;
}

export function VoiceWave({ className }: VoiceWaveProps) {
    return (
        <div
            className={cn(
                "flex items-center justify-center gap-1 px-5 py-3 rounded-full bg-black/40 backdrop-blur-sm border border-border/50",
                className
            )}
        >
            {BARS.map((scale, i) => (
                <div
                    key={i}
                    className="w-1 h-6 rounded-full bg-gradient-to-t from-violet-400 to-primary"
                    style={{
                        animation: `voiceBar ${0.8 + i * 0.15}s ease-in-out ${i * 0.1}s infinite`,
                        transform: `scaleY(${scale})`,
                    }}
                />
            ))}
        </div>
    );
}
