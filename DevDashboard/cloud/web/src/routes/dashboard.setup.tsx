import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Card, SectionTitle } from "@/components/dashboard/Card";
import { Check } from "@/components/landing/icons";
import { claimSubdomain, getSubdomain, listDevices, pairDevice } from "@/lib/dashboard/dashboard.functions";

/** Client-side mirror of `isValidSubdomainName` (server-only module) so we can validate before the round-trip. */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

export const Route = createFileRoute("/dashboard/setup")({
    loader: async () => {
        const [subdomain, devices] = await Promise.all([getSubdomain(), listDevices()]);
        return { subdomain, deviceCount: devices.length };
    },
    component: SetupPage,
});

function SetupPage() {
    const { subdomain, deviceCount } = Route.useLoaderData();

    return (
        <div>
            <SectionTitle
                title="Setup wizard"
                subtitle="Three steps to go remote: get the agent, claim a managed subdomain, then pair your devices."
            />

            <div className="space-y-5">
                <AgentStep />
                <SubdomainStep claimed={subdomain} />
                <PairStep deviceCount={deviceCount} />
            </div>
        </div>
    );
}

function StepHeader({ n, title, done }: { n: number; title: string; done?: boolean }) {
    return (
        <div className="flex items-center gap-3">
            <span
                className={`flex h-7 w-7 items-center justify-center rounded-full font-mono text-[12px] ring-1 ${
                    done
                        ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30"
                        : "bg-white/[0.04] text-zinc-400 ring-white/10"
                }`}
            >
                {done ? <Check className="h-3.5 w-3.5" /> : n}
            </span>
            <h2 className="font-display text-lg font-semibold text-zinc-100">{title}</h2>
        </div>
    );
}

function AgentStep() {
    return (
        <Card className="reveal in">
            <div data-testid="setup-step-1">
                <StepHeader n={1} title="Get the agent" />
                <p className="mt-3 text-sm leading-relaxed text-zinc-500">
                    Run the DevDashboard Agent on your Mac. It serves your terminals and Pulse locally — nothing
                    leaves the machine until you pick a transport below.
                </p>
                <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-[#060708] px-4 py-3 font-mono text-[13px] text-zinc-300 ring-1 ring-white/[0.06]">
                    <span className="text-emerald-400">➜</span> <span className="text-violet-300">devdash</span>{" "}
                    agent start
                </pre>
            </div>
        </Card>
    );
}

type SubdomainRow = Awaited<ReturnType<typeof getSubdomain>>;

function SubdomainStep({ claimed }: { claimed: SubdomainRow }) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setNote(null);

        const trimmed = name.trim().toLowerCase();

        if (!SUBDOMAIN_RE.test(trimmed)) {
            setError("Use 3–32 lowercase letters, digits, or hyphens (no leading/trailing hyphen).");
            return;
        }

        setPending(true);

        try {
            const result = await claimSubdomain({ data: { name: trimmed } });
            setNote(result.note);
            await router.invalidate();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not claim that subdomain.");
        } finally {
            setPending(false);
        }
    }

    return (
        <Card className="reveal in">
            <div data-testid="setup-step-2">
                <StepHeader n={2} title="Claim your managed subdomain" done={claimed !== null} />

                {claimed ? (
                    <div className="mt-4">
                        <p className="text-sm text-zinc-500">Your managed hostname is reserved:</p>
                        <p
                            className="mt-2 inline-flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] px-3.5 py-2 font-mono text-sm text-emerald-200"
                            data-testid="setup-subdomain-hostname"
                        >
                            {claimed.hostname}
                        </p>
                    </div>
                ) : (
                    <>
                        <p className="mt-3 text-sm leading-relaxed text-zinc-500">
                            Pick a name and we'll reserve <span className="font-mono text-zinc-400">&lt;name&gt;.devdashboard.app</span>{" "}
                            for your account — no domain of your own required.
                        </p>
                        <form onSubmit={onSubmit} className="mt-4" data-testid="setup-subdomain-form">
                            <div className="flex items-stretch gap-2">
                                <div className="flex flex-1 items-center rounded-xl border border-white/10 bg-white/[0.03] pr-3 transition-colors duration-300 ease-silk focus-within:border-emerald-400/30 focus-within:bg-white/[0.05]">
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(ev) => setName(ev.target.value)}
                                        placeholder="my-mac"
                                        autoComplete="off"
                                        spellCheck={false}
                                        data-testid="setup-subdomain-input"
                                        className="min-w-0 flex-1 bg-transparent px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                                    />
                                    <span className="shrink-0 font-mono text-[12px] text-zinc-600">.devdashboard.app</span>
                                </div>
                                <button
                                    type="submit"
                                    disabled={pending}
                                    data-testid="setup-subdomain-submit"
                                    className="shrink-0 rounded-full bg-emerald-400 px-5 py-2.5 text-sm font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98] disabled:opacity-60"
                                >
                                    {pending ? "Claiming…" : "Claim"}
                                </button>
                            </div>
                            {error && (
                                <p
                                    className="mt-3 rounded-xl bg-red-500/10 px-3.5 py-2.5 font-mono text-[12px] text-red-300 ring-1 ring-red-400/20"
                                    data-testid="setup-subdomain-error"
                                >
                                    {error}
                                </p>
                            )}
                        </form>
                    </>
                )}

                {note && (
                    <div
                        className="mt-4 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-4 py-3"
                        data-testid="setup-subdomain-note"
                    >
                        <p className="font-mono text-[11px] uppercase tracking-wider text-amber-300/90">Demo mode</p>
                        <p className="mt-1 text-sm leading-relaxed text-amber-200/80">{note}</p>
                    </div>
                )}
            </div>
        </Card>
    );
}

