import { Link, useLocation } from "@tanstack/react-router";
import { BarChart3, MessageSquare, Terminal } from "lucide-react";

export default function Header() {
	const location = useLocation();

	const navItems = [
		{ to: "/", label: "SESSIONS", icon: MessageSquare },
		{ to: "/stats", label: "ANALYTICS", icon: BarChart3 },
	] as const;

	return (
		<header className="sticky top-0 z-40 glass-card border-b border-amber-500/20">
			<div className="max-w-6xl mx-auto px-6">
				<div className="flex h-12 items-center justify-between">
					{/* Logo */}
					<Link to="/" className="flex items-center gap-2 group">
						<div className="p-1 rounded bg-amber-500/10 border border-amber-500/30 group-hover:neon-glow transition-all">
							<Terminal className="w-4 h-4 text-amber-400" />
						</div>
						<span className="font-mono font-bold text-sm text-gray-300 tracking-wider group-hover:text-amber-400 transition-colors">
							CLAUDE<span className="text-amber-500">::</span>HISTORY
						</span>
					</Link>

					{/* Navigation */}
					<nav className="flex items-center gap-1">
						{navItems.map(({ to, label, icon: Icon }) => {
							const isActive = location.pathname === to;
							return (
								<Link
									key={to}
									to={to}
									className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono tracking-wider transition-all ${
										isActive
											? "bg-amber-500/10 text-amber-400 border border-amber-500/30 neon-glow"
											: "text-gray-500 hover:text-gray-300 hover:bg-white/5"
									}`}
								>
									<Icon className="w-3.5 h-3.5" />
									{label}
								</Link>
							);
						})}
					</nav>
				</div>
			</div>
		</header>
	);
}
