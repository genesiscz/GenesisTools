import { type ReactNode, useState } from "react";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";

export interface LlmConfirmDialogProps {
    open: boolean;
    title: string;
    description: ReactNode;
    /** A short summary of what will be sent (e.g. "transcript ~35,000 tokens"). */
    payloadSummary: ReactNode;
    /** Default provider (e.g. "claude") shown as a placeholder hint only. */
    defaultProvider?: string;
    /** Default model id (e.g. "claude-haiku-4-5") shown as a placeholder hint only. */
    defaultModel?: string;
    /** Whether the chosen model is billed via a subscription (true) or pay-per-call (false/undefined). */
    subscription?: boolean;
    /** Free-form note about cost/billing. */
    billingNote?: ReactNode;
    /**
     * If set, leaving provider+model blank skips the LLM and runs the deterministic path
     * instead. The button label flips to this text and the billing card softens.
     */
    deterministicLabel?: string;
    busy?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
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
    deterministicLabel,
    busy,
    confirmLabel = "Run LLM call",
    cancelLabel = "Cancel",
    onCancel,
    onConfirm,
}: LlmConfirmDialogProps) {
    const [provider, setProvider] = useState("");
    const [model, setModel] = useState("");
    const willUseLlm = provider.trim() !== "" || model.trim() !== "";
    const hasDeterministicFallback = Boolean(deterministicLabel);
    const effectiveLabel = willUseLlm
        ? confirmLabel
        : hasDeterministicFallback
            ? deterministicLabel ?? confirmLabel
            : confirmLabel;

    if (!open) {
        return null;
    }

    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm" data-testid="llm-confirm-dialog">
            <Card className="w-full max-w-lg border-primary/40 shadow-2xl">
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
                            <label htmlFor="llm-provider" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provider</label>
                            <Input id="llm-provider" placeholder={defaultProvider ?? (hasDeterministicFallback ? "blank = deterministic" : "(server default)")} value={provider} onChange={(event) => setProvider(event.currentTarget.value)} />
                        </div>
                        <div>
                            <label htmlFor="llm-model" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Model</label>
                            <Input id="llm-model" placeholder={defaultModel ?? (hasDeterministicFallback ? "blank = deterministic" : "(server default)")} value={model} onChange={(event) => setModel(event.currentTarget.value)} />
                        </div>
                    </div>
                    {hasDeterministicFallback && !willUseLlm ? (
                        <div className="rounded-md border border-emerald-400/35 bg-emerald-500/10 p-3 text-xs text-emerald-100">
                            <p className="font-semibold">Free path selected</p>
                            <p className="mt-1">No provider/model = deterministic bucket-and-pick from the transcript. Zero AI calls, zero cost. Fill the fields above to use an LLM instead.</p>
                        </div>
                    ) : (
                        <div className="rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                            <p className="font-semibold">Billing</p>
                            <p className="mt-1">{subscription === true ? "Counted against your subscription / plan quota." : subscription === false ? "Pay-per-call API spend on your configured provider." : "Cost depends on your configured provider — check your dashboard."}</p>
                            {billingNote ? <p className="mt-1 text-amber-200/80">{billingNote}</p> : null}
                        </div>
                    )}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
                        <Button onClick={() => onConfirm({ provider: provider.trim() || undefined, model: model.trim() || undefined })} disabled={busy}>{busy ? "Running…" : effectiveLabel}</Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
