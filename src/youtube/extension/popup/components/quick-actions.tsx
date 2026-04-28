import { Button } from "@app/utils/ui/components/button";

export function QuickActions({
    onOpenDashboard,
    onTranscribe,
    onSummarise,
    disabled,
}: {
    onOpenDashboard: () => void;
    onTranscribe: () => void;
    onSummarise: () => void;
    disabled?: boolean;
}) {
    return (
        <div className="grid gap-2">
            <Button onClick={onOpenDashboard} variant="cyber-secondary">
                Open dashboard
            </Button>
            <div className="grid grid-cols-2 gap-2">
                <Button onClick={onTranscribe} disabled={disabled}>
                    Transcribe
                </Button>
                <Button onClick={onSummarise} disabled={disabled} variant="secondary">
                    Summarise
                </Button>
            </div>
        </div>
    );
}
