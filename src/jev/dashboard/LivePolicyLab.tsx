import { Badge } from "@artifact/kit";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { useEffect, useState } from "react";
import { api, errorMessage } from "./client";

interface ListenStatus {
    running: boolean;
    transcript?: string;
    wouldPress?: string | null;
    tail: Array<{ transcript: string; status: string; choice: string | null; probability: number; reason: string }>;
}

export function LivePolicyLab() {
    const [status, setStatus] = useState<ListenStatus>({ running: false, tail: [] });
    const [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        void api<ListenStatus>({ route: "/listen/status", signal: controller.signal })
            .then(setStatus)
            .catch((cause) => {
                if (!controller.signal.aborted) {
                    setError(errorMessage(cause));
                }
            });
        return () => controller.abort();
    }, []);
    const start = async () => {
        try {
            setStatus(await api<ListenStatus>({ route: "/listen/start", body: { transcript: "fixture.jsonl" } }));
            setError("");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const stop = async () => {
        try {
            setStatus(await api<ListenStatus>({ route: "/listen/stop", body: {} }));
            setError("");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const last = status.tail.at(-1);
    return (
        <div className="space-y-4">
            <Card variant="wow" accent="cyan">
                <CardHeader>
                    <CardTitle>Listen</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                    <p className="text-muted-foreground">
                        Live transcript and would-press / abstain. Start attaches to a fixture JSONL, not a browser mic.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <Badge>{status.running ? "session" : "idle"}</Badge>
                        <span>{status.transcript || "no transcript"}</span>
                        <span>would press: {status.wouldPress ?? "abstain"}</span>
                    </div>
                    {last && (
                        <p>
                            {last.status} · p={last.probability.toFixed(2)} · {last.reason}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <Button variant="brand" onClick={() => void start()}>
                            Start
                        </Button>
                        <Button variant="outline" onClick={() => void stop()}>
                            Stop
                        </Button>
                    </div>
                    {error && <p className="text-destructive">{error}</p>}
                </CardContent>
            </Card>
            <Card variant="wow-static" accent="emerald">
                <CardHeader>
                    <CardTitle>Watch</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                    Hz, in-flight request, last distribution, and last refusal come from `tools jev watch`. Exact
                    readback stays authoritative.
                </CardContent>
            </Card>
            <Card variant="wow-static" accent="violet">
                <CardHeader>
                    <CardTitle>Observe</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                    Assist defaults to one fan-out (target, verb, done, blocked, wait, risk). `--no-fanout` restores the
                    serial chooser.
                </CardContent>
            </Card>
        </div>
    );
}
