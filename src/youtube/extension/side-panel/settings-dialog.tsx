import { logger } from "@app/logger/client";
import { SafeJSON } from "@app/utils/json";
import { Button } from "@app/utils/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@app/utils/ui/components/dialog";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { OUTPUT_LANGS } from "@app/utils/ui/components/youtube/output-langs";
import { formatRelativeTime } from "@app/utils/ui/components/youtube/time";
import { DIAMOND_PACKS } from "@app/youtube/lib/billing.types";
import type { PresetKind, PromptPreset, ShareSummary } from "@app/youtube/lib/types";
import {
    useCheckout,
    useCreatePreset,
    useDeletePreset,
    useListPresets,
    useLogin,
    useLogout,
    useMe,
    usePatchMe,
    useRegister,
    useRevokeShare,
    useShares,
    useTopup,
    useUpdatePreset,
    useUsageSummary,
} from "@ext/api.hooks";
import { persistUiLang, useT, useUiLang } from "@ext/shared/i18n";
import type { AccountSection } from "@ext/side-panel/account-view";
import { CreditCard, Gem, History, Loader2, LogOut, Pencil, Share2, Trash2, Wand2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

type AuthMode = "login" | "register";

export function SettingsDialog({
    open,
    onOpenChange,
    devMode,
    onOpenAccount,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    devMode?: boolean;
    onOpenAccount?: (section: AccountSection) => void;
}) {
    const me = useMe(open);
    const user = me.data?.user;
    const t = useT();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm bg-card border-white/10" onOpenAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle className="text-lg">{t("settings.title")}</DialogTitle>
                    <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
                        {user
                            ? "Diamonds pay for summaries and questions."
                            : "Sign in to spend diamonds on summaries and questions. New accounts start with 100."}
                    </DialogDescription>
                </DialogHeader>
                {me.isPending && open ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                    </div>
                ) : user ? (
                    <SignedInView
                        email={user.email}
                        credits={user.credits}
                        outputLang={user.outputLang}
                        devMode={devMode}
                        onOpenAccount={onOpenAccount}
                    />
                ) : (
                    <AuthForm />
                )}
            </DialogContent>
        </Dialog>
    );
}

function SignedInView({
    email,
    credits,
    outputLang,
    devMode,
    onOpenAccount,
}: {
    email: string;
    credits: number;
    outputLang: string | null;
    devMode?: boolean;
    onOpenAccount?: (section: AccountSection) => void;
}) {
    const logout = useLogout();
    const t = useT();

    return (
        <div className="space-y-3">
            <div className="rounded-lg border border-white/8 bg-black/20 p-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {t("settings.signedInAs")}
                </p>
                <p className="mt-1 break-all text-sm text-foreground/95">{email}</p>
                <div className="mt-3 flex items-baseline gap-1.5">
                    <span className="text-xl leading-none" aria-hidden>
                        💎
                    </span>
                    <span className="text-2xl font-semibold tabular-nums leading-none text-foreground">{credits}</span>
                    <span className="text-xs text-muted-foreground">diamonds</span>
                </div>
            </div>

            <DiamondPacksSection devMode={devMode} />

            {onOpenAccount ? <ActivitySparkline onViewAll={() => onOpenAccount("activity")} /> : null}

            {onOpenAccount ? <LibraryNav onOpen={onOpenAccount} /> : null}

            <LanguageSection outputLang={outputLang} />

            <SharesSection />

            <PresetsSection />

            <Button
                size="sm"
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
            >
                <LogOut className="size-4" /> {t("action.logOut")}
            </Button>
        </div>
    );
}

function LibraryNav({ onOpen }: { onOpen: (section: AccountSection) => void }) {
    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">your library</p>
            <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start text-muted-foreground"
                onClick={() => onOpen("history")}
            >
                <History className="size-4" /> History
            </Button>
        </div>
    );
}

