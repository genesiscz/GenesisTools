import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { useState } from "react";

export interface AuthFormProps {
    title: string;
    submitLabel: string;
    onSubmit: (creds: { email: string; password: string }) => Promise<void>;
    bottomSlot?: React.ReactNode;
}

export function AuthForm({ title, submitLabel, onSubmit, bottomSlot }: AuthFormProps) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handle() {
        setSubmitting(true);
        setError(null);
        try {
            await onSubmit({ email, password });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    }

    function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" && email && password && !submitting) {
            handle();
        }
    }

    return (
        <div className="max-w-md mx-auto px-4 sm:px-6 py-12">
            <Card className="border-zinc-800 bg-zinc-950">
                <CardHeader>
                    <CardTitle className="font-mono text-sm tracking-[0.25em] uppercase">{title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Input
                        type="email"
                        placeholder="Email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        onKeyDown={handleKey}
                        autoComplete="email"
                    />
                    <Input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={handleKey}
                        autoComplete={
                            submitLabel.toLowerCase().includes("register") ? "new-password" : "current-password"
                        }
                    />
                    {error ? <div className="text-xs text-[var(--color-neon-coral,#ff5577)]">{error}</div> : null}
                    <Button onClick={handle} disabled={submitting || !email || !password} className="w-full">
                        {submitting ? "..." : submitLabel}
                    </Button>
                    {bottomSlot}
                </CardContent>
            </Card>
        </div>
    );
}
