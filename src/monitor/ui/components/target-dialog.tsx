import { NOTIFY_CHANNELS, type NotifyChannel, type NotifyTarget, type NotifyTargetInput } from "@app/monitor/lib/types";
import { useCreateTarget, useUpdateTarget } from "@app/monitor/ui/api.hooks";
import { CHANNEL_SPECS, type ChannelDraft, ChannelFields } from "@app/monitor/ui/components/channel-fields";
import { Button } from "@genesiscz/utils/ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@genesiscz/utils/ui/components/dialog";
import { Input } from "@genesiscz/utils/ui/components/input";
import { Label } from "@genesiscz/utils/ui/components/label";
import { Switch } from "@genesiscz/utils/ui/components/switch";
import { cn } from "@genesiscz/utils/ui/lib/utils";
import { Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";

interface FormState {
    name: string;
    channel: NotifyChannel;
    config: ChannelDraft;
    enabled: boolean;
}

function emptyForm(): FormState {
    return { name: "", channel: "system", config: {}, enabled: true };
}

function fromTarget(target: NotifyTarget): FormState {
    return { name: target.name, channel: target.channel, config: { ...target.config }, enabled: target.enabled };
}

function toInput(form: FormState): NotifyTargetInput {
    const config: Record<string, string | boolean> = {};

    for (const [key, value] of Object.entries(form.config)) {
        if (typeof value === "boolean" || (typeof value === "string" && value.trim())) {
            config[key] = value;
        }
    }

    return { name: form.name.trim(), channel: form.channel, config, enabled: form.enabled };
}

export function TargetDialog({
    open,
    onOpenChange,
    target,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When set, the dialog edits this target instead of creating one. */
    target?: NotifyTarget | null;
}) {
    const [form, setForm] = useState<FormState>(emptyForm);
    const create = useCreateTarget();
    const update = useUpdateTarget();
    const editing = target ?? null;
    const saving = create.isPending || update.isPending;

    useEffect(() => {
        if (open) {
            setForm(editing ? fromTarget(editing) : emptyForm());
        }
    }, [open, editing]);

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault();
        const input = toInput(form);

        if (editing) {
            // Secrets left blank keep their stored value.
            const merged = { ...editing.config, ...input.config };
            await update.mutateAsync({ id: editing.id, patch: { ...input, config: merged } });
        } else {
            await create.mutateAsync(input);
        }

        onOpenChange(false);
    }

    const canSubmit = form.name.trim().length > 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="mon-panel mon-scroll max-h-[92vh] overflow-y-auto border-primary/30 sm:max-w-xl">
                <form onSubmit={onSubmit} className="space-y-6">
                    <DialogHeader>
                        <DialogTitle className="gradient-text text-2xl">
                            {editing ? `Edit ${editing.name}` : "New notification target"}
                        </DialogTitle>
                        <DialogDescription>
                            A named destination watchers can subscribe to: a webhook URL, a voice, a banner style, a
                            Telegram chat. Make as many as you like.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2 sm:grid-cols-4">
                        {NOTIFY_CHANNELS.map((channel) => {
                            const spec = CHANNEL_SPECS[channel];
                            const Icon = spec.icon;
                            const active = form.channel === channel;

                            return (
                                <button
                                    key={channel}
                                    type="button"
                                    disabled={editing !== null}
                                    onClick={() => setForm((current) => ({ ...current, channel, config: {} }))}
                                    className={cn(
                                        "flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center text-xs font-semibold transition disabled:cursor-not-allowed",
                                        active
                                            ? "border-primary/60 bg-primary/15 text-primary shadow-[0_0_24px_rgba(245,158,11,0.15)]"
                                            : "border-border/60 bg-card/40 text-muted-foreground hover:border-primary/30 hover:text-foreground disabled:opacity-40"
                                    )}
                                >
                                    <Icon className="size-4" />
                                    {spec.title.replace(/ \(.*\)$/, "")}
                                </button>
                            );
                        })}
                    </div>

                    <div className="space-y-1.5">
                        <Label className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
                            Name
                        </Label>
                        <Input
                            value={form.name}
                            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                            placeholder={
                                form.channel === "webhook"
                                    ? "Slack #ops"
                                    : form.channel === "say"
                                      ? "Samantha, office"
                                      : form.channel === "telegram"
                                        ? "Family chat"
                                        : "Loud banner"
                            }
                            autoFocus
                        />
                    </div>

                    <ChannelFields
                        channel={form.channel}
                        draft={form.config}
                        enabled={open}
                        secretsSet={
                            editing?.channel === "telegram" && typeof editing.config.botToken === "string"
                                ? { botToken: true }
                                : {}
                        }
                        onChange={(key, value) =>
                            setForm((current) => ({ ...current, config: { ...current.config, [key]: value } }))
                        }
                    />

                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={form.enabled}
                            onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: checked }))}
                        />
                        Enabled
                    </label>

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!canSubmit || saving} className="btn-glow">
                            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                            {editing ? "Save changes" : "Add to library"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
