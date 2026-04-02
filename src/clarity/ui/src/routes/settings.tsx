import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { CheckCircle, Loader2, RefreshCw, Search, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusCard } from "../components/StatusCard";
import type { GranularStatus } from "../server/settings";

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
        body: SafeJSON.stringify({ curl }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Auth update failed (${res.status})`);
    }

    return res.json();
}

async function configureAdoApi(url: string) {
    const res = await fetch("/api/configure-ado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ url }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || body?.message || `ADO configuration failed (${res.status})`);
    }

    return res.json() as Promise<{ success: boolean; message: string; config?: { org: string; project: string } }>;
}

async function configureTimelogKeyApi() {
    const res = await fetch("/api/configure-timelog-key", { method: "POST" });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || body?.message || `TimeLog key fetch failed (${res.status})`);
    }

    return res.json() as Promise<{ success: boolean; message: string }>;
}

async function configureTimelogUserApi(params: { userId: string; userName: string; userEmail: string }) {
    const res = await fetch("/api/configure-timelog-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify(params),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || body?.message || `TimeLog user config failed (${res.status})`);
    }

    return res.json() as Promise<{ success: boolean; message: string }>;
}

interface TeamMember {
    id: string;
    displayName: string;
    uniqueName: string;
    imageUrl?: string;
}

export const Route = createFileRoute("/settings")({
    component: SettingsPage,
});

function SettingsPage() {
    const queryClient = useQueryClient();
    const [curlInput, setCurlInput] = useState("");
    const [adoUrl, setAdoUrl] = useState("");
    const [showAdoForm, setShowAdoForm] = useState(false);
    const [loadMembers, setLoadMembers] = useState(false);
    const [memberFilter, setMemberFilter] = useState("");
    const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);
    const [showUserPicker, setShowUserPicker] = useState(false);

    const { data: status } = useQuery<GranularStatus>({
        queryKey: ["granular-status"],
        queryFn: async () => {
            const res = await fetch("/api/granular-status");

            if (!res.ok) {
                throw new Error("Failed to fetch status");
            }

            return res.json();
        },
    });

    const testMutation = useMutation({
        mutationFn: testConnectionApi,
    });

    const authMutation = useMutation({
        mutationFn: () => updateAuthApi(curlInput),
        onSuccess: (result) => {
            if (result.success) {
                setCurlInput("");
                queryClient.invalidateQueries();
            }
        },
    });

    const adoMutation = useMutation({
        mutationFn: () => configureAdoApi(adoUrl),
        onSuccess: (result) => {
            if (result.success) {
                setAdoUrl("");
                setShowAdoForm(false);
                queryClient.invalidateQueries({ queryKey: ["granular-status"] });
                toast.success(result.message);
            }
        },
    });

    const timelogKeyMutation = useMutation({
        mutationFn: configureTimelogKeyApi,
        onSuccess: (result) => {
            if (result.success) {
                queryClient.invalidateQueries({ queryKey: ["granular-status"] });
                toast.success(result.message);
            }
        },
    });

    const timelogUserMutation = useMutation({
        mutationFn: configureTimelogUserApi,
        onSuccess: (result) => {
            if (result.success) {
                queryClient.invalidateQueries({ queryKey: ["granular-status"] });
                toast.success(result.message);
                setSelectedMember(null);
                setShowUserPicker(false);
                setLoadMembers(false);
                setMemberFilter("");
            }
        },
    });

    const { data: membersData, isLoading: membersLoading } = useQuery<{ members: TeamMember[] }>({
        queryKey: ["team-members"],
        queryFn: async () => {
            const res = await fetch("/api/team-members");

            if (!res.ok) {
                throw new Error("Failed to fetch team members");
            }

            return res.json();
        },
        enabled: loadMembers,
    });

    const filteredMembers = membersData?.members?.filter((m) => {
        if (!memberFilter) {
            return true;
        }

        const lower = memberFilter.toLowerCase();
        return m.displayName.toLowerCase().includes(lower) || m.uniqueName.toLowerCase().includes(lower);
    });

    const adoConfigured = status?.ado?.configured;
    const showAdoInput = !adoConfigured || showAdoForm;
    const showUserPickerSection = !status?.timelog?.defaultUser || showUserPicker;

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <h1 className="text-xl font-mono font-bold text-gray-200 mb-6">
                <span className="text-amber-500">Settings</span>
            </h1>

            {/* Status section */}
            <div className="mb-6">
                <StatusCard />
                <div className="mt-3 px-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => testMutation.mutate()}
                        disabled={testMutation.isPending}
                        className="font-mono text-xs"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 mr-2 ${testMutation.isPending ? "animate-spin" : ""}`} />
                        {testMutation.isPending ? "Testing..." : "Test connection"}
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

                    {testMutation.isError && (
                        <div className="mt-2 flex items-center gap-2">
                            <XCircle className="w-4 h-4 text-red-400" />
                            <span className="font-mono text-xs text-red-400">
                                {testMutation.error instanceof Error
                                    ? testMutation.error.message
                                    : "Connection test failed"}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            {/* ADO Configure section */}
            <Card className="border-amber-500/20 mb-6">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400">Azure DevOps Configuration</CardTitle>
                </CardHeader>
                <CardContent>
                    {adoConfigured && !showAdoForm && (
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <CheckCircle className="w-4 h-4 text-green-400" />
                                <span className="font-mono text-xs text-gray-300">
                                    {status.ado.org}/{status.ado.project}
                                </span>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setShowAdoForm(true)}
                                className="font-mono text-xs text-gray-500 hover:text-gray-300"
                            >
                                Reconfigure
                            </Button>
                        </div>
                    )}

                    {showAdoInput && (
                        <div>
                            <div className="flex items-center gap-2">
                                <Input
                                    value={adoUrl}
                                    onChange={(e) => setAdoUrl(e.target.value)}
                                    placeholder="https://dev.azure.com/MyOrg/MyProject/..."
                                    className="bg-black/30 border-white/10 font-mono text-sm flex-1"
                                />
                                <Button
                                    onClick={() => adoMutation.mutate()}
                                    disabled={adoMutation.isPending || !adoUrl.trim()}
                                    className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                                >
                                    {adoMutation.isPending ? "Configuring..." : "Configure"}
                                </Button>
                            </div>
                            <p className="text-xs text-gray-600 font-mono mt-1.5">Also accepts visualstudio.com URLs</p>

                            {adoMutation.isError && (
                                <div className="mt-2">
                                    <span className="font-mono text-xs text-red-400">
                                        {adoMutation.error instanceof Error
                                            ? adoMutation.error.message
                                            : "ADO configuration failed"}
                                    </span>
                                    {adoMutation.error instanceof Error &&
                                        adoMutation.error.message.toLowerCase().includes("not logged in") && (
                                            <p className="font-mono text-xs text-amber-400/70 mt-1">
                                                Hint: Run{" "}
                                                <code className="px-1 py-0.5 bg-white/5 rounded">az login</code> in your
                                                terminal first
                                            </p>
                                        )}
                                </div>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* TimeLog Configure section */}
            {adoConfigured && (
                <Card className="border-amber-500/20 mb-6">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-mono text-gray-400">TimeLog Configuration</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-5">
                        {/* API Key subsection */}
                        <div>
                            <p className="font-mono text-xs text-gray-500 mb-2">API Key</p>
                            {status?.timelog?.hasFunctionsKey ? (
                                <div className="flex items-center gap-2">
                                    <CheckCircle className="w-4 h-4 text-green-400" />
                                    <span className="font-mono text-xs text-gray-300">API key configured</span>
                                </div>
                            ) : (
                                <div>
                                    <Button
                                        onClick={() => timelogKeyMutation.mutate()}
                                        disabled={timelogKeyMutation.isPending}
                                        className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                                    >
                                        {timelogKeyMutation.isPending && (
                                            <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                                        )}
                                        {timelogKeyMutation.isPending ? "Fetching..." : "Fetch API Key"}
                                    </Button>

                                    {timelogKeyMutation.isError && (
                                        <span className="ml-2 font-mono text-xs text-red-400">
                                            {timelogKeyMutation.error instanceof Error
                                                ? timelogKeyMutation.error.message
                                                : "Failed to fetch API key"}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Default User subsection */}
                        <div>
                            <p className="font-mono text-xs text-gray-500 mb-2">Default User</p>

                            {status?.timelog?.defaultUser && !showUserPicker && (
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <CheckCircle className="w-4 h-4 text-green-400" />
                                        <span className="font-mono text-xs text-gray-300">
                                            {status.timelog.defaultUser.userName}
                                        </span>
                                        <span className="font-mono text-xs text-gray-500">
                                            ({status.timelog.defaultUser.userEmail})
                                        </span>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setShowUserPicker(true)}
                                        className="font-mono text-xs text-gray-500 hover:text-gray-300"
                                    >
                                        Change
                                    </Button>
                                </div>
                            )}

                            {showUserPickerSection && (
                                <div>
                                    {!loadMembers && (
                                        <Button
                                            onClick={() => setLoadMembers(true)}
                                            className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                                        >
                                            Load team members
                                        </Button>
                                    )}

                                    {loadMembers && membersLoading && (
                                        <div className="flex items-center gap-2 py-2">
                                            <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                                            <span className="font-mono text-xs text-gray-400">
                                                Loading team members...
                                            </span>
                                        </div>
                                    )}

                                    {loadMembers && filteredMembers && (
                                        <div className="space-y-2">
                                            <div className="relative">
                                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                                                <Input
                                                    value={memberFilter}
                                                    onChange={(e) => setMemberFilter(e.target.value)}
                                                    placeholder="Filter by name or email..."
                                                    className="bg-black/30 border-white/10 font-mono text-xs pl-8"
                                                />
                                            </div>

                                            <div className="max-h-64 overflow-y-auto space-y-1">
                                                {filteredMembers.map((member) => {
                                                    const isSelected = selectedMember?.id === member.id;
                                                    return (
                                                        <button
                                                            key={member.id}
                                                            type="button"
                                                            onClick={() => setSelectedMember(member)}
                                                            className={`w-full text-left px-3 py-2 rounded border font-mono text-xs transition-colors ${
                                                                isSelected
                                                                    ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                                                                    : "border-white/5 bg-black/20 text-gray-400 hover:border-amber-500/20"
                                                            }`}
                                                        >
                                                            <span className="font-bold">{member.displayName}</span>
                                                            <span className="ml-2 text-gray-500">
                                                                {member.uniqueName}
                                                            </span>
                                                        </button>
                                                    );
                                                })}

                                                {filteredMembers.length === 0 && (
                                                    <p className="font-mono text-xs text-gray-600 text-center py-3">
                                                        No members match filter
                                                    </p>
                                                )}
                                            </div>

                                            <Button
                                                onClick={() => {
                                                    if (!selectedMember) {
                                                        return;
                                                    }

                                                    timelogUserMutation.mutate({
                                                        userId: selectedMember.id,
                                                        userName: selectedMember.displayName,
                                                        userEmail: selectedMember.uniqueName,
                                                    });
                                                }}
                                                disabled={!selectedMember || timelogUserMutation.isPending}
                                                className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs disabled:opacity-40"
                                            >
                                                {timelogUserMutation.isPending ? (
                                                    <>
                                                        <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                                                        Saving...
                                                    </>
                                                ) : (
                                                    "Save as default user"
                                                )}
                                            </Button>

                                            {timelogUserMutation.isError && (
                                                <span className="font-mono text-xs text-red-400">
                                                    {timelogUserMutation.error instanceof Error
                                                        ? timelogUserMutation.error.message
                                                        : "Failed to save default user"}
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Update Auth section */}
            <Card className="border-amber-500/20 mb-6">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400">Configure / Update Auth</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-xs text-gray-500 font-mono mb-3 space-y-1">
                        <p>Paste a cURL command from your browser to set up or refresh auth tokens:</p>
                        <ol className="list-decimal list-inside space-y-0.5 text-gray-600 pl-1">
                            <li>Open Clarity PPM in Chrome/Edge, go to Timesheets</li>
                            <li>
                                Press <kbd className="px-1 py-0.5 bg-white/5 rounded text-gray-400">F12</kbd> to open
                                Developer Tools
                            </li>
                            <li>
                                Click the <span className="text-gray-400">Network</span> tab, then reload the page (F5)
                            </li>
                            <li>
                                Find any request containing <span className="text-gray-400">/ppm/rest/v1/</span>
                            </li>
                            <li>Right-click it &rarr; Copy &rarr; Copy as cURL (bash)</li>
                        </ol>
                    </div>
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

                        {authMutation.isError && (
                            <span className="font-mono text-xs text-red-400">
                                {authMutation.error instanceof Error
                                    ? authMutation.error.message
                                    : "Auth update failed"}
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
                            <code className="text-amber-400">tools clarity configure auth</code>
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
