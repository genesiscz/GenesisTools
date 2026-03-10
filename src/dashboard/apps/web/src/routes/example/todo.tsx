/**
 * Live Sync Todo Example
 *
 * This page demonstrates:
 * 1. TanStack DB collection with PowerSync persistence
 * 2. Optimistic UI updates
 * 3. Server sync via server functions
 * 4. Cross-tab sync via BroadcastChannel (automatic with PowerSync)
 * 5. Cross-device sync via WebSockets
 * 6. Two database backends: Drizzle+Neon (type-safe), Neon raw SQL
 * 7. Three sync modes: PowerSync-only, WebSocket-only, Integrated
 */

import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState, useEffect, useRef } from "react";
import {
    Database,
    Wifi,
    WifiOff,
    Plus,
    Trash2,
    Check,
    Loader2,
    RefreshCw,
    Zap,
    Server,
    Cloud,
} from "lucide-react";
import { DashboardLayout } from "@/components/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
    getTodosCollection,
    getCollection,
    type TodoInput,
    type Todo,
} from "../../lib/example-todo/todo-collection";
import {
    syncToServer,
    initializeDatabase,
} from "../../lib/db";
import {
    getTodos,
    createTodo,
    type DbBackend,
} from "../../lib/example-todo/todo-sync.server";

// Sync modes
type SyncMode = "powersync-only" | "websocket-only" | "integrated";

export const Route = createFileRoute("/example/todo")({
    component: TodoExample,
});

function TodoExample() {
    // ========== DATABASE INITIALIZATION ==========
    const [dbReady, setDbReady] = useState(false);
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic collection type from TanStack DB
    const [collection, setCollection] = useState<ReturnType<typeof getCollection>>(null);

    useEffect(() => {
        async function init() {
            if (typeof window === "undefined") return;

            console.log("[LiveSync] Initializing PowerSync database...");
            await initializeDatabase();
            console.log("[LiveSync] PowerSync database ready");

            console.log("[LiveSync] Creating todos collection...");
            const col = await getTodosCollection();
            console.log("[LiveSync] Collection ready");

            setCollection(col);
            setDbReady(true);
        }

        if (!dbReady) {
            init();
        }
    }, [dbReady]);

    if (!dbReady || !collection) {
        return (
            <DashboardLayout title="Live Sync Example" description="Offline-first data synchronization">
                <div className="flex items-center justify-center min-h-[60vh]">
                    <div className="flex flex-col items-center gap-4">
                        <div className="relative">
                            <div className="p-4 rounded-2xl bg-primary/10 border border-primary/20">
                                <Database className="h-10 w-10 text-primary animate-pulse" />
                            </div>
                            <div className="absolute -top-1 -right-1">
                                <Loader2 className="h-5 w-5 text-secondary animate-spin" />
                            </div>
                        </div>
                        <span className="text-muted-foreground text-sm font-mono">Initializing PowerSync...</span>
                    </div>
                </div>
            </DashboardLayout>
        );
    }

    return <TodoContent collection={collection} />;
}

