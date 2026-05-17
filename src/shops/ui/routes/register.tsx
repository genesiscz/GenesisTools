import { AuthForm } from "@app/shops/ui/components/AuthForm";
import { SafeJSON } from "@app/utils/json";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

export const Route = createFileRoute("/register")({
    component: RegisterPage,
});

function RegisterPage() {
    const navigate = useNavigate({ from: "/register" });
    const qc = useQueryClient();
    return (
        <AuthForm
            title="Register"
            submitLabel="Register"
            onSubmit={async (creds) => {
                const res = await fetch("/api/auth/register", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: SafeJSON.stringify(creds),
                });
                const body = (await res.json()) as { ok?: boolean; error?: string };
                if (!res.ok) {
                    throw new Error(body.error ?? `register failed (${res.status})`);
                }

                toast.success("Registered & logged in");
                await qc.invalidateQueries({ queryKey: ["auth", "me"] });
                navigate({ to: "/providers" });
            }}
            bottomSlot={
                <div className="text-xs text-muted-foreground text-center pt-2">
                    Already have an account?{" "}
                    <Link to="/login" className="underline text-foreground">
                        Login
                    </Link>
                </div>
            }
        />
    );
}
