import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { useLogin, useLogout, useMe, useRegister } from "@app/yt/api.hooks";
import { useState } from "react";

export function AccountSection() {
    const me = useMe();
    const login = useLogin();
    const register = useRegister();
    const logout = useLogout();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const busy = login.isPending || register.isPending;

    if (me.data) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        Account <Badge variant="secondary">{me.data.role}</Badge>
                    </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">{me.data.user.email}</p>
                    <Button variant="outline" size="sm" onClick={() => logout.mutate()}>
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
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">Sign in to use history, collections, and the watchlist.</p>
                <Input placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                <Input
                    placeholder="password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                />
                {(login.error ?? register.error) ? (
                    <p className="text-sm text-destructive">{((login.error ?? register.error) as Error).message}</p>
                ) : null}
                <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => login.mutate({ email, password })}>
                        Sign in
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => register.mutate({ email, password })}>
                        Register
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
