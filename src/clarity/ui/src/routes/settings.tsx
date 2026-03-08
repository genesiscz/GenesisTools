import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { CheckCircle, Globe, Link2, RefreshCw, Shield, User, XCircle } from "lucide-react";
import { useState } from "react";

async function fetchStatus() {
    const res = await fetch("/api/status");

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to fetch status (${res.status})`);
    }

    return res.json();
}

async function testConnectionApi() {
    const res = await fetch("/api/test-connection", { method: "POST" });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Connection test failed (${res.status})`);
    }

    return res.json();
}

async function updateAuthApi(curl: string) {
    const res = await fetch("/api/update-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ curl }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Auth update failed (${res.status})`);
    }

    return res.json();
}

export function SettingsPage() {
    const queryClient = useQueryClient();
    const [curlInput, setCurlInput] = useState("");

    const { data: status, isLoading } = useQuery({
        queryKey: ["status"],
        queryFn: fetchStatus,
    });

    const testMutation = useMutation({
        mutationFn: testConnectionApi,
    });

    const authMutation = useMutation({
        mutationFn: () => updateAuthApi(curlInput),
        onSuccess: (result) => {
            if (result.success) {
                setCurlInput("");
                queryClient.invalidateQueries({ queryKey: ["status"] });
            }
        },
    });

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <h1 className="text-xl font-mono font-bold text-gray-200 mb-6">
                <span className="text-amber-500">Settings</span>
            </h1>

            {/* Status section */}
            <Card className="border-amber-500/20 mb-6">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        Connection Status
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <div className="space-y-3">
                            <Skeleton variant="line" />
                            <Skeleton variant="line" />
                        </div>
                    ) : status ? (
                        <div className="space-y-3">
                            <div className="flex items-center gap-3">
                                <div
                                    className={`w-2 h-2 rounded-full ${status.configured ? "bg-green-500" : "bg-red-500"}`}
                                />
                                <span className="font-mono text-sm text-gray-300">
                                    {status.configured ? "Configured" : "Not configured"}
                                </span>
                            </div>

                            {status.baseUrl && (
                                <div className="flex items-center gap-3">
                                    <Globe className="w-4 h-4 text-gray-500" />
                                    <span className="font-mono text-sm text-gray-400">{status.baseUrl}</span>
                                </div>
                            )}

                            <div className="flex items-center gap-3">
                                <Shield className="w-4 h-4 text-gray-500" />
                                <span className="font-mono text-sm text-gray-400">
                                    Auth:{" "}
                                    {status.hasAuth ? (
                                        <Badge
                                            variant="outline"
                                            className="text-xs border-green-500/30 text-green-400 ml-1"
                                        >
                                            ACTIVE
                                        </Badge>
                                    ) : (
                                        <Badge
                                            variant="outline"
                                            className="text-xs border-red-500/30 text-red-400 ml-1"
                                        >
                                            MISSING
                                        </Badge>
                                    )}
                                </span>
                            </div>

                            <div className="flex items-center gap-3">
                                <Link2 className="w-4 h-4 text-gray-500" />
                                <span className="font-mono text-sm text-gray-400">
                                    Mappings: {status.mappingsCount}
                                </span>
                            </div>

                            {status.uniqueName && (
                                <div className="flex items-center gap-3">
                                    <User className="w-4 h-4 text-gray-500" />
                                    <span className="font-mono text-sm text-gray-400">{status.uniqueName}</span>
                                </div>
                            )}

                            <div className="pt-3">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => testMutation.mutate()}
                                    disabled={testMutation.isPending}
                                    className="font-mono text-xs"
                                >
                                    <RefreshCw
                                        className={`w-3.5 h-3.5 mr-2 ${testMutation.isPending ? "animate-spin" : ""}`}
                                    />
                                    {testMutation.isPending ? "Testing..." : "Test Connection"}
                                </Button>

                                {testMutation.data && (
                                    <div className="mt-2 flex items-center gap-2">
                                        {testMutation.data.success ? (
                                            <CheckCircle className="w-4 h-4 text-green-400" />
                                        ) : (
                                            <XCircle className="w-4 h-4 text-red-400" />
                                        )}
                                        <span
                                            className={`font-mono text-xs ${testMutation.data.success ? "text-green-400" : "text-red-400"}`}
                                        >
                                            {testMutation.data.message}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : null}
                </CardContent>
            </Card>

            {/* Update Auth section */}
            <Card className="border-amber-500/20 mb-6">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400">Update Auth Tokens</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-xs text-gray-500 font-mono mb-3">
                        Paste a cURL command from your browser&apos;s network tab to extract auth tokens.
                    </p>
                    <textarea
                        value={curlInput}
                        onChange={(e) => setCurlInput(e.target.value)}
                        placeholder="curl 'https://...' -H 'authToken: ...' -H 'Cookie: sessionId=...'"
                        className="w-full h-32 bg-black/30 border border-white/10 rounded px-3 py-2 font-mono text-xs text-gray-300 placeholder:text-gray-600 focus:border-amber-500/40 focus:outline-none resize-none"
                    />
                    <div className="mt-3 flex items-center gap-3">
                        <Button
                            onClick={() => authMutation.mutate()}
                            disabled={authMutation.isPending || !curlInput.trim()}
                            className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                        >
                            {authMutation.isPending ? "Updating..." : "Update Auth"}
                        </Button>

                        {authMutation.data && (
                            <span
                                className={`font-mono text-xs ${authMutation.data.success ? "text-green-400" : "text-red-400"}`}
                            >
                                {authMutation.data.message}
                            </span>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Help section */}
            <Card className="border-white/5">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400">CLI Commands</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-2 font-mono text-xs">
                        <div className="flex items-center gap-2">
                            <code className="text-amber-400">tools clarity configure</code>
                            <span className="text-gray-500">Initial setup with base URL and auth</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <code className="text-amber-400">tools clarity link-workitems</code>
                            <span className="text-gray-500">Create ADO-Clarity mappings</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <code className="text-amber-400">tools clarity fill --month N</code>
                            <span className="text-gray-500">Fill timesheets from CLI</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <code className="text-amber-400">tools clarity timesheet</code>
                            <span className="text-gray-500">View current timesheet</span>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