function LanguageSection({ outputLang }: { outputLang: string | null }) {
    const t = useT();
    const uiLang = useUiLang();
    const patchMe = usePatchMe();

    return (
        <div className="space-y-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {t("settings.language")}
            </p>
            <div className="space-y-1">
                <label htmlFor="settings-output-lang" className="text-xs font-medium text-muted-foreground">
                    {t("settings.outputLanguage")}
                </label>
                <Select value={outputLang ?? "en"} onValueChange={(value) => patchMe.mutate({ outputLang: value })}>
                    <SelectTrigger id="settings-output-lang" className="h-8 w-full text-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {OUTPUT_LANGS.map((lang) => (
                            <SelectItem key={lang.code} value={lang.code}>
                                <span className="font-mono text-[12px] uppercase">{lang.code}</span> {lang.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="space-y-1">
                <label htmlFor="settings-panel-lang" className="text-xs font-medium text-muted-foreground">
                    {t("settings.panelLanguage")}
                </label>
                <Select value={uiLang} onValueChange={(value) => void persistUiLang(value)}>
                    <SelectTrigger id="settings-panel-lang" className="h-8 w-full text-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="cs">Čeština</SelectItem>
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
}

function ActivitySparkline({ onViewAll }: { onViewAll: () => void }) {
    const summary = useUsageSummary();
    const days = summary.data?.days ?? [];
    const maxSpent = Math.max(1, ...days.map((d) => d.spent));

    if (summary.isPending) {
        return (
            <div className="space-y-2">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    activity · last 30 days
                </p>
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                activity · last 30 days
            </p>
            <div className="flex h-12 items-end gap-[2px]">
                {days.map((day, i) => (
                    <div
                        key={day.date}
                        title={`${day.date} · ${day.spent} 💎`}
                        className={`flex-1 rounded-sm ${
                            day.spent === 0 ? "bg-white/5" : i === days.length - 1 ? "bg-primary/70" : "bg-primary/30"
                        }`}
                        style={{ height: `${Math.max(8, (day.spent / maxSpent) * 100)}%` }}
                    />
                ))}
            </div>
            <p className="text-sm text-muted-foreground">
                This month:{" "}
                <span className="font-semibold tabular-nums text-foreground">{summary.data?.month.spent ?? 0} 💎</span>{" "}
                spent · +{summary.data?.month.earned ?? 0} topped up
            </p>
            <Button size="sm" variant="ghost" className="w-full text-muted-foreground" onClick={onViewAll}>
                View all activity →
            </Button>
        </div>
    );
}

function DiamondPacksSection({ devMode }: { devMode?: boolean }) {
    const checkout = useCheckout();
    const topup = useTopup();
    const t = useT();
    const [pendingPack, setPendingPack] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function buy(packId: string) {
        if (pendingPack) {
            return;
        }

        setError(null);
        setPendingPack(packId);
        try {
            await checkout.mutateAsync({ packId });
        } catch (error) {
            logger.warn({ error }, "settings-dialog: checkout failed");
            setError(error instanceof Error ? error.message : String(error));
        } finally {
            setPendingPack(null);
        }
    }

    const unconfigured = error?.includes("not configured");

    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {t("settings.getDiamonds")}
            </p>
            {unconfigured ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <CreditCard className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">Payments aren't configured on this server yet.</p>
                </div>
            ) : (
                <div className="grid grid-cols-3 gap-2">
                    {DIAMOND_PACKS.map((pack) => (
                        <button
                            key={pack.id}
                            type="button"
                            disabled={pendingPack !== null}
                            onClick={() => void buy(pack.id)}
                            className="rounded-2xl border border-white/8 bg-black/20 p-3 text-left transition-colors hover:border-primary/40 disabled:opacity-60"
                        >
                            <p className="text-base font-semibold tabular-nums text-foreground">
                                {pack.diamonds.toLocaleString("en-US").replace(",", " ")} 💎
                            </p>
                            {pendingPack === pack.id ? (
                                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                                    <Loader2 className="size-3.5 animate-spin" /> Opening…
                                </p>
                            ) : (
                                <p className="mt-0.5 text-sm text-muted-foreground">${pack.usd}</p>
                            )}
                            {pack.id === "pack-medium" ? (
                                <span className="mt-1.5 inline-flex rounded-full border border-primary/25 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
                                    popular
                                </span>
                            ) : null}
                        </button>
                    ))}
                </div>
            )}
            {error && !unconfigured ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}
            {devMode ? (
                <Button
                    size="sm"
                    variant="ghost"
                    className="w-full text-muted-foreground"
                    onClick={() => topup.mutate({ amount: 100 })}
                >
                    <Gem className="size-4" /> Fill diamonds +100 (dev)
                </Button>
            ) : null}
        </div>
    );
}

function SharesSection() {
    const shares = useShares();
    const revoke = useRevokeShare();
    const t = useT();
    const [confirmingSlug, setConfirmingSlug] = useState<string | null>(null);
    const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (confirmTimerRef.current !== null) {
                clearTimeout(confirmTimerRef.current);
            }
        };
    }, []);

    function armConfirm(slug: string) {
        if (confirmTimerRef.current !== null) {
            clearTimeout(confirmTimerRef.current);
        }

        setConfirmingSlug(slug);
        confirmTimerRef.current = setTimeout(() => {
            setConfirmingSlug((current) => (current === slug ? null : current));
            confirmTimerRef.current = null;
        }, 3000);
    }

    // Revoked shares are functionally gone — this list manages the active set.
    const rows = (shares.data ?? []).filter((share: ShareSummary) => share.revokedAt === null);

    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {t("settings.shares")}
            </p>
            {shares.isPending ? (
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                </div>
            ) : rows.length === 0 ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <Share2 className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">{t("settings.noShares")}</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {rows.map((share) => (
                        <div key={share.slug} className="rounded-2xl border border-white/8 bg-black/20 p-3">
                            <div className="flex items-center gap-2">
                                <span className="inline-flex h-5 items-center rounded-full border border-white/8 px-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                                    {share.kind}
                                </span>
                                <p className="min-w-0 flex-1 truncate text-sm text-foreground/95">{share.videoTitle}</p>
                                <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
                                    {formatRelativeTime(share.createdAt)}
                                </span>
                            </div>
                            <div className="mt-2 flex items-center justify-end gap-1.5">
                                {confirmingSlug === share.slug ? (
                                    <Button
                                        size="sm"
                                        variant="destructive"
                                        onClick={() => revoke.mutate({ slug: share.slug })}
                                    >
                                        {t("action.reallyRevoke")}
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-muted-foreground"
                                        onClick={() => armConfirm(share.slug)}
                                    >
                                        {t("action.revoke")}
                                    </Button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

interface ImportedPreset {
    name: string;
    kind: PresetKind;
    instructions: string;
}

function isImportedPreset(value: unknown): value is ImportedPreset {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;

    return (
        typeof candidate.name === "string" &&
        typeof candidate.instructions === "string" &&
        (candidate.kind === "summary" || candidate.kind === "insights" || candidate.kind === "ask")
    );
}

function PresetsSection() {
    const presets = useListPresets();
    const createPreset = useCreatePreset();
    const updatePreset = useUpdatePreset();
    const deletePreset = useDeletePreset();
    const t = useT();
    const [confirmingId, setConfirmingId] = useState<number | null>(null);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editName, setEditName] = useState("");
    const [editInstructions, setEditInstructions] = useState("");
    const [editError, setEditError] = useState<string | null>(null);
    const [importResult, setImportResult] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const rows = presets.data ?? [];

    useEffect(() => {
        return () => {
            if (confirmTimerRef.current !== null) {
                clearTimeout(confirmTimerRef.current);
            }
        };
    }, []);

    function armConfirm(id: number) {
        if (confirmTimerRef.current !== null) {
            clearTimeout(confirmTimerRef.current);
        }

        setConfirmingId(id);
        confirmTimerRef.current = setTimeout(() => {
            setConfirmingId((current) => (current === id ? null : current));
            confirmTimerRef.current = null;
        }, 3000);
    }

    function startEdit(preset: PromptPreset) {
        setEditingId(preset.id);
        setEditName(preset.name);
        setEditInstructions(preset.instructions);
        setEditError(null);
    }

    async function saveEdit() {
        if (editingId === null) {
            return;
        }

        setEditError(null);
        try {
            await updatePreset.mutateAsync({
                id: editingId,
                name: editName.trim(),
                instructions: editInstructions.trim(),
            });
            setEditingId(null);
        } catch (error) {
            logger.warn({ error }, "settings-dialog: preset edit save failed");
            setEditError(error instanceof Error ? error.message : String(error));
        }
    }

    function exportJson() {
        const payload: ImportedPreset[] = rows.map((preset) => ({
            name: preset.name,
            kind: preset.kind,
            instructions: preset.instructions,
        }));
        const blob = new Blob([SafeJSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "youtube-presets.json";
        anchor.click();
        URL.revokeObjectURL(url);
    }

    async function importJson(file: File) {
        setImportResult(null);
        try {
            const text = await file.text();
            const parsed: unknown = SafeJSON.parse(text);

            if (!Array.isArray(parsed)) {
                throw new Error("invalid file");
            }

            const existingKeys = new Set(rows.map((preset) => `${preset.kind}:${preset.name}`));
            let imported = 0;
            let skipped = 0;

            for (const item of parsed) {
                if (!isImportedPreset(item) || existingKeys.has(`${item.kind}:${item.name}`)) {
                    skipped += 1;
                    continue;
                }

                try {
                    await createPreset.mutateAsync(item);
                    existingKeys.add(`${item.kind}:${item.name}`);
                    imported += 1;
                } catch (error) {
                    logger.warn({ error }, "settings-dialog: preset import item failed");
                    skipped += 1;
                }
            }

            setImportResult(`${imported} imported, ${skipped} skipped`);
        } catch (error) {
            logger.warn({ error }, "settings-dialog: preset import failed");
            setImportResult("Import failed — invalid file");
        }
    }

    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {t("settings.presets")}
            </p>
            {presets.isPending ? (
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                </div>
            ) : rows.length === 0 ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <Wand2 className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">{t("settings.noPresets")}</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {rows.map((preset) =>
                        editingId === preset.id ? (
                            <div
                                key={preset.id}
                                className="space-y-2 rounded-2xl border border-white/8 bg-black/20 p-3"
                            >
                                <div className="space-y-1">
                                    <label
                                        htmlFor={`preset-edit-name-${preset.id}`}
                                        className="text-xs font-medium text-muted-foreground"
                                    >
                                        Name
                                    </label>
                                    <Input
                                        id={`preset-edit-name-${preset.id}`}
                                        value={editName}
                                        onChange={(e) => setEditName(e.target.value)}
                                        className="h-9 text-sm"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label
                                        htmlFor={`preset-edit-instructions-${preset.id}`}
                                        className="text-xs font-medium text-muted-foreground"
                                    >
                                        Instructions
                                    </label>
                                    <textarea
                                        id={`preset-edit-instructions-${preset.id}`}
                                        value={editInstructions}
                                        onChange={(e) => setEditInstructions(e.target.value)}
                                        className="min-h-20 w-full resize-y rounded-lg border border-white/8 bg-black/20 p-2.5 text-sm leading-relaxed text-foreground focus:border-primary/40 focus:outline-none"
                                    />
                                </div>
                                {editError ? (
                                    <p className="break-words text-sm text-destructive/90">{editError}</p>
                                ) : null}
                                <div className="flex justify-end gap-1.5">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-muted-foreground"
                                        onClick={() => {
                                            setEditingId(null);
                                            setEditError(null);
                                        }}
                                    >
                                        {t("action.cancel")}
                                    </Button>
                                    <Button size="sm" disabled={updatePreset.isPending} onClick={() => void saveEdit()}>
                                        {t("action.save")}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div key={preset.id} className="rounded-2xl border border-white/8 bg-black/20 p-3">
                                <div className="flex items-center gap-2">
                                    <span className="inline-flex h-5 items-center rounded-full border border-white/8 px-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                                        {preset.kind}
                                    </span>
                                    <p className="text-sm font-semibold text-foreground/95">{preset.name}</p>
                                </div>
                                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{preset.instructions}</p>
                                <div className="mt-2 flex items-center justify-end gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => startEdit(preset)}
                                        aria-label={`Edit ${preset.name}`}
                                        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                                    >
                                        <Pencil className="size-4" />
                                    </button>
                                    {confirmingId === preset.id ? (
                                        <Button
                                            size="sm"
                                            variant="destructive"
                                            onClick={() => deletePreset.mutate({ id: preset.id })}
                                        >
                                            {t("action.reallyDelete")}
                                        </Button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => armConfirm(preset.id)}
                                            aria-label={`Delete ${preset.name}`}
                                            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        )
                    )}
                </div>
            )}
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={exportJson}
                    disabled={rows.length === 0}
                >
                    {t("action.exportJson")}
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => fileInputRef.current?.click()}
                >
                    {t("action.importJson")}
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];

                        if (file) {
                            void importJson(file);
                        }

                        e.target.value = "";
                    }}
                />
            </div>
            {importResult ? <p className="text-sm text-muted-foreground">{importResult}</p> : null}
        </div>
    );
}

