import { Link, useParams } from "@tanstack/react-router";
import { Bot, ChevronRight, FolderOpen, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SidebarSession } from "@/server/serializers";
import type { ProjectGroup } from "./types";

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);

	if (mins < 60) {
		return `${mins}m ago`;
	}

	const hours = Math.floor(mins / 60);

	if (hours < 24) {
		return `${hours}h ago`;
	}

	const days = Math.floor(hours / 24);

	if (days < 7) {
		return `${days}d ago`;
	}

	return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function SessionNode({ session }: { session: SidebarSession }) {
	const { id } = useParams({ strict: false });
	const isActive = id === session.sessionId;
	const label = session.customTitle || session.summary?.slice(0, 60) || session.sessionId.slice(0, 8);

	return (
		<Link
			to="/conversation/$id"
			params={{ id: session.sessionId }}
			className={cn(
				"flex items-start gap-2 pl-8 pr-3 py-1.5 rounded-sm transition-colors",
				"hover:bg-white/[0.03]",
				isActive && "bg-amber-500/10 border-l-2 border-l-amber-500 text-amber-400"
			)}
		>
			<MessageSquare className="w-3 h-3 mt-0.5 shrink-0 text-amber-500/40" />
			<div className="min-w-0 flex-1">
				<p className={cn("text-xs font-mono truncate", isActive ? "text-amber-400" : "text-muted-foreground/70")}>
					{label}
				</p>
				<span className="text-[10px] font-mono text-muted-foreground/40" suppressHydrationWarning>
					{relativeTime(session.timestamp)}
				</span>
			</div>
		</Link>
	);
}

function SubagentNode({ session }: { session: SidebarSession }) {
	const { id } = useParams({ strict: false });
	const isActive = id === session.sessionId;
	const label = session.customTitle || session.summary?.slice(0, 60) || session.sessionId.slice(0, 8);

	return (
		<Link
			to="/conversation/$id"
			params={{ id: session.sessionId }}
			className={cn(
				"flex items-start gap-2 pl-12 pr-3 py-1.5 rounded-sm transition-colors",
				"hover:bg-white/[0.03]",
				isActive && "bg-purple-500/10 border-l-2 border-l-purple-400 text-purple-400"
			)}
		>
			<Bot className="w-3 h-3 mt-0.5 shrink-0 text-purple-400/50" />
			<div className="min-w-0 flex-1">
				<p className={cn("text-xs font-mono truncate", isActive ? "text-purple-400" : "text-purple-400/60")}>{label}</p>
				<span className="text-[10px] font-mono text-muted-foreground/40" suppressHydrationWarning>
					{relativeTime(session.timestamp)}
				</span>
			</div>
		</Link>
	);
}

export function ProjectNode({ group }: { group: ProjectGroup }) {
	const { id } = useParams({ strict: false });
	const containsActive =
		group.sessions.some((s) => s.sessionId === id) || group.subagents.some((s) => s.sessionId === id);

	const [open, setOpen] = useState(containsActive);

	useEffect(() => {
		if (containsActive && !open) {
			setOpen(true);
		}
	}, [containsActive]);

	return (
		<div className="mb-0.5">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={cn(
					"flex items-center gap-2 w-full px-3 py-1.5 rounded-sm text-left transition-colors",
					"hover:bg-white/[0.03]",
					open && "bg-white/[0.02]"
				)}
			>
				<ChevronRight
					className={cn(
						"w-3 h-3 text-muted-foreground/40 shrink-0 transition-transform duration-200",
						open && "rotate-90"
					)}
				/>
				<FolderOpen className="w-3.5 h-3.5 text-amber-400/70 shrink-0" />
				<span className="font-mono text-xs text-muted-foreground/70 truncate flex-1">{group.name}</span>
				<Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono shrink-0">
					{group.totalCount}
				</Badge>
			</button>

			<div
				className={cn(
					"overflow-hidden transition-all duration-200 ease-in-out",
					open ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"
				)}
			>
				<div className="py-0.5">
					{group.sessions.map((s) => (
						<SessionNode key={s.sessionId} session={s} />
					))}
					{group.subagents.map((s) => (
						<SubagentNode key={s.sessionId} session={s} />
					))}
				</div>
			</div>
		</div>
	);
}
