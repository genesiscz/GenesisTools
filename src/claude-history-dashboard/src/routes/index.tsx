import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Calendar, Cpu, GitBranch, MessageSquare, Search, Zap } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getConversations } from "@/server/conversations";

export const Route = createFileRoute("/")({
	component: IndexPage,
	loader: () => getConversations({ data: { limit: 100 } }),
});

function IndexPage() {
	const conversations = Route.useLoaderData();
	const [search, setSearch] = useState("");

	const filteredConversations = conversations.filter((conv) => {
		if (!search) return true;
		const searchLower = search.toLowerCase();
		return (
			conv.project.toLowerCase().includes(searchLower) ||
			conv.summary?.toLowerCase().includes(searchLower) ||
			conv.customTitle?.toLowerCase().includes(searchLower) ||
			conv.gitBranch?.toLowerCase().includes(searchLower)
		);
	});

	return (
		<div className="min-h-screen bg-[#050508] cyber-grid relative overflow-hidden">
			{/* Ambient glow effects */}
			<div className="fixed top-0 left-1/4 w-96 h-96 bg-amber-500/10 rounded-full blur-[120px] pointer-events-none" />
			<div className="fixed bottom-0 right-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-[120px] pointer-events-none" />

			{/* Scan lines overlay */}
			<div className="fixed inset-0 scan-lines opacity-30 pointer-events-none z-50" />

			{/* Hero Section */}
			<section className="relative py-16 px-6 border-b border-amber-500/20">
				<div className="max-w-6xl mx-auto">
					{/* Hero Card */}
					<Card className="glass-card neon-border border-amber-500/20 bg-transparent mb-8">
						<CardHeader className="flex-row items-center gap-5 space-y-0">
							<div className="relative">
								<div className="absolute inset-0 bg-amber-500/30 rounded-2xl blur-xl animate-pulse-glow" />
								<div className="relative p-4 rounded-2xl glass-card neon-border tech-corner">
									<Cpu className="w-10 h-10 text-amber-400" />
								</div>
							</div>
							<div>
								<CardTitle className="text-4xl font-black tracking-tight gradient-text">
									CLAUDE HISTORY
								</CardTitle>
								<CardDescription className="text-gray-400 font-light tracking-wide mt-1">
									Neural conversation archive // All projects
								</CardDescription>
							</div>
						</CardHeader>
					</Card>

					{/* Search Input */}
					<div className="relative max-w-2xl">
						<div className="absolute inset-0 bg-amber-500/5 rounded-xl blur-md" />
						<div className="relative flex items-center gap-2">
							<div className="relative flex-1">
								<Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-amber-500/60" />
								<Input
									type="text"
									placeholder="Search neural archives..."
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									className="pl-12 h-14 glass-card neon-border bg-transparent border-amber-500/30 text-gray-200 placeholder:text-gray-600 font-mono text-sm focus-visible:ring-amber-500/30 focus-visible:border-amber-500/50"
								/>
							</div>
							<Badge
								variant="outline"
								className="h-14 px-4 glass-card border-amber-500/30 text-amber-500/60 font-mono text-xs"
							>
								{filteredConversations.length} RECORDS
							</Badge>
						</div>
					</div>
				</div>
			</section>

			{/* Conversations List */}
			<section className="py-8 px-6 max-w-6xl mx-auto relative z-10">
				<div className="flex items-center justify-between mb-6">
					<div className="flex items-center gap-3">
						<div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
						<span className="text-xs font-mono text-amber-500/80 tracking-wider">ACTIVE SESSIONS</span>
					</div>
					<Button
						variant="ghost"
						size="sm"
						asChild
						className="text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
					>
						<Link to="/stats" className="flex items-center gap-2 font-mono text-xs">
							<Zap className="w-3 h-3" />
							VIEW ANALYTICS
							<ArrowRight className="w-3 h-3" />
						</Link>
					</Button>
				</div>

				<ScrollArea className="h-[calc(100vh-400px)] pr-4">
					<div className="space-y-3">
						{filteredConversations.map((conv, idx) => (
							<Link
								key={conv.sessionId}
								to="/conversation/$id"
								params={{ id: conv.sessionId }}
								className="block animate-fade-in-up"
								style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
							>
								<Card className="group glass-card border-amber-500/10 hover:border-amber-500/30 bg-transparent transition-all duration-300 hover:scale-[1.005] overflow-hidden">
									{/* Left accent bar */}
									<div
										className={`absolute left-0 top-0 bottom-0 w-1 ${conv.isSubagent ? "bg-cyan-500" : "bg-amber-500"} opacity-60 group-hover:opacity-100 transition-opacity`}
									/>

									{/* Hover glow */}
									<div className="absolute inset-0 bg-gradient-to-r from-amber-500/0 via-amber-500/5 to-cyan-500/0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

									<CardHeader className="pb-2 pl-5">
										<div className="flex items-start justify-between gap-4">
											<div className="flex-1 min-w-0">
												<CardTitle className="text-base text-gray-100 font-medium truncate group-hover:text-amber-200 transition-colors">
													{conv.customTitle || conv.summary?.slice(0, 70) || (
														<span className="font-mono text-sm text-gray-500">
															{conv.sessionId.slice(0, 8)}...
														</span>
													)}
												</CardTitle>
												{conv.summary && conv.customTitle && (
													<CardDescription className="text-gray-500 mt-1 line-clamp-1 font-light">
														{conv.summary}
													</CardDescription>
												)}
											</div>
											<div className="flex gap-2 flex-shrink-0">
												<Badge
													variant="outline"
													className="bg-cyan-500/10 text-cyan-400 border-cyan-500/30 font-mono text-[10px] tracking-wider"
												>
													{conv.project}
												</Badge>
												{conv.isSubagent && (
													<Badge
														variant="outline"
														className="bg-amber-500/10 text-amber-400 border-amber-500/30 font-mono text-[10px] tracking-wider animate-pulse-glow"
													>
														AGENT
													</Badge>
												)}
											</div>
										</div>
									</CardHeader>

									<CardContent className="pt-0 pl-5">
										<div className="flex items-center gap-5 text-[11px] text-gray-500 font-mono">
											<span className="flex items-center gap-1.5">
												<MessageSquare className="w-3 h-3 text-amber-500/50" />
												{conv.messageCount}
											</span>
											{conv.gitBranch && (
												<span className="flex items-center gap-1.5">
													<GitBranch className="w-3 h-3 text-cyan-500/50" />
													<span className="text-cyan-400/70">{conv.gitBranch}</span>
												</span>
											)}
											<span className="flex items-center gap-1.5 ml-auto">
												<Calendar className="w-3 h-3" />
												{new Date(conv.timestamp).toLocaleDateString("en-US", {
													month: "short",
													day: "numeric",
													hour: "2-digit",
													minute: "2-digit",
												})}
											</span>
										</div>
									</CardContent>
								</Card>
							</Link>
						))}
					</div>
				</ScrollArea>
			</section>
		</div>
	);
}