function AuthForm() {
    const [mode, setMode] = useState<AuthMode>("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const login = useLogin();
    const register = useRegister();
    const t = useT();
    const busy = login.isPending || register.isPending;

    function switchMode(next: AuthMode) {
        setMode(next);
        setError(null);
    }

    async function submit(event: FormEvent) {
        event.preventDefault();

        if (busy) {
            return;
        }

        setError(null);
        try {
            const action = mode === "login" ? login : register;
            await action.mutateAsync({ email, password });
            setPassword("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    const toggleBase = "h-7 flex-1 rounded-md text-xs font-medium transition-colors";
    const toggleActive = "bg-white/10 text-foreground";
    const toggleIdle = "text-muted-foreground hover:text-foreground";

    return (
        <form className="space-y-3" onSubmit={submit}>
            <div className="flex gap-1 rounded-lg border border-white/8 bg-black/20 p-1" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "login"}
                    className={`${toggleBase} ${mode === "login" ? toggleActive : toggleIdle}`}
                    onClick={() => switchMode("login")}
                >
                    {t("action.logIn")}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "register"}
                    className={`${toggleBase} ${mode === "register" ? toggleActive : toggleIdle}`}
                    onClick={() => switchMode("register")}
                >
                    {t("action.register")}
                </button>
            </div>

            <div className="space-y-1">
                <label htmlFor="yt-auth-email" className="text-xs font-medium text-muted-foreground">
                    {t("auth.email")}
                </label>
                <Input
                    id="yt-auth-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    disabled={busy}
                    className="h-9 text-sm"
                />
            </div>

            <div className="space-y-1">
                <label htmlFor="yt-auth-password" className="text-xs font-medium text-muted-foreground">
                    {t("auth.password")}
                </label>
                <Input
                    id="yt-auth-password"
                    type="password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
                    disabled={busy}
                    className="h-9 text-sm"
                />
            </div>

            {error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}

            <Button type="submit" size="sm" className="w-full" disabled={busy || email === "" || password === ""}>
                {busy ? (
                    <>
                        <Loader2 className="size-4 animate-spin" />
                        {mode === "login" ? "Signing in…" : "Creating account…"}
                    </>
                ) : mode === "login" ? (
                    t("action.logIn")
                ) : (
                    t("action.createAccount")
                )}
            </Button>

            {mode === "register" ? (
                <p className="text-center text-xs text-muted-foreground">New accounts start with 💎 100.</p>
            ) : null}
        </form>
    );
}
