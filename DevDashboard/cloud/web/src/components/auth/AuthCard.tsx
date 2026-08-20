import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ArrowRight, LogoMark } from "@/components/landing/icons";
import { signIn, signUp } from "@/lib/auth/auth-client";

type Mode = "signin" | "signup";

interface AuthCardProps {
    mode: Mode;
    plan?: "free" | "pro" | "team";
}

export function AuthCard({ mode, plan }: AuthCardProps) {
    const navigate = useNavigate();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const isSignup = mode === "signup";

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setPending(true);

        try {
            if (isSignup) {
                const res = await signUp.email({ email, password, name: name || email.split("@")[0] || "there" });

                if (res.error) {
                    setError(res.error.message ?? "Could not create your account.");
                    return;
                }
            } else {
                const res = await signIn.email({ email, password });

                if (res.error) {
                    setError(res.error.message ?? "Invalid email or password.");
                    return;
                }
            }

            await navigate({ to: "/dashboard" });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong. Please retry.");
        } finally {
            setPending(false);
        }
    }

    return (
        <main className="relative z-10 mx-auto flex min-h-[100dvh] max-w-md flex-col items-center justify-center px-6 py-24">
            <Link to="/" className="mb-8 flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400/20 to-violet-500/20 ring-1 ring-white/10">
                    <LogoMark className="h-4 w-4 text-emerald-300" />
                </span>
                <span className="font-display text-lg font-semibold tracking-tight text-zinc-100">DevDashboard</span>
            </Link>

            <div className="w-full rounded-[2rem] border border-white/10 bg-white/[0.03] p-2 backdrop-blur-2xl">
                <div className="inset-hi rounded-[calc(2rem-0.5rem)] bg-[#0a0b0d] p-8 ring-1 ring-white/[0.06]">
                    <h1 className="font-display text-2xl font-semibold text-zinc-50">
                        {isSignup ? "Create your account" : "Welcome back"}
                    </h1>
                    <p className="mt-2 text-sm text-zinc-500">
                        {isSignup
                            ? plan && plan !== "free"
                                ? `Start your ${plan} plan — set up takes ~30 seconds.`
                                : "Self-host stays free. Sign up to add managed remote."
                            : "Sign in to manage your devices and subscription."}
                    </p>

                    <form onSubmit={onSubmit} className="mt-7 space-y-3">
                        {isSignup && (
                            <Field
                                label="Name"
                                type="text"
                                value={name}
                                onChange={setName}
                                placeholder="Your name"
                                autoComplete="name"
                            />
                        )}
                        <Field
                            label="Email"
                            type="email"
                            value={email}
                            onChange={setEmail}
                            placeholder="you@yourmachine.dev"
                            autoComplete="email"
                            required
                        />
                        <Field
                            label="Password"
                            type="password"
                            value={password}
                            onChange={setPassword}
                            placeholder="••••••••"
                            autoComplete={isSignup ? "new-password" : "current-password"}
                            required
                        />

                        {error && (
                            <p
                                data-testid="auth-error"
                                className="rounded-xl bg-red-500/10 px-3.5 py-2.5 font-mono text-[12px] text-red-300 ring-1 ring-red-400/20"
                            >
                                {error}
                            </p>
                        )}

                        <button
                            type="submit"
                            disabled={pending}
                            className="group mt-2 flex w-full items-center justify-center gap-2.5 rounded-full bg-emerald-400 py-3 pl-5 pr-2 text-[15px] font-medium text-emerald-950 transition-transform duration-500 ease-silk active:scale-[0.98] disabled:opacity-60"
                        >
                            {pending ? "Working…" : isSignup ? "Create account" : "Sign in"}
                            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-950/15 transition-transform duration-500 ease-silk group-hover:translate-x-1">
                                <ArrowRight className="h-4 w-4" />
                            </span>
                        </button>
                    </form>

                    <p className="mt-6 text-center text-sm text-zinc-500">
                        {isSignup ? (
                            <>
                                Already have an account?{" "}
                                <Link to="/signin" className="text-emerald-300 hover:text-emerald-200">
                                    Sign in
                                </Link>
                            </>
                        ) : (
                            <>
                                New here?{" "}
                                <Link to="/signup" className="text-emerald-300 hover:text-emerald-200">
                                    Create an account
                                </Link>
                            </>
                        )}
                    </p>
                </div>
            </div>
        </main>
    );
}

function Field({
    label,
    type,
    value,
    onChange,
    placeholder,
    autoComplete,
    required,
}: {
    label: string;
    type: string;
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    autoComplete: string;
    required?: boolean;
}) {
    return (
        <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                autoComplete={autoComplete}
                required={required}
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 transition-colors duration-300 ease-silk focus:border-emerald-400/30 focus:bg-white/[0.05] focus:outline-none"
            />
        </label>
    );
}
