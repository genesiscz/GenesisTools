import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { AuthLayout } from "@app/utils/ui/layouts/AuthLayout";
import { ShoppingBasket } from "lucide-react";
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
        <AuthLayout
            brand="SHOPS::CZ"
            icon={<ShoppingBasket className="h-6 w-6 text-primary-foreground" />}
            footer={<>Czech eshop price aggregator — watchlist, alerts, observability</>}
        >
            <h1 className="font-mono text-sm tracking-[0.25em] uppercase text-muted-foreground mb-6">{title}</h1>
            <form
                className="space-y-3"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (email && password && !submitting) {
                        handle();
                    }
                }}
            >
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
                    autoComplete={submitLabel.toLowerCase().includes("register") ? "new-password" : "current-password"}
                />
                {error ? <div className="text-xs text-destructive">{error}</div> : null}
                <Button type="submit" disabled={submitting || !email || !password} className="w-full">
                    {submitting ? "..." : submitLabel}
                </Button>
                {bottomSlot}
            </form>
        </AuthLayout>
    );
}
