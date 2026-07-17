import { logger } from "@app/logger/client";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Diamond, formatDiamonds } from "@app/utils/ui/components/youtube/diamond";
import { copyText } from "@app/utils/ui/components/youtube/share-button";
import { formatRelativeTime } from "@app/utils/ui/components/youtube/time";
import { ApiError } from "@ext/api.bridge";
import { useRedeemReferral, useReferral } from "@ext/api.hooks";
import { Check, Copy, Gift, Loader2, Users } from "lucide-react";
import { useState } from "react";

/**
 * Referral surface for the account hub (spec §4.4): the user's own invite code
 * with a copy/share action, their referees + per-referral rewards + total
 * earned, and a redeem entry for people arriving on an invite. Redeem errors
 * are surfaced by the server's stable code (403 `offer_inactive`, 409 already
 * redeemed) so the copy stays friendly instead of echoing raw messages.
 */
export function ReferralSection() {
    const referral = useReferral();

    if (referral.isError) {
        return (
            <div className="p-4">
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">
                        {referral.error instanceof Error ? referral.error.message : "Failed to load referrals."}
                    </p>
                </div>
            </div>
        );
    }

    const data = referral.data;

    return (
        <div className="space-y-4 p-4">
            {referral.isPending || !data ? (
                <div className="h-24 animate-pulse rounded-2xl bg-white/5" />
            ) : (
                <>
                    <InviteCard code={data.code} totalEarned={data.totalEarned} />
                    <RefereeList referees={data.referees} />
                </>
            )}
            <RedeemCard />
        </div>
    );
}

function InviteCard({ code, totalEarned }: { code: string; totalEarned: number }) {
    const [copied, setCopied] = useState(false);

    async function copy() {
        try {
            await copyText(`Join me on the YouTube companion — redeem code ${code} for bonus diamonds.`);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            logger.warn({ error }, "referral-section: copy failed");
        }
    }

    return (
        <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-transparent to-secondary/10 p-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">your invite code</p>
            <div className="mt-2 flex items-center gap-2">
                <span className="select-all font-mono text-xl font-semibold tracking-[0.2em] text-foreground">
                    {code}
                </span>
                <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => void copy()}>
                    {copied ? (
                        <>
                            <Check className="size-4 text-primary" /> Copied
                        </>
                    ) : (
                        <>
                            <Copy className="size-4" /> Share invite
                        </>
                    )}
                </Button>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                Earned so far:
                <Diamond size={14} />
                <span className="font-semibold tabular-nums text-foreground">{formatDiamonds(totalEarned)}</span>
            </p>
        </div>
    );
}

function RefereeList({ referees }: { referees: Array<{ email: string; redeemedAt: string; reward: number }> }) {
    return (
        <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">friends invited</p>
            {referees.length === 0 ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <Users className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">
                        No one's joined with your code yet — share it to earn diamonds when they do.
                    </p>
                </div>
            ) : (
                <div className="space-y-2">
                    {referees.map((referee) => (
                        <div
                            key={`${referee.email}-${referee.redeemedAt}`}
                            className="flex items-center gap-3 rounded-2xl border border-white/8 bg-black/20 p-3"
                        >
                            <p className="min-w-0 flex-1 truncate text-sm text-foreground/95">{referee.email}</p>
                            <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
                                {formatRelativeTime(referee.redeemedAt)}
                            </span>
                            <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
                                +<Diamond size={13} />
                                <span className="tabular-nums">{formatDiamonds(referee.reward)}</span>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function redeemErrorCopy(error: unknown): string {
    if (error instanceof ApiError) {
        if (error.code === "offer_inactive") {
            return "There's no active referral offer right now.";
        }

        const message = error.message.toLowerCase();

        if (message.includes("already redeemed")) {
            return "You've already redeemed a referral.";
        }

        if (message.includes("your own")) {
            return "You can't redeem your own code.";
        }

        if (message.includes("unknown")) {
            return "That code isn't valid.";
        }

        return error.message;
    }

    return error instanceof Error ? error.message : String(error);
}

function RedeemCard() {
    const redeem = useRedeemReferral();
    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [reward, setReward] = useState<number | null>(null);

    async function submit() {
        const trimmed = code.trim();

        if (trimmed === "" || redeem.isPending) {
            return;
        }

        setError(null);
        try {
            const result = await redeem.mutateAsync({ code: trimmed });
            setReward(result.reward);
            setCode("");
        } catch (err) {
            logger.warn({ error: err }, "referral-section: redeem failed");
            setError(redeemErrorCopy(err));
        }
    }

    if (reward !== null) {
        return (
            <div className="flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/5 p-3">
                <Gift className="size-5 shrink-0 text-primary" />
                <p className="text-sm text-foreground/95">
                    Referral redeemed —{" "}
                    <span className="inline-flex items-center gap-1 font-semibold text-primary">
                        +<Diamond size={13} />
                        <span className="tabular-nums">{formatDiamonds(reward)}</span>
                    </span>{" "}
                    added to your balance.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-2 rounded-2xl border border-white/8 bg-black/20 p-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                got an invite code?
            </p>
            <div className="flex items-center gap-2">
                <Input
                    value={code}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                    placeholder="ABCD1234"
                    maxLength={8}
                    aria-label="Referral code"
                    className="h-9 flex-1 font-mono uppercase tracking-[0.15em]"
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            void submit();
                        }
                    }}
                />
                <Button size="sm" disabled={redeem.isPending || code.trim() === ""} onClick={() => void submit()}>
                    {redeem.isPending ? <Loader2 className="size-4 animate-spin" /> : "Redeem"}
                </Button>
            </div>
            {error ? <p className="break-words text-sm text-destructive/90">{error}</p> : null}
        </div>
    );
}
