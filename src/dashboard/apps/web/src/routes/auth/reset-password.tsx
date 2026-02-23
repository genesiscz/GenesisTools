import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AlertCircle, KeyRound, Loader2, Lock } from "lucide-react";
import { useState } from "react";
import { AuthLayout } from "@/components/auth";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/auth/reset-password")({
    component: ResetPasswordPage,
    validateSearch: (search: Record<string, unknown>) => ({
        token: search.token as string | undefined,
        email: search.email as string | undefined,
    }),
});

function ResetPasswordPage() {
    const navigate = useNavigate();
    const { token, email } = useSearch({ from: "/auth/reset-password" });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Check for valid token
    if (!token || !email) {
        return (
            <AuthLayout>
                <div className="space-y-6">
                    <div className="text-center space-y-4">
                        <div className="flex justify-center">
                            <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center glitch-effect">
                                <AlertCircle className="h-8 w-8 text-red-500" />
                            </div>
                        </div>
                        <h1 className="text-2xl font-bold tracking-tight text-white">Invalid reset link</h1>
                        <p className="text-gray-400">This password reset link is invalid or has expired.</p>
                    </div>

                    <div className="flex flex-col gap-3">
                        <Link to="/auth/forgot-password">
                            <Button className="w-full h-11 bg-amber-500 hover:bg-amber-600 text-black">
                                Request new link
                            </Button>
                        </Link>
                        <Link to="/auth/signin">
                            <Button
                                variant="outline"
                                className="w-full h-11 border-amber-500/20 text-white hover:bg-amber-500/5"
                            >
                                Back to sign in
                            </Button>
                        </Link>
                    </div>
                </div>
            </AuthLayout>
        );
    }

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);

        const formData = new FormData(e.currentTarget);
        const password = formData.get("password") as string;
        const confirmPassword = formData.get("confirmPassword") as string;

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            setIsLoading(false);
            return;
        }

        if (password.length < 8) {
            setError("Password must be at least 8 characters");
            setIsLoading(false);
            return;
        }

        try {
            // TODO: Implement password reset with WorkOS
            // For now, simulate success
            await new Promise((resolve) => setTimeout(resolve, 1000));
            navigate({ to: "/auth/signin", search: { reset: "success" } });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to reset password");
            setIsLoading(false);
        }
    };

    return (
        <AuthLayout>
            <div className="space-y-6">
                {/* Header */}
                <div className="text-center space-y-4">
                    <div className="flex justify-center">
                        <div className="h-16 w-16 rounded-full bg-amber-500/10 flex items-center justify-center">
                            <KeyRound className="h-8 w-8 text-amber-500" />
                        </div>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Reset your password</h1>
                    <p className="text-gray-400">
                        Enter a new password for <span className="font-medium text-amber-500">{email}</span>
                    </p>
                </div>

                {/* Error message */}
                {error && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {/* Reset Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <label htmlFor="password" className="text-sm font-medium text-gray-300">
                            New Password
                        </label>
                        <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                            <input
                                id="password"
                                name="password"
                                type="password"
                                autoComplete="new-password"
                                required
                                minLength={8}
                                placeholder="Enter new password"
                                className="w-full h-11 pl-10 pr-4 rounded-lg bg-black/50 border border-amber-500/20 focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20 outline-none transition-all placeholder:text-gray-600 text-white"
                            />
                        </div>
                        <p className="text-xs text-gray-500">Must be at least 8 characters</p>
                    </div>

                    <div className="space-y-2">
                        <label htmlFor="confirmPassword" className="text-sm font-medium text-gray-300">
                            Confirm Password
                        </label>
                        <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                            <input
                                id="confirmPassword"
                                name="confirmPassword"
                                type="password"
                                autoComplete="new-password"
                                required
                                minLength={8}
                                placeholder="Confirm new password"
                                className="w-full h-11 pl-10 pr-4 rounded-lg bg-black/50 border border-amber-500/20 focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20 outline-none transition-all placeholder:text-gray-600 text-white"
                            />
                        </div>
                    </div>

                    <Button
                        type="submit"
                        className="w-full h-11 text-base font-semibold bg-amber-500 hover:bg-amber-600 text-black neon-glow btn-glow"
                        disabled={isLoading}
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Resetting...
                            </>
                        ) : (
                            "Reset password"
                        )}
                    </Button>
                </form>
            </div>
        </AuthLayout>
    );
}
