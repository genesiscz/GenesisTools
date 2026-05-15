import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { AuthAlertBanner, AuthInputField, AuthLayout } from "@/components/auth";
import { Button } from "@ui/components/button";

export const Route = createFileRoute("/auth/forgot-password")({
    component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const [email, setEmail] = useState("");

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);

        const formData = new FormData(e.currentTarget);
        const emailValue = formData.get("email") as string;
        setEmail(emailValue);

        try {
            // TODO: Implement password reset with WorkOS
            await new Promise((resolve) => setTimeout(resolve, 1000));
            setSuccess(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send reset email");
        } finally {
            setIsLoading(false);
        }
    };

    if (success) {
        return (
            <AuthLayout>
                <div className="space-y-6">
                    <div className="text-center space-y-4">
                        <div className="flex justify-center">
                            <div className="h-16 w-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
                                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                            </div>
                        </div>
                        <h1 className="text-2xl font-bold tracking-tight text-white">Check your email</h1>
                        <p className="text-gray-400">
                            We've sent a password reset link to{" "}
                            <span className="font-medium text-amber-500">{email}</span>
                        </p>
                        <p className="text-sm text-gray-500">The link will expire in 24 hours</p>
                    </div>

                    <Link
                        to="/auth/signin"
                        className="flex items-center justify-center gap-2 text-amber-500 hover:underline"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Back to sign in
                    </Link>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout>
            <div className="space-y-6">
                {/* Header */}
                <div className="text-center space-y-2">
                    <h1 className="text-2xl font-bold tracking-tight text-white">Forgot password?</h1>
                    <p className="text-gray-400">Enter your email and we'll send you a reset link</p>
                </div>

                {error && <AuthAlertBanner variant="error" message={error} />}

                {/* Reset Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
                    <AuthInputField
                        id="email"
                        name="email"
                        type="email"
                        label="Email"
                        autoComplete="username"
                        autoCapitalize="off"
                        required
                        placeholder="you@example.com"
                        icon={<Mail className="h-4 w-4" />}
                    />

                    <Button
                        type="submit"
                        className="w-full h-11 text-base font-semibold bg-amber-500 hover:bg-amber-600 text-black neon-glow btn-glow"
                        disabled={isLoading}
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Sending...
                            </>
                        ) : (
                            "Send reset link"
                        )}
                    </Button>
                </form>

                <Link
                    to="/auth/signin"
                    className="flex items-center justify-center gap-2 text-amber-500 hover:underline text-sm"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Back to sign in
                </Link>
            </div>
        </AuthLayout>
    );
}
