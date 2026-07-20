import { AuthForm } from "@app/youtube/ui/components/shared/auth-form";
import { formatDiamonds } from "@app/youtube/ui/components/shared/diamond";
import { isLoginRequiredError } from "@app/youtube/ui/components/shared/login-required";
import { useLogin, useLogout, useMe, useRegister } from "@app/yt/api.hooks";
import { Badge } from "@genesiscz/utils/ui/components/badge";
import { Button } from "@genesiscz/utils/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@genesiscz/utils/ui/components/card";
import { Loader2, LogOut } from "lucide-react";

export function AccountSection() {
    const me = useMe();
    const login = useLogin();
    const register = useRegister();
    const logout = useLogout();
    const busy = login.isPending || register.isPending;

    if (me.isPending) {
        return (
            <Card>
                <CardContent className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Loading account…
                </CardContent>
            </Card>
        );
    }

    if (me.isError && !isLoginRequiredError(me.error)) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Account</CardTitle>
                    <CardDescription>Couldn't reach the API server.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Button variant="outline" size="sm" onClick={() => void me.refetch()}>
                        Retry
                    </Button>
                </CardContent>
            </Card>
        );
    }

    if (me.data?.user) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        Account <Badge variant="secondary">{me.data.role}</Badge>
                    </CardTitle>
                    <CardDescription>Signed in · diamonds sync after summaries and questions.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="truncate text-sm text-foreground/95">{me.data.user.email}</p>
                        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                            💎 {formatDiamonds(me.data.user.credits)}
                        </p>
                    </div>
                    <Button variant="outline" size="sm" disabled={logout.isPending} onClick={() => logout.mutate()}>
                        <LogOut className="mr-1.5 size-3.5" />
                        Sign out
                    </Button>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Account</CardTitle>
                <CardDescription>
                    Sign in to use history, collections, digest, and diamond-priced summaries.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <AuthForm
                    idPrefix="yt-ui-settings-auth"
                    busy={busy}
                    onLogin={(creds) => login.mutateAsync(creds).then(() => undefined)}
                    onRegister={(creds) => register.mutateAsync(creds).then(() => undefined)}
                />
            </CardContent>
        </Card>
    );
}
