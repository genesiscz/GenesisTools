import { int } from "@app/spotify/lib/format";
import { PageHeader, ReportState, Section } from "@app/spotify/ui/components/PageShell";
import { useReport, writeProfile } from "@app/spotify/ui/lib/api";
import { useFilters } from "@app/spotify/ui/lib/filters";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { CheckCircle2, CircleAlert, Settings as SettingsIcon, Star, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
    const { profiles, setFilters } = useFilters();
    const doctor = useReport("doctor", {});
    const qc = useQueryClient();

    const [name, setName] = useState("");
    const [label, setLabel] = useState("");
    const [history, setHistory] = useState("");
    const [data, setData] = useState("");
    const [tz, setTz] = useState("Europe/Prague");
    const [error, setError] = useState<string | null>(null);

    const write = useMutation({
        mutationFn: writeProfile,
        onSuccess: () => {
            setError(null);
            qc.invalidateQueries({ queryKey: ["profiles"] });
            qc.invalidateQueries({ queryKey: ["report"] });
        },
        onError: (err: Error) => setError(err.message),
    });

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim()) {
            return;
        }

        write.mutate(
            {
                name: name.trim(),
                label: label.trim() || undefined,
                history: history.trim() || undefined,
                data: data.trim() || undefined,
                tz: tz.trim() || undefined,
            },
            {
                onSuccess: () => {
                    setName("");
                    setLabel("");
                    setHistory("");
                    setData("");
                },
            }
        );
    };

    /**
     * Clear the header selection only once the removal has actually happened, and only when
     * the removed profile is the one selected. Resetting up front left the header pointing at
     * nothing when the request failed, and cleared an unrelated selection when it succeeded.
     * The patch is a function of the CURRENT filters, not of the ones captured when the request
     * started: the user can change profile from the header while it is in flight.
     */
    const forget = (removed: string) => {
        write.mutate(
            { action: "remove", name: removed },
            {
                onSuccess: () => {
                    setFilters((prev) => ({
                        profile: prev.profile === removed ? "" : prev.profile,
                        partner: prev.partner === removed ? "" : prev.partner,
                    }));
                },
            }
        );
    };

    const rows = profiles.data?.profiles ?? [];

    return (
        <>
            <PageHeader
                title="Profiles and data"
                subtitle={profiles.data?.registryPath}
                icon={<SettingsIcon className="h-5 w-5" />}
            />

            <Section
                title="Where the data lives"
                hint="A profile is two directories: the unzipped Extended Streaming History, and the harvested library. The library is optional — a partner who only handed over a history export still gets every history-based statistic."
            >
                <div className="space-y-3">
                    {rows.map((p) => (
                        <Card key={p.name} variant="wow-static" className="p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-foreground">{p.label || p.name}</span>
                                    <span className="text-xs font-mono text-muted-foreground">{p.name}</span>
                                    {p.isDefault && <Badge variant="cyber">default</Badge>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={p.isDefault || write.isPending}
                                        onClick={() => write.mutate({ action: "use", name: p.name })}
                                    >
                                        <Star className="h-3.5 w-3.5 mr-1" />
                                        Make default
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={write.isPending}
                                        onClick={() => forget(p.name)}
                                    >
                                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                                        Forget
                                    </Button>
                                </div>
                            </div>
                            <PathRow label="history" path={p.historyDir} exists={p.historyExists} />
                            <PathRow label="library" path={p.dataDir} exists={p.dataExists} />
                            <div className="text-xs text-muted-foreground mt-2 font-mono">
                                timezone {p.timezone} · added {p.addedAt.slice(0, 10)}
                            </div>
                        </Card>
                    ))}
                </div>
            </Section>

            <Section
                title="Add or repoint a profile"
                hint="Adding a name that already exists updates it. Fields left blank keep their current value, so you can move just the library directory."
            >
                <Card variant="wow-static" className="p-4">
                    <form onSubmit={submit} className="grid md:grid-cols-2 gap-3">
                        <Field id="name" label="name" value={name} onChange={setName} placeholder="kaja" required />
                        <Field id="label" label="display label" value={label} onChange={setLabel} placeholder="Kája" />
                        <Field
                            id="history"
                            label="streaming-history directory"
                            value={history}
                            onChange={setHistory}
                            placeholder="~/Downloads/kaja-export"
                            className="md:col-span-2"
                        />
                        <Field
                            id="data"
                            label="harvested library directory (optional)"
                            value={data}
                            onChange={setData}
                            placeholder="~/Spotify/data"
                            className="md:col-span-2"
                        />
                        <Field id="tz" label="timezone" value={tz} onChange={setTz} placeholder="Europe/Prague" />
                        <div className="flex items-end">
                            <Button type="submit" variant="brand" disabled={!name.trim() || write.isPending}>
                                {write.isPending ? "Saving…" : "Save profile"}
                            </Button>
                        </div>
                    </form>
                    {error && <p className="text-xs text-destructive mt-3 font-mono whitespace-pre-wrap">{error}</p>}
                </Card>
            </Section>

            <Section title="Data check" hint="What each profile has, and the exact next command for anything missing.">
                <ReportState query={doctor} rows={4}>
                    {(r) => (
                        <div className="space-y-3">
                            {r.profiles.map((p) => (
                                <Card key={p.name} variant="wow-static" className="p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-sm font-semibold">{p.name}</span>
                                        <span className="text-xs text-muted-foreground">({p.label})</span>
                                    </div>
                                    <div className="grid sm:grid-cols-3 gap-2 mb-2">
                                        <Check
                                            label="history"
                                            ok={p.historyOk}
                                            value={p.historyDir ? (p.historyOk ? "ok" : "path missing") : "none"}
                                        />
                                        <Check
                                            label="library"
                                            ok={!!p.libraryPath}
                                            value={p.libraryPath ? `${int(p.libraryTracks)} tracks` : "none"}
                                        />
                                        <Check
                                            label="genres"
                                            ok={p.taggedTracks > 0}
                                            value={
                                                p.taggedTracks
                                                    ? `${int(p.taggedTracks)} tagged (${Math.round((p.taggedTracks * 100) / Math.max(1, p.libraryTracks))}%)`
                                                    : "none"
                                            }
                                        />
                                    </div>
                                    {p.gaps.length === 0 ? (
                                        <div className="text-xs text-muted-foreground">→ complete</div>
                                    ) : (
                                        <ul className="space-y-1">
                                            {p.gaps.map((g) => (
                                                <li key={g} className="text-xs text-muted-foreground font-mono">
                                                    → {g}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </Card>
                            ))}
                        </div>
                    )}
                </ReportState>
            </Section>
        </>
    );
}

function PathRow({ label, path, exists }: { label: string; path: string | undefined; exists: boolean }) {
    return (
        <div className="flex items-baseline gap-2 text-xs">
            <span className="font-mono uppercase tracking-widest text-muted-foreground w-16">{label}</span>
            {path ? (
                <span className={exists ? "font-mono text-foreground" : "font-mono text-destructive"}>
                    {path}
                    {!exists && " (missing)"}
                </span>
            ) : (
                <span className="text-muted-foreground">—</span>
            )}
        </div>
    );
}

function Check({ label, ok, value }: { label: string; ok: boolean; value: string }) {
    return (
        <div className="flex items-center gap-2">
            {ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
            ) : (
                <CircleAlert className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">{label}</span>
            <span className="text-xs text-foreground">{value}</span>
        </div>
    );
}

function Field({
    id,
    label,
    value,
    onChange,
    placeholder,
    required,
    className,
}: {
    id: string;
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    required?: boolean;
    className?: string;
}) {
    return (
        <div className={className}>
            <Label htmlFor={id} className="text-xs text-muted-foreground mb-1 block">
                {label}
            </Label>
            <Input
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                required={required}
                className="h-9 font-mono text-xs"
            />
        </div>
    );
}
