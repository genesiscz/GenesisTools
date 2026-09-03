import type { NotifyChannel } from "@app/monitor/lib/types";
import { useSayVoices } from "@app/monitor/ui/api.hooks";
import { Input } from "@genesiscz/utils/ui/components/input";
import { Label } from "@genesiscz/utils/ui/components/label";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@genesiscz/utils/ui/components/select";
import { Switch } from "@genesiscz/utils/ui/components/switch";
import { MonitorSmartphone, Send, Volume2, Webhook } from "lucide-react";

export type ChannelDraft = Record<string, string | boolean>;

export interface ChannelFieldSpec {
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    hint?: string;
}

export const CHANNEL_SPECS: Record<
    NotifyChannel,
    {
        title: string;
        blurb: string;
        icon: typeof MonitorSmartphone;
        fields: ChannelFieldSpec[];
        booleans: ChannelFieldSpec[];
    }
> = {
    system: {
        title: "macOS notification",
        blurb: "Notification Center banner via terminal-notifier. Same channel `tools notify` uses.",
        icon: MonitorSmartphone,
        fields: [
            { key: "title", label: "Title", placeholder: "GenesisTools" },
            { key: "sound", label: "Sound", placeholder: "Ping", hint: "Any name from System Settings › Sound" },
        ],
        booleans: [{ key: "ignoreDnD", label: "Bypass Do Not Disturb" }],
    },
    say: {
        title: "Spoken (tools say)",
        blurb: "Reads the message aloud through `tools say`. Pick any voice a configured provider offers.",
        icon: Volume2,
        fields: [{ key: "voice", label: "Voice" }],
        booleans: [],
    },
    telegram: {
        title: "Telegram",
        blurb: "Bot message to a chat. The token is stored in config and never shown again here.",
        icon: Send,
        fields: [
            { key: "botToken", label: "Bot token", placeholder: "123456:ABC…", secret: true },
            { key: "chatId", label: "Chat id", placeholder: "-1001234567890" },
        ],
        booleans: [],
    },
    webhook: {
        title: "Webhook",
        blurb: "POSTs the event as JSON to a URL (Slack, Discord, n8n, anything).",
        icon: Webhook,
        fields: [{ key: "url", label: "URL", placeholder: "https://hooks.example.com/…" }],
        booleans: [],
    },
};

const FIELD_LABEL = "font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground";
const CUSTOM_PREFIX = "custom::";

/**
 * Grouped voice picker fed by `tools say voices`: one group per provider that
 * is available right now (macOS always, xAI/OpenAI once a key exists).
 * Selecting a voice also sets `provider`, so `tools say --provider` matches.
 */
export function SayVoicePicker({
    voice,
    provider,
    onChange,
    enabled = true,
}: {
    voice: string;
    provider: string;
    onChange: (next: { voice: string; provider: string }) => void;
    enabled?: boolean;
}) {
    const voices = useSayVoices(enabled);
    const providers = voices.data ?? [];
    // The group that actually lists the voice wins over a stale stored provider,
    // otherwise the trigger shows the placeholder for a perfectly valid voice.
    const owner =
        providers.find((group) => group.id === provider && group.voices.some((entry) => entry.id === voice)) ??
        providers.find((group) => group.voices.some((entry) => entry.id === voice));
    const value = voice ? (owner ? `${owner.id}::${voice}` : `${CUSTOM_PREFIX}${voice}`) : "";
    const known = owner !== undefined;

    return (
        <div className="space-y-1.5 sm:col-span-2">
            <Label className={FIELD_LABEL}>Voice</Label>
            <Select
                value={value}
                onValueChange={(next) => {
                    if (next.startsWith(CUSTOM_PREFIX)) {
                        return;
                    }

                    const [nextProvider, ...rest] = next.split("::");
                    onChange({ voice: rest.join("::"), provider: nextProvider });
                }}
            >
                <SelectTrigger>
                    <SelectValue
                        placeholder={
                            voices.isPending
                                ? "Loading voices…"
                                : voices.isError
                                  ? "Voices unavailable"
                                  : "Choose a voice"
                        }
                    />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                    {!known && voice && (
                        <SelectGroup>
                            <SelectLabel>Current</SelectLabel>
                            <SelectItem value={`${CUSTOM_PREFIX}${voice}`}>
                                {voice}
                                {provider ? ` · ${provider}` : ""}
                            </SelectItem>
                        </SelectGroup>
                    )}
                    {providers.map((group) => (
                        <SelectGroup key={group.id}>
                            <SelectLabel>
                                {group.label} · {group.voices.length}
                            </SelectLabel>
                            {group.voices.map((entry) => (
                                <SelectItem key={`${group.id}::${entry.id}`} value={`${group.id}::${entry.id}`}>
                                    {entry.name}
                                    {entry.locale ? ` · ${entry.locale}` : ""}
                                    {entry.id !== entry.name ? ` (${entry.id})` : ""}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    ))}
                </SelectContent>
            </Select>
            <p className="text-[0.7rem] text-muted-foreground/80">
                {providers.length > 0
                    ? `Providers available now: ${providers.map((group) => group.label).join(", ")}. Add an xAI or OpenAI account to unlock more.`
                    : "Voices come from `tools say voices`."}
            </p>
        </div>
    );
}

/** The editable fields of one channel; shared by the app-default cards and the library dialog. */
export function ChannelFields({
    channel,
    draft,
    onChange,
    secretsSet = {},
    enabled = true,
}: {
    channel: NotifyChannel;
    draft: ChannelDraft;
    onChange: (key: string, value: string | boolean) => void;
    /** Keys whose secret value exists server-side (rendered as a placeholder). */
    secretsSet?: Record<string, boolean>;
    enabled?: boolean;
}) {
    const spec = CHANNEL_SPECS[channel];

    return (
        <div className="grid gap-4 sm:grid-cols-2">
            {channel === "say" ? (
                <SayVoicePicker
                    voice={typeof draft.voice === "string" ? draft.voice : ""}
                    provider={typeof draft.provider === "string" ? draft.provider : ""}
                    enabled={enabled}
                    onChange={(next) => {
                        onChange("voice", next.voice);
                        onChange("provider", next.provider);
                    }}
                />
            ) : (
                spec.fields.map((field) => (
                    <div key={field.key} className="space-y-1.5">
                        <Label className={FIELD_LABEL}>{field.label}</Label>
                        <Input
                            type={field.secret ? "password" : "text"}
                            value={typeof draft[field.key] === "string" ? (draft[field.key] as string) : ""}
                            onChange={(event) => onChange(field.key, event.target.value)}
                            placeholder={secretsSet[field.key] ? "•••••••• (saved)" : field.placeholder}
                        />
                        {field.hint && <p className="text-[0.7rem] text-muted-foreground/80">{field.hint}</p>}
                    </div>
                ))
            )}
            {spec.booleans.map((field) => (
                <label key={field.key} className="flex items-center gap-2 self-end pb-2 text-sm">
                    <Switch
                        checked={draft[field.key] === true}
                        onCheckedChange={(checked) => onChange(field.key, checked)}
                    />
                    {field.label}
                </label>
            ))}
        </div>
    );
}
