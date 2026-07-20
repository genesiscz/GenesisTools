import { useOptionalAuthGate } from "@app/yt/components/account/auth-gate";
import { Button } from "@genesiscz/utils/ui/components/button";
import { Card, CardContent } from "@genesiscz/utils/ui/components/card";
import { Link } from "@tanstack/react-router";
import { LogIn } from "lucide-react";

export function SignInRequired({ action }: { action: string }) {
    const auth = useOptionalAuthGate();

    return (
        <Card>
            <CardContent className="flex flex-col items-start gap-3 p-6 text-sm text-muted-foreground">
                <p className="flex items-center gap-2">
                    <LogIn className="size-4" /> Sign in to {action}.
                </p>
                {auth ? (
                    <Button size="sm" onClick={() => auth.openAuth("login")}>
                        Log in / Register
                    </Button>
                ) : (
                    <Link to="/settings" className="underline">
                        Go to Settings
                    </Link>
                )}
            </CardContent>
        </Card>
    );
}