function PairStep({ deviceCount }: { deviceCount: number }) {
    const router = useRouter();
    const [label, setLabel] = useState("");
    const [kind, setKind] = useState<"phone" | "agent">("phone");
    const [publicKey, setPublicKey] = useState("");
    const [deviceCode, setDeviceCode] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pairedLabel, setPairedLabel] = useState<string | null>(null);

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setPairedLabel(null);
        setPending(true);

        try {
            const result = await pairDevice({ data: { label: label.trim(), kind, publicKey: publicKey.trim(), deviceCode: deviceCode.trim() } });
            setPairedLabel(result.device.label);
            setLabel("");
            setPublicKey("");
            setDeviceCode("");
            await router.invalidate();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not pair that device.");
        } finally {
            setPending(false);
        }
    }

    return (
        <Card className="reveal in">
            <div data-testid="setup-step-3">
                <StepHeader n={3} title="Pair a device" done={deviceCount > 0} />
                <p className="mt-3 text-sm leading-relaxed text-zinc-500">
                    Run <span className="font-mono text-zinc-400">tools dev-dashboard pair</span> on your Mac to print a
                    device code and public key, then enter them here. The cloud records the public key only — the
                    end-to-end handshake happens phone&#8596;Mac.
                </p>

                <form onSubmit={onSubmit} className="mt-5 space-y-3" data-testid="setup-pair-form">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field
                            label="Label"
                            value={label}
                            onChange={setLabel}
                            placeholder="Studio Mac"
                            testId="setup-pair-label"
                            required
                        />
                        <div>
                            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                                Kind
                            </span>
                            <select
                                value={kind}
                                onChange={(ev) => setKind(ev.target.value === "agent" ? "agent" : "phone")}
                                data-testid="setup-pair-kind"
                                className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 transition-colors duration-300 ease-silk focus:border-emerald-400/30 focus:bg-white/[0.05] focus:outline-none"
                            >
                                <option value="phone">phone</option>
                                <option value="agent">agent</option>
                            </select>
                        </div>
                    </div>
                    <Field
                        label="Public key"
                        value={publicKey}
                        onChange={setPublicKey}
                        placeholder="base64 X25519 public key"
                        testId="setup-pair-publickey"
                        mono
                        required
                    />
                    <Field
                        label="Device code"
                        value={deviceCode}
                        onChange={setDeviceCode}
                        placeholder="e.g. 4821-9930"
                        testId="setup-pair-devicecode"
                        mono
                        required
                    />

                    {error && (
                        <p
                            className="rounded-xl bg-red-500/10 px-3.5 py-2.5 font-mono text-[12px] text-red-300 ring-1 ring-red-400/20"
                            data-testid="setup-pair-error"
                        >
                            {error}
                        </p>
                    )}

                    {pairedLabel && (
                        <p
                            className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] px-3.5 py-2.5 text-sm text-emerald-200"
                            data-testid="setup-pair-success"
                        >
                            <Check className="h-3.5 w-3.5 shrink-0" /> Paired {pairedLabel}.
                        </p>
                    )}

                    <button
                        type="submit"
                        disabled={pending}
                        data-testid="setup-pair-submit"
                        className="rounded-full bg-emerald-400 px-5 py-2.5 text-sm font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98] disabled:opacity-60"
                    >
                        {pending ? "Pairing…" : "Pair device"}
                    </button>
                </form>

                <p className="mt-5 text-sm text-zinc-500">
                    Manage paired devices on the{" "}
                    <Link to="/dashboard/devices" className="text-emerald-300 hover:text-emerald-200">
                        Devices
                    </Link>{" "}
                    page.
                </p>
            </div>
        </Card>
    );
}

function Field({
    label,
    value,
    onChange,
    placeholder,
    testId,
    mono,
    required,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    testId: string;
    mono?: boolean;
    required?: boolean;
}) {
    return (
        <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                required={required}
                data-testid={testId}
                className={`w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 transition-colors duration-300 ease-silk focus:border-emerald-400/30 focus:bg-white/[0.05] focus:outline-none ${
                    mono ? "font-mono text-[13px]" : ""
                }`}
            />
        </label>
    );
}
