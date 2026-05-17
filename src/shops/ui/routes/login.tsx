import { AuthForm } from "@app/shops/ui/components/AuthForm";
import { SafeJSON } from "@app/utils/json";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
    component: LoginPage,
});

function LoginPage() {
    const navigate = useNavigate({ from: "/login" });
    const qc = useQueryClient();
    return (
        <AuthForm
            title="Login"
            submitLabel="Login"
            onSubmit={async (creds) => {
                const res = await fetch("/api/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: SafeJSON.stringify(creds),
                });
                const body = (await res.json()) as { ok?: boolean; error?: string };
                if (!res.ok) {
                    throw new Error(body.error ?? `login failed (${res.status})`);
                }

                toast.success("Logged in");
                await qc.invalidateQueries({ queryKey: ["auth", "me"] });
                navigate({ to: "/providers" });
            }}
            bottomSlot={
                <div className="text-xs text-muted-foreground text-center pt-2">
                    No account?{" "}
                    <Link to="/register" className="underline text-foreground">
                        Register
                    </Link>
                </div>
            }
        />
    );
}
