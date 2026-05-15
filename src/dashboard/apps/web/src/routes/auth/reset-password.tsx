import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AlertCircle, KeyRound, Loader2, Lock } from "lucide-react";
import { useState } from "react";
import { AuthAlertBanner, AuthInputField, AuthLayout } from "@/components/auth";
import { Button } from "@ui/components/button";

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
            await new Promise((resolve) => setTimeout(resolve, 1000));
            navigate({ to: "/auth/signin", search: { reset: true } });
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

                {error && <AuthAlertBanner variant="error" message={error} />}

                {/* Reset Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
                    <AuthInputField
                        id="password"
                        name="password"
                        type="password"
                        label="New Password"
                        autoComplete="new-password"
                        required
                        minLength={8}
                        placeholder="Enter new password"
                        description="Must be at least 8 characters"
                        icon={<Lock className="h-4 w-4" />}
                    />

                    <AuthInputField
                        id="confirmPassword"
                        name="confirmPassword"
                        type="password"
                        label="Confirm Password"
                        autoComplete="new-password"
                        required
                        minLength={8}
                        placeholder="Confirm new password"
                        icon={<Lock className="h-4 w-4" />}
                    />

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