// biome-ignore lint/suspicious/noExplicitAny: Dynamic collection type
function TodoContent({ collection }: { collection: NonNullable<ReturnType<typeof getCollection>> }) {
    // ========== SETTINGS SWITCHES ==========
    const [backend, setBackend] = useState<DbBackend>("drizzle-neon");
    const [syncMode, setSyncMode] = useState<SyncMode>("powersync-only");
    const wsRef = useRef<WebSocket | null>(null);
    const [wsConnected, setWsConnected] = useState(false);

    // ========== LIVE QUERY (TanStack DB + PowerSync) ==========
    // biome-ignore lint/suspicious/noExplicitAny: TanStack DB collection type inference
    const { data: rawTodos, isLoading, status } = useLiveQuery((q: any) =>
        q.from({ todo: collection })
    );

    // Filter to demo-user todos and cast to proper type
    const userTodos = ((rawTodos ?? []) as Todo[]).filter(
        (t) => t.user_id === "demo-user"
    );

    // ========== WEBSOCKET CONNECTION ==========
    useEffect(() => {
        if (syncMode === "powersync-only") {
            wsRef.current?.close();
            wsRef.current = null;
            setWsConnected(false);
            return;
        }

        console.log("[LiveSync] Connecting WebSocket...");
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${protocol}//${window.location.host}/_ws-todo`);

        ws.onopen = () => {
            console.log("[LiveSync] WebSocket connected to:", ws.url);
            setWsConnected(true);
        };

        ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                console.log("[LiveSync] WebSocket message received:", msg.type, msg);

                if (msg.type === "connected") {
                    console.log("[LiveSync] Server assigned clientId:", msg.clientId);
                }

                if (msg.type === "TODO_CREATED") {
                    console.log("[LiveSync] Inserting remote todo into local DB:", msg.todo.id);
                    // Insert with SQLite types (todo from WebSocket already has correct types)
                    collection.insert({
                        id: msg.todo.id,
                        text: msg.todo.text,
                        completed: msg.todo.completed,
                        user_id: msg.todo.user_id,
                        created_at: msg.todo.created_at,
                        updated_at: msg.todo.updated_at,
                    });
                }

                if (msg.type === "TODO_DELETED") {
                    console.log("[LiveSync] Deleting remote todo from local DB:", msg.todoId);
                    collection.delete(msg.todoId);
                }
            } catch (err) {
                console.error("[LiveSync] Failed to parse WebSocket message:", err);
            }
        };

        ws.onclose = () => {
            console.log("[LiveSync] WebSocket closed");
            setWsConnected(false);
        };

        ws.onerror = (err) => {
            console.error("[LiveSync] WebSocket error:", err);
        };

        wsRef.current = ws;
        return () => ws.close();
    }, [syncMode, collection]);

    // ========== ADD TODO ==========
    const addTodo = async (text: string) => {
        const newTodo: TodoInput = {
            id: crypto.randomUUID(),
            text,
            completed: 0,
            user_id: "demo-user",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        console.log("[LiveSync] Creating todo optimistically...", { backend, syncMode });

        // Insert with SQLite types (number for completed, string for dates)
        collection.insert({
            id: newTodo.id,
            text: newTodo.text,
            completed: newTodo.completed, // 0 or 1 (number)
            user_id: newTodo.user_id,
            created_at: newTodo.created_at, // ISO string
            updated_at: newTodo.updated_at, // ISO string
        });

        if (syncMode === "websocket-only") {
            await createTodo({ data: { todo: newTodo, backend } });
            wsRef.current?.send(
                JSON.stringify({ type: "TODO_CREATED", todo: newTodo, backend })
            );
            console.log("[LiveSync] Saved to server + broadcasted via WebSocket");
        } else if (syncMode === "integrated") {
            await syncToServer();
            wsRef.current?.send(
                JSON.stringify({ type: "TODO_CREATED", todo: newTodo, backend })
            );
            console.log("[LiveSync] Synced via PowerSync + WebSocket");
        } else {
            await syncToServer();
            console.log("[LiveSync] Synced via PowerSync only");
        }
    };

    // ========== TOGGLE COMPLETED ==========
    const toggleTodo = async (id: string, completed: boolean) => {
        console.log("[LiveSync] Toggling todo:", id);
        collection.update(id, (draft: Todo) => {
            draft.completed = !completed;
            draft.updated_at = new Date();
        });
        await syncToServer();
    };

    // ========== DELETE TODO ==========
    const deleteTodoLocal = async (id: string) => {
        console.log("[LiveSync] Deleting todo:", id);
        collection.delete(id);
        await syncToServer();

        if (syncMode !== "powersync-only" && wsRef.current) {
            wsRef.current.send(JSON.stringify({ type: "TODO_DELETED", todoId: id }));
        }
    };

    // ========== LOAD FROM SERVER ==========
    const loadFromServer = async () => {
        console.log("[LiveSync] Loading from server with backend:", backend);
        try {
            const serverTodos = await getTodos({
                data: { userId: "demo-user", backend },
            });
            console.log("[LiveSync] Loaded", serverTodos.length, "todos from server");

            for (const todo of serverTodos) {
                // Insert with SQLite types
                collection.insert({
                    id: todo.id,
                    text: todo.text,
                    completed: todo.completed, // Already number from server
                    user_id: todo.user_id,
                    created_at: todo.created_at, // Already ISO string
                    updated_at: todo.updated_at,
                });
            }
        } catch (err) {
            console.error("[LiveSync] Failed to load from server:", err);
        }
    };

    // ========== CLEAR LOCAL ==========
    const clearLocal = () => {
        console.log("[LiveSync] Clearing local todos...");
        for (const todo of userTodos) {
            collection.delete(todo.id);
        }
    };

    const backendIcons: Record<DbBackend, typeof Cloud> = {
        "drizzle-neon": Cloud,
        "neon-raw": Server,
    };

    const BackendIcon = backendIcons[backend];

    return (
        <DashboardLayout title="Live Sync Example" description="Offline-first data synchronization demo">
            <div className="space-y-6">
                {/* Architecture Flow Card */}
                <Card className="border-primary/20 bg-card/50">
                    <CardHeader className="pb-3">
                        <div className="flex items-center gap-2">
                            <Zap className="h-4 w-4 text-primary" />
                            <CardTitle className="text-sm font-mono">Architecture Flow</CardTitle>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <pre className="text-xs text-muted-foreground font-mono overflow-x-auto">
{`Client: collection.insert() → PowerSync SQLite → useLiveQuery() → UI
   ↓
Server: syncToServer() → connector.uploadData() → ${backend}`}
                        </pre>
                    </CardContent>
                </Card>

                {/* Settings Panel */}
                <Card className="border-border/50">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm">Configuration</CardTitle>
                        <CardDescription className="text-xs">Switch between database backends and sync modes</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Database Backend */}
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                Database Backend
                            </label>
                            <div className="flex flex-wrap gap-2">
                                {(["drizzle-neon", "neon-raw"] as DbBackend[]).map((b) => {
                                    const Icon = backendIcons[b];
                                    return (
                                        <Button
                                            key={b}
                                            variant={backend === b ? "default" : "outline"}
                                            size="sm"
                                            onClick={() => setBackend(b)}
                                            className={cn(
                                                "gap-2 transition-all",
                                                backend === b && "bg-primary text-primary-foreground shadow-[0_0_12px_rgba(251,146,60,0.3)]"
                                            )}
                                        >
                                            <Icon className="h-3.5 w-3.5" />
                                            {b === "drizzle-neon" ? "Drizzle + Neon" : "Neon Raw SQL"}
                                        </Button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Sync Mode */}
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                Sync Mode
                            </label>
                            <div className="flex flex-wrap gap-2">
                                {(["powersync-only", "websocket-only", "integrated"] as const).map((m) => (
                                    <Button
                                        key={m}
                                        variant={syncMode === m ? "default" : "outline"}
                                        size="sm"
                                        onClick={() => setSyncMode(m)}
                                        className={cn(
                                            "gap-2 transition-all",
                                            syncMode === m && "bg-secondary text-secondary-foreground shadow-[0_0_12px_rgba(34,211,238,0.3)]"
                                        )}
                                    >
                                        {m === "powersync-only" ? (
                                            <>
                                                <Database className="h-3.5 w-3.5" />
                                                PowerSync
                                            </>
                                        ) : m === "websocket-only" ? (
                                            <>
                                                <Wifi className="h-3.5 w-3.5" />
                                                WebSocket
                                            </>
                                        ) : (
                                            <>
                                                <Zap className="h-3.5 w-3.5" />
                                                Integrated
                                            </>
                                        )}
                                    </Button>
                                ))}
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
                            <Button variant="outline" size="sm" onClick={loadFromServer} className="gap-2">
                                <RefreshCw className="h-3.5 w-3.5" />
                                Load from Server
                            </Button>
                            <Button variant="outline" size="sm" onClick={clearLocal} className="gap-2 text-destructive hover:text-destructive">
                                <Trash2 className="h-3.5 w-3.5" />
                                Clear Local
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Status Bar */}
                <div className="flex flex-wrap items-center gap-3 text-xs">
                    <Badge variant="outline" className="gap-1.5 font-mono">
                        <span className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            String(status) === "success" ? "bg-emerald-400" : "bg-yellow-400"
                        )} />
                        {String(status)}
                    </Badge>
                    <Badge variant="outline" className="gap-1.5 font-mono">
                        <BackendIcon className="h-3 w-3" />
                        {backend}
                    </Badge>
                    <Badge variant="outline" className="gap-1.5 font-mono">
                        {syncMode === "powersync-only" ? (
                            <Database className="h-3 w-3" />
                        ) : (
                            <Wifi className="h-3 w-3" />
                        )}
                        {syncMode}
                    </Badge>
                    <Badge variant="outline" className="font-mono">
                        {userTodos.length} todo{userTodos.length !== 1 ? "s" : ""}
                    </Badge>
                    {syncMode !== "powersync-only" && (
                        <Badge
                            variant="outline"
                            className={cn(
                                "gap-1.5 font-mono",
                                wsConnected ? "border-emerald-500/30 text-emerald-400" : "border-destructive/30 text-destructive"
                            )}
                        >
                            {wsConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                            {wsConnected ? "connected" : "disconnected"}
                        </Badge>
                    )}
                </div>

                {/* Add Todo Form */}
                <AddTodoForm onAdd={addTodo} />

                {/* Todo List */}
                <Card className="border-border/50">
                    <CardContent className="p-0">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-6 w-6 text-primary animate-spin" />
                            </div>
                        ) : userTodos.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 text-center">
                                <Database className="h-10 w-10 text-muted-foreground/30 mb-3" />
                                <p className="text-sm text-muted-foreground">No todos yet</p>
                                <p className="text-xs text-muted-foreground/60">Add one above or load from server</p>
                            </div>
                        ) : (
                            <ul className="divide-y divide-border/50">
                                {userTodos.map((todo) => (
                                    <li
                                        key={todo.id}
                                        className="flex items-center gap-3 p-4 hover:bg-muted/20 transition-colors group"
                                    >
                                        <button
                                            type="button"
                                            onClick={() => toggleTodo(todo.id, todo.completed)}
                                            className={cn(
                                                "flex-shrink-0 h-5 w-5 rounded border-2 transition-all flex items-center justify-center",
                                                todo.completed
                                                    ? "bg-primary border-primary"
                                                    : "border-muted-foreground/30 hover:border-primary/50"
                                            )}
                                        >
                                            {todo.completed && <Check className="h-3 w-3 text-primary-foreground" />}
                                        </button>
                                        <span
                                            className={cn(
                                                "flex-1 text-sm transition-all",
                                                todo.completed && "line-through text-muted-foreground/50"
                                            )}
                                        >
                                            {todo.text}
                                        </span>
                                        <code className="text-[10px] text-muted-foreground/40 font-mono hidden sm:block">
                                            {todo.id.slice(0, 8)}
                                        </code>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => deleteTodoLocal(todo.id)}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive h-8 w-8 p-0"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>

                {/* Info Cards */}
                <div className="grid md:grid-cols-3 gap-4">
                    <Card className="border-primary/20 bg-primary/5">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Database className="h-4 w-4 text-primary" />
                                PowerSync Only
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-xs text-muted-foreground">
                                Local SQLite in browser → PowerSync connector → Server function → Your database.
                                Cross-tab sync is automatic via BroadcastChannel.
                            </p>
                        </CardContent>
                    </Card>

                    <Card className="border-secondary/20 bg-secondary/5">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Wifi className="h-4 w-4 text-secondary" />
                                WebSocket Only
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-xs text-muted-foreground">
                                Direct server save + WebSocket broadcast to other clients.
                                Good for real-time collaboration across devices.
                            </p>
                        </CardContent>
                    </Card>

                    <Card className="border-emerald-500/20 bg-emerald-500/5">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Zap className="h-4 w-4 text-emerald-400" />
                                Integrated
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-xs text-muted-foreground">
                                Both PowerSync and WebSocket together. PowerSync for offline-first +
                                conflict resolution, WebSocket for instant cross-device updates.
                            </p>
                        </CardContent>
                    </Card>
                </div>

                {/* Console hint */}
                <div className="p-4 rounded-lg bg-muted/30 border border-border/50 font-mono text-xs space-y-1">
                    <p className="text-primary">// Open DevTools Console to see [LiveSync] logs</p>
                    <p className="text-muted-foreground">// Try opening this page in another tab and adding todos!</p>
                </div>
            </div>
        </DashboardLayout>
    );
}

function AddTodoForm({ onAdd }: { onAdd: (text: string) => void }) {
    const [text, setText] = useState("");
    const [isAdding, setIsAdding] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!text.trim()) return;

        setIsAdding(true);
        Promise.resolve(onAdd(text)).finally(() => {
            setText("");
            setIsAdding(false);
        });
    };

    return (
        <form onSubmit={handleSubmit} className="flex gap-2">
            <Input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Add a todo..."
                className="flex-1 bg-input border-border/50 focus:border-primary/50 focus:ring-primary/20"
                disabled={isAdding}
            />
            <Button
                type="submit"
                disabled={isAdding || !text.trim()}
                className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_12px_rgba(251,146,60,0.2)]"
            >
                {isAdding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                    <Plus className="h-4 w-4" />
                )}
                Add
            </Button>
        </form>
    );
}
