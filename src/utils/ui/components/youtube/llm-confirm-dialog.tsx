import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { type ReactNode, useState } from "react";

export interface LlmConfirmDialogProps {
    open: boolean;
    title: string;
    description: ReactNode;
    /** Short summary of what will be sent (e.g. "transcript ~35,000 tokens"). */
    payloadSummary: ReactNode;
    /** Default provider shown as placeholder hint only. */
    defaultProvider?: string;
    /** Default model shown as placeholder hint only. */
    defaultModel?: string;
    /** Whether the chosen model is billed via subscription (true) or pay-per-call. */
    subscription?: boolean;
    billingNote?: ReactNode;
    busy?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Last error from the parent's mutation. Shown in a red banner so the user can see what went wrong. */
    error?: string | null;
    onCancel: () => void;
    onConfirm: (overrides: { provider?: string; model?: string }) => void;
}

export function LlmConfirmDialog({
    open,
    title,
    description,
    payloadSummary,
    defaultProvider,
    defaultModel,
    subscription,
    billingNote,
    busy,
    confirmLabel = "Run LLM call",
    cancelLabel = "Cancel",
    error,
    onCancel,
    onConfirm,
}: LlmConfirmDialogProps) {
    const [provider, setProvider] = useState("");
    const [model, setModel] = useState("");

    if (!open) {
        return null;
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 pb-12 pt-[12vh] backdrop-blur-sm"
            data-testid="llm-confirm-dialog"
            onClick={onCancel}
        >
            <Card className="w-full max-w-lg border-primary/40 shadow-2xl" onClick={(event) => event.stopPropagation()}>
                <CardHeader>
                    <CardTitle>{title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">{description}</p>
                    <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">
                        <p className="font-mono text-xs uppercase tracking-wider text-primary">Will send</p>
                        <p className="mt-1">{payloadSummary}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label
                                htmlFor="llm-provider"
                                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                            >
                                Provider
                            </label>
                            <Input
                                id="llm-provider"
                                placeholder={defaultProvider ?? "(server default)"}
                                value={provider}
                                onChange={(event) => setProvider(event.currentTarget.value)}
                            />
                        </div>
                        <div>
                            <label
                                htmlFor="llm-model"
                                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                            >
                                Model
                            </label>
                            <Input
                                id="llm-model"
                                placeholder={defaultModel ?? "(server default)"}
                                value={model}
                                onChange={(event) => setModel(event.currentTarget.value)}
                            />
                        </div>
                    </div>
                    <div className="rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                        <p className="font-semibold">Billing</p>
                        <p className="mt-1">
                            {subscription === true
                                ? "Counted against your subscription / plan quota."
                                : subscription === false
                                  ? "Pay-per-call API spend on your configured provider."
                                  : "Cost depends on your configured provider — check your dashboard."}
                        </p>
                        {billingNote ? <p className="mt-1 text-amber-200/80">{billingNote}</p> : null}
                    </div>
                    {error ? (
                        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                            <p className="font-semibold uppercase tracking-wider">Generation failed</p>
                            <p className="mt-1 break-words text-destructive/90">{error}</p>
                        </div>
                    ) : null}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="ghost" onClick={onCancel} disabled={busy}>
                            {cancelLabel}
                        </Button>
                        <Button
                            onClick={() =>
                                onConfirm({ provider: provider.trim() || undefined, model: model.trim() || undefined })
                            }
                            disabled={busy}
                        >
                            {busy ? "Running…" : confirmLabel}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
