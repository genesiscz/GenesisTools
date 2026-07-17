import { Button } from "@app/utils/ui/components/button";

export function QuickActions({
    onOpenDashboard,
    onTranscribe,
    onSummarise,
    disabled,
    videoAvailable,
}: {
    onOpenDashboard: () => void;
    onTranscribe: () => void;
    onSummarise: () => void;
    disabled?: boolean;
    videoAvailable: boolean;
}) {
    return (
        <div className="grid gap-2">
            <Button onClick={onOpenDashboard} variant="cyber-secondary">
                Open dashboard
            </Button>
            <div className="grid grid-cols-2 gap-2">
                <Button onClick={onTranscribe} disabled={disabled || !videoAvailable}>
                    Transcribe
                </Button>
                <Button onClick={onSummarise} disabled={disabled || !videoAvailable} variant="secondary">
                    Summarise
                </Button>
            </div>
            {videoAvailable ? null : (
                <p className="text-xs text-muted-foreground">Open a YouTube video to transcribe or summarise it.</p>
            )}
        </div>
    );
}
