import { Link } from "@tanstack/react-router";
import { BarChart3, Home, Search, Terminal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectNode } from "./ProjectNode";
import { useSidebarData } from "./use-sidebar-data";

export function Sidebar() {
	const { projects, search, setSearch, isLoading } = useSidebarData();

	return (
		<aside
			className={
				"fixed left-0 top-0 bottom-0 w-72 z-40 flex flex-col " +
				"bg-[rgba(8,8,16,0.95)] backdrop-blur-xl " +
				"border-r border-amber-500/15"
			}
		>
			{/* Header */}
			<div className="p-4 border-b border-amber-500/10">
				<Link to="/" className="flex items-center gap-2">
					<Terminal className="w-4 h-4 text-amber-400" />
					<span
						className={
							"font-mono font-bold text-sm tracking-wider " +
							"bg-gradient-to-r from-amber-400 via-yellow-300 to-cyan-400 " +
							"bg-clip-text text-transparent"
						}
					>
						CLAUDE::HISTORY
					</span>
				</Link>
			</div>

			{/* Search */}
			<div className="px-3 py-2.5">
				<div className="relative">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40" />
					<Input
						placeholder="Search sessions..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className={
							"pl-8 h-8 text-xs bg-black/40 border-amber-500/15 " +
							"focus:border-amber-500/40 placeholder:text-muted-foreground/30"
						}
					/>
				</div>
			</div>

			{/* Tree */}
			<ScrollArea className="flex-1 px-1">
				{isLoading ? (
					<div className="p-4 text-xs text-muted-foreground/40 font-mono text-center">Loading sessions...</div>
				) : projects.length === 0 ? (
					<div className="p-4 text-xs text-muted-foreground/40 font-mono text-center">No sessions found</div>
				) : (
					projects.map((project) => <ProjectNode key={project.name} group={project} />)
				)}
			</ScrollArea>

			{/* Footer */}
			<div className="p-3 border-t border-amber-500/10 space-y-0.5">
				<Link
					to="/"
					className={
						"flex items-center gap-2.5 px-3 py-2 rounded-md " +
						"text-xs font-mono text-muted-foreground/50 " +
						"hover:bg-amber-500/5 hover:text-muted-foreground transition-colors"
					}
				>
					<Home className="w-3.5 h-3.5" />
					All Sessions
				</Link>
				<Link
					to="/stats"
					className={
						"flex items-center gap-2.5 px-3 py-2 rounded-md " +
						"text-xs font-mono text-muted-foreground/50 " +
						"hover:bg-amber-500/5 hover:text-muted-foreground transition-colors"
					}
				>
					<BarChart3 className="w-3.5 h-3.5" />
					Analytics
				</Link>
			</div>
		</aside>
	);
}
