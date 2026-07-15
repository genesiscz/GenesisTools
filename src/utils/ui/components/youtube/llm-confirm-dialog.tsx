import { Button } from "@app/utils/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@app/utils/ui/components/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import type { LlmEstimate } from "@app/youtube/lib/types";
import { AlertTriangle } from "lucide-react";
import { type ReactNode, useState } from "react";

export interface ModelPreset {
    label: string;
    provider: string;
    model: string;
    subscription?: boolean;
}

const DEV_MODEL_DEFAULT = "__server_default__";

function formatTokens(count: number): string {
    if (count >= 1000) {
        return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k`;
    }

    return String(count);
}

function formatUsd(usd: number): string {
    if (usd >= 0.995) {
        return `$${usd.toFixed(2)}`;
    }

    if (usd >= 0.01) {
        return `$${usd.toFixed(3)}`;
    }

    return "< $0.01";
}

export interface LlmConfirmDialogProps {
    open: boolean;
    title: string;
    description: ReactNode;
    payloadSummary: ReactNode;
    defaultProvider?: string;
    defaultModel?: string;
    subscription?: boolean;
    billingNote?: ReactNode;
    busy?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    error?: string | null;
    /** Dev mode: expose provider/model override select. Regular users don't
     *  see it — server picks its configured default. */
    showAdvanced?: boolean;
    /** Model presets fetched from the server (`/api/v1/models`). Empty =
     *  server-default only. Extension side-panel provides via `useModels`. */
    modelPresets?: ModelPreset[];
    /** Server-computed pre-flight cost estimate (`/videos/:id/estimate`).
     *  Absent → generic billing copy. */
    estimate?: LlmEstimate | null;
    estimatePending?: boolean;
    /** Fired when the dev model select changes, so the owner can re-fetch
     *  the estimate for the chosen provider/model. `{}` = server default. */
    onSelectionChange?: (sel: { provider?: string; model?: string }) => void;
    /** Live job progress while `busy` — shown under the payload box. */
    progress?: { progress: number; message: string | null } | null;
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
    confirmLabel = "Run",
    cancelLabel = "Cancel",
    error,
    showAdvanced,
    modelPresets = [],
    estimate,
    estimatePending,
    onSelectionChange,
    progress,
    onCancel,
    onConfirm,
}: LlmConfirmDialogProps) {
    const [preset, setPreset] = useState(DEV_MODEL_DEFAULT);

    function selectPreset(value: string) {
        setPreset(value);
        const chosen = modelPresets.find((p) => p.label === value);
        onSelectionChange?.(chosen ? { provider: chosen.provider, model: chosen.model } : {});
    }

    const fallbackBilling =
        subscription === true
            ? "Counted against your subscription quota."
            : subscription === false
              ? "Pay-per-call API spend on your configured provider."
              : "Cost depends on your configured provider.";

    let billing: ReactNode = fallbackBilling;

    if (estimatePending) {
        billing = "Estimating cost…";
    } else if (estimate && estimate.inputTokens !== null) {
        const tokens = `~${formatTokens(estimate.inputTokens)} in / ~${formatTokens(estimate.outputTokens)} out tokens`;
        const source = estimate.basis === "duration" ? " (estimated from video length — no transcript yet)" : "";
        // For subscription-billed models the diamond price is the number the
        // user actually pays — lead with it.
        const diamonds = estimate.creditCost != null ? `${estimate.creditCost} 💎 · ` : "";
        billing = estimate.subscription ? (
            <>
                {diamonds}Subscription quota · {tokens} · {estimate.provider}/{estimate.model}
                {source}
            </>
        ) : estimate.estUsd !== null ? (
            <>
                {diamonds}≈ {formatUsd(estimate.estUsd)} · {tokens} · {estimate.provider}/{estimate.model}
                {source}
            </>
        ) : (
            <>
                {diamonds}
                {tokens} · {estimate.provider}/{estimate.model} (no price data){source}
            </>
        );
    }

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
            <DialogContent
                showCloseButton={false}
                data-testid="llm-confirm-dialog"
                className="max-w-md bg-card border-white/10"
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <DialogHeader>
                    <DialogTitle className="text-lg">{title}</DialogTitle>
                    <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
                        {description}
                    </DialogDescription>
                </DialogHeader>

                <div className="rounded-lg border border-white/8 bg-black/20 p-3 text-sm">
                    <p className="mb-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">Will send</p>
                    <p className="text-foreground/90">{payloadSummary}</p>
                </div>

                {showAdvanced ? (
                    <div className="space-y-1">
                        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            Model · dev
                        </label>
                        <Select value={preset} onValueChange={selectPreset}>
                            <SelectTrigger className="h-8 w-full text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={DEV_MODEL_DEFAULT}>
                                    server default
                                    {defaultProvider ? ` (${defaultProvider}/${defaultModel ?? "?"})` : ""}
                                </SelectItem>
                                {modelPresets.map((p) => (
                                    <SelectItem key={p.label} value={p.label}>
                                        {p.label}
                                        {p.subscription ? " · sub" : ""}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                ) : null}

                <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5 text-sm leading-relaxed text-amber-100/90">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400/80" strokeWidth={2} />
                    <div>
                        <span className="text-amber-200">{billing}</span>
                        {billingNote && !(estimate && estimate.inputTokens !== null) ? (
                            <span className="text-amber-100/70"> {billingNote}</span>
                        ) : null}
                    </div>
                </div>

                {busy && progress ? (
                    <div className="space-y-1.5">
                        <div className="h-1 overflow-hidden rounded-full bg-white/8">
                            <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300"
                                style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.progress)) * 100)}%` }}
                            />
                        </div>
                        <p className="text-xs tabular-nums text-muted-foreground">
                            {Math.round(progress.progress * 100)}%{progress.message ? ` · ${progress.message}` : ""}
                        </p>
                    </div>
                ) : null}

                {error ? (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                        <p className="font-medium text-destructive">Generation failed</p>
                        <p className="mt-1 break-words text-destructive/80">{error}</p>
                    </div>
                ) : null}

                <div className="flex items-center justify-end gap-2 pt-2">
                    <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                        {cancelLabel}
                    </Button>
                    <Button
                        size="sm"
                        onClick={() => {
                            const chosen = modelPresets.find((p) => p.label === preset);
                            onConfirm(chosen ? { provider: chosen.provider, model: chosen.model } : {});
                        }}
                        disabled={busy}
                    >
                        {busy ? "Running…" : confirmLabel}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
