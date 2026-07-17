import { Card, CardContent } from "@app/utils/ui/components/card";
import { Link } from "@tanstack/react-router";
import { LogIn } from "lucide-react";

export function SignInRequired({ action }: { action: string }) {
    return (
        <Card>
            <CardContent className="flex flex-col items-start gap-2 p-6 text-sm text-muted-foreground">
                <p className="flex items-center gap-2">
                    <LogIn className="size-4" /> Sign in to {action}.
                </p>
                <Link to="/settings" className="underline">
                    Go to Settings
                </Link>
            </CardContent>
        </Card>
    );
}
