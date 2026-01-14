#!/usr/bin/env bun
/**
 * Claude History Dashboard - Web-based SPA for browsing conversation history
 * Run: bun run src/claude-history/dashboard.tsx
 */

import { serve } from "bun";
import { program } from "commander";
import chalk from "chalk";
import {
	getAllConversations,
	searchConversations,
	getConversationBySessionId,
	getConversationStats,
	getAvailableProjects,
	type SearchResult,
	type ConversationMessage,
	type AssistantMessage,
	type UserMessage,
	type TextBlock,
	type ToolUseBlock,
} from "./lib";

const DEFAULT_PORT = 3847;

// =============================================================================
// API Handlers
// =============================================================================

interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: string;
}

async function handleApiRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	try {
		// GET /api/conversations - List all conversations
		if (path === "/api/conversations" && request.method === "GET") {
			const project = url.searchParams.get("project") || undefined;
			const limit = parseInt(url.searchParams.get("limit") || "50", 10);
			const query = url.searchParams.get("q") || undefined;
			const tool = url.searchParams.get("tool") || undefined;
			const since = url.searchParams.get("since");

			let results: SearchResult[];
			if (query || tool) {
				results = await searchConversations({
					project,
					query,
					tool,
					limit,
					since: since ? new Date(since) : undefined,
				});
			} else {
				results = await getAllConversations({ project, limit });
			}

			// Transform results to lighter format for listing
			const conversations = results.map((r) => ({
				sessionId: r.sessionId,
				project: r.project,
				timestamp: r.timestamp.toISOString(),
				summary: r.summary,
				customTitle: r.customTitle,
				gitBranch: r.gitBranch,
				messageCount: r.matchedMessages.length,
				isSubagent: r.isSubagent,
				filePath: r.filePath,
			}));

			return jsonResponse({ success: true, data: conversations });
		}

		// GET /api/conversations/:sessionId - Get single conversation
		if (path.startsWith("/api/conversations/") && request.method === "GET") {
			const sessionId = path.replace("/api/conversations/", "");
			const result = await getConversationBySessionId(sessionId);

			if (!result) {
				return jsonResponse({ success: false, error: "Conversation not found" }, 404);
			}

			// Format messages for display
			const messages = result.matchedMessages.map((msg) => formatMessageForApi(msg));

			return jsonResponse({
				success: true,
				data: {
					sessionId: result.sessionId,
					project: result.project,
					timestamp: result.timestamp.toISOString(),
					summary: result.summary,
					customTitle: result.customTitle,
					gitBranch: result.gitBranch,
					isSubagent: result.isSubagent,
					filePath: result.filePath,
					messages,
				},
			});
		}

		// GET /api/stats - Get statistics
		if (path === "/api/stats" && request.method === "GET") {
			const stats = await getConversationStats();
			return jsonResponse({ success: true, data: stats });
		}

		// GET /api/projects - Get available projects
		if (path === "/api/projects" && request.method === "GET") {
			const projects = await getAvailableProjects();
			return jsonResponse({ success: true, data: projects });
		}

		return jsonResponse({ success: false, error: "Not found" }, 404);
	} catch (error) {
		console.error("API Error:", error);
		return jsonResponse({ success: false, error: String(error) }, 500);
	}
}

function formatMessageForApi(msg: ConversationMessage): Record<string, unknown> {
	const base = {
		type: msg.type,
		uuid: "uuid" in msg ? msg.uuid : undefined,
		timestamp: "timestamp" in msg ? msg.timestamp : undefined,
	};

	if (msg.type === "user") {
		const userMsg = msg as UserMessage;
		let content = "";
		if (typeof userMsg.message.content === "string") {
			content = userMsg.message.content;
		} else if (Array.isArray(userMsg.message.content)) {
			const textBlocks = userMsg.message.content
				.filter((b): b is TextBlock => b.type === "text")
				.map((b) => b.text);
			content = textBlocks.join("\n");
		}
		return { ...base, content };
	}

	if (msg.type === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const textBlocks = assistantMsg.message.content
			.filter((b): b is TextBlock => b.type === "text")
			.map((b) => b.text);
		const toolUses = assistantMsg.message.content
			.filter((b): b is ToolUseBlock => b.type === "tool_use")
			.map((t) => ({
				name: t.name,
				input: t.input,
			}));

		return {
			...base,
			content: textBlocks.join("\n"),
			toolUses,
			model: assistantMsg.message.model,
		};
	}

	return base;
}

function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

// =============================================================================
// HTML/SPA Rendering
// =============================================================================

function renderHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Claude History Dashboard</title>
	<script src="https://cdn.tailwindcss.com"></script>
	<script>
		tailwind.config = {
			darkMode: 'class',
			theme: {
				extend: {
					colors: {
						claude: {
							orange: '#da7756',
							tan: '#d4a27f',
							cream: '#f5e6d3',
							dark: '#1a1a1a',
							darker: '#0d0d0d',
						}
					}
				}
			}
		}
	</script>
	<style>
		@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

		body {
			font-family: 'Inter', system-ui, sans-serif;
		}

		.font-mono {
			font-family: 'JetBrains Mono', monospace;
		}

		.message-content {
			white-space: pre-wrap;
			word-break: break-word;
		}

		.tool-badge {
			font-size: 0.65rem;
			padding: 0.15rem 0.4rem;
		}

		.scrollbar-thin::-webkit-scrollbar {
			width: 6px;
			height: 6px;
		}

		.scrollbar-thin::-webkit-scrollbar-track {
			background: rgba(255, 255, 255, 0.05);
		}

		.scrollbar-thin::-webkit-scrollbar-thumb {
			background: rgba(255, 255, 255, 0.2);
			border-radius: 3px;
		}

		.scrollbar-thin::-webkit-scrollbar-thumb:hover {
			background: rgba(255, 255, 255, 0.3);
		}

		.fade-in {
			animation: fadeIn 0.2s ease-in-out;
		}

		@keyframes fadeIn {
			from { opacity: 0; transform: translateY(4px); }
			to { opacity: 1; transform: translateY(0); }
		}

		.pulse-loading {
			animation: pulse 1.5s ease-in-out infinite;
		}

		@keyframes pulse {
			0%, 100% { opacity: 0.4; }
			50% { opacity: 1; }
		}
	</style>
</head>
<body class="bg-claude-darker text-gray-100 min-h-screen">
	<div id="root"></div>

	<script type="module">
		// State management
		const state = {
			conversations: [],
			selectedConversation: null,
			selectedMessages: [],
			projects: [],
			stats: null,
			filters: {
				project: '',
				query: '',
				tool: '',
			},
			loading: false,
			error: null,
			view: 'list', // 'list' | 'detail' | 'stats'
		};

		// Tools with their colors
		const toolColors = {
			Edit: 'bg-yellow-600',
			Write: 'bg-green-600',
			Read: 'bg-blue-600',
			Bash: 'bg-purple-600',
			Grep: 'bg-pink-600',
			Glob: 'bg-cyan-600',
			Task: 'bg-orange-600',
			TodoWrite: 'bg-red-600',
			LSP: 'bg-indigo-600',
			WebFetch: 'bg-emerald-600',
			WebSearch: 'bg-teal-600',
		};

		// API functions
		async function fetchConversations() {
			state.loading = true;
			render();

			try {
				const params = new URLSearchParams();
				if (state.filters.project) params.set('project', state.filters.project);
				if (state.filters.query) params.set('q', state.filters.query);
				if (state.filters.tool) params.set('tool', state.filters.tool);
				params.set('limit', '100');

				const res = await fetch('/api/conversations?' + params.toString());
				const json = await res.json();

				if (json.success) {
					state.conversations = json.data;
					state.error = null;
				} else {
					state.error = json.error;
				}
			} catch (e) {
				state.error = e.message;
			}

			state.loading = false;
			render();
		}

		async function fetchConversation(sessionId) {
			state.loading = true;
			render();

			try {
				const res = await fetch('/api/conversations/' + encodeURIComponent(sessionId));
				const json = await res.json();

				if (json.success) {
					state.selectedConversation = json.data;
					state.selectedMessages = json.data.messages;
					state.view = 'detail';
					state.error = null;
				} else {
					state.error = json.error;
				}
			} catch (e) {
				state.error = e.message;
			}

			state.loading = false;
			render();
		}

		async function fetchProjects() {
			try {
				const res = await fetch('/api/projects');
				const json = await res.json();
				if (json.success) {
					state.projects = json.data;
				}
			} catch (e) {
				console.error('Failed to fetch projects:', e);
			}
			render();
		}

		async function fetchStats() {
			state.loading = true;
			state.view = 'stats';
			render();

			try {
				const res = await fetch('/api/stats');
				const json = await res.json();
				if (json.success) {
					state.stats = json.data;
				}
			} catch (e) {
				state.error = e.message;
			}

			state.loading = false;
			render();
		}

		// Render functions
		function render() {
			const root = document.getElementById('root');
			root.innerHTML = renderApp();
			attachEventListeners();
		}

		function renderApp() {
			return \`
				<div class="flex flex-col h-screen">
					\${renderHeader()}
					<div class="flex flex-1 overflow-hidden">
						\${renderSidebar()}
						<main class="flex-1 overflow-auto scrollbar-thin p-6">
							\${state.loading ? renderLoading() : ''}
							\${state.error ? renderError() : ''}
							\${!state.loading && !state.error ? renderContent() : ''}
						</main>
					</div>
				</div>
			\`;
		}

		function renderHeader() {
			return \`
				<header class="bg-claude-dark border-b border-gray-800 px-6 py-4">
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-4">
							<h1 class="text-xl font-semibold text-claude-orange">Claude History</h1>
							<nav class="flex gap-2">
								<button onclick="navigateTo('list')"
									class="px-3 py-1.5 rounded-md text-sm \${state.view === 'list' ? 'bg-claude-orange text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">
									Conversations
								</button>
								<button onclick="navigateTo('stats')"
									class="px-3 py-1.5 rounded-md text-sm \${state.view === 'stats' ? 'bg-claude-orange text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}">
									Statistics
								</button>
							</nav>
						</div>
						<div class="flex items-center gap-3">
							<input type="text"
								id="searchInput"
								placeholder="Search conversations..."
								value="\${state.filters.query}"
								class="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm w-64 focus:outline-none focus:border-claude-orange"
							/>
							<select id="projectFilter"
								class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-claude-orange">
								<option value="">All Projects</option>
								\${state.projects.map(p => \`<option value="\${p}" \${state.filters.project === p ? 'selected' : ''}>\${p}</option>\`).join('')}
							</select>
							<select id="toolFilter"
								class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-claude-orange">
								<option value="">All Tools</option>
								\${Object.keys(toolColors).map(t => \`<option value="\${t}" \${state.filters.tool === t ? 'selected' : ''}>\${t}</option>\`).join('')}
							</select>
						</div>
					</div>
				</header>
			\`;
		}

		function renderSidebar() {
			if (state.view !== 'detail') return '';

			const conv = state.selectedConversation;
			if (!conv) return '';

			return \`
				<aside class="w-80 bg-claude-dark border-r border-gray-800 overflow-auto scrollbar-thin">
					<div class="p-4 border-b border-gray-800">
						<button onclick="navigateTo('list')" class="text-gray-400 hover:text-white text-sm mb-3 flex items-center gap-1">
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
							</svg>
							Back to list
						</button>
						<h2 class="font-medium text-white truncate">\${conv.customTitle || conv.summary || conv.sessionId}</h2>
						<div class="text-xs text-gray-500 mt-2 space-y-1">
							<div><span class="text-gray-400">Project:</span> \${conv.project}</div>
							<div><span class="text-gray-400">Date:</span> \${formatDate(conv.timestamp)}</div>
							\${conv.gitBranch ? \`<div><span class="text-gray-400">Branch:</span> \${conv.gitBranch}</div>\` : ''}
							<div><span class="text-gray-400">Messages:</span> \${conv.messages?.length || 0}</div>
						</div>
					</div>
					<div class="p-4">
						<h3 class="text-xs font-medium text-gray-500 uppercase mb-2">Message Index</h3>
						<div class="space-y-1">
							\${(state.selectedMessages || []).slice(0, 50).map((msg, i) => \`
								<button onclick="scrollToMessage(\${i})"
									class="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-gray-800 truncate \${msg.type === 'user' ? 'text-blue-400' : 'text-green-400'}">
									\${i + 1}. \${msg.type === 'user' ? 'User' : 'Assistant'}: \${truncate(msg.content, 40)}
								</button>
							\`).join('')}
							\${(state.selectedMessages || []).length > 50 ? \`<div class="text-xs text-gray-500 px-2 py-1">+ \${state.selectedMessages.length - 50} more messages</div>\` : ''}
						</div>
					</div>
				</aside>
			\`;
		}

		function renderContent() {
			if (state.view === 'stats') return renderStats();
			if (state.view === 'detail') return renderConversationDetail();
			return renderConversationList();
		}

		function renderConversationList() {
			if (state.conversations.length === 0) {
				return \`
					<div class="flex flex-col items-center justify-center h-64 text-gray-500">
						<svg class="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
								d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z">
							</path>
						</svg>
						<p>No conversations found</p>
						<p class="text-sm">Try adjusting your filters</p>
					</div>
				\`;
			}

			return \`
				<div class="grid gap-3">
					\${state.conversations.map(conv => \`
						<div onclick="selectConversation('\${conv.sessionId}')"
							class="fade-in bg-claude-dark rounded-lg p-4 hover:bg-gray-800 cursor-pointer border border-gray-800 hover:border-gray-700 transition-colors">
							<div class="flex items-start justify-between gap-4">
								<div class="flex-1 min-w-0">
									<h3 class="font-medium text-white truncate">
										\${conv.customTitle || conv.summary || conv.sessionId}
									</h3>
									\${conv.summary && conv.customTitle ? \`<p class="text-sm text-gray-400 mt-1 line-clamp-2">\${conv.summary}</p>\` : ''}
									<div class="flex items-center gap-3 mt-2 text-xs text-gray-500">
										<span class="flex items-center gap-1">
											<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path>
											</svg>
											\${conv.project}
										</span>
										<span class="flex items-center gap-1">
											<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
											</svg>
											\${formatDate(conv.timestamp)}
										</span>
										<span class="flex items-center gap-1">
											<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"></path>
											</svg>
											\${conv.messageCount} messages
										</span>
										\${conv.gitBranch ? \`
											<span class="flex items-center gap-1">
												<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
												</svg>
												\${conv.gitBranch}
											</span>
										\` : ''}
									</div>
								</div>
								<div class="flex flex-col items-end gap-2">
									\${conv.isSubagent ? '<span class="tool-badge bg-gray-700 text-gray-300 rounded">Subagent</span>' : ''}
								</div>
							</div>
						</div>
					\`).join('')}
				</div>
			\`;
		}

		function renderConversationDetail() {
			const messages = state.selectedMessages || [];

			return \`
				<div class="max-w-4xl mx-auto space-y-4">
					\${messages.map((msg, i) => \`
						<div id="message-\${i}" class="fade-in rounded-lg p-4 \${msg.type === 'user' ? 'bg-blue-900/20 border border-blue-800/30' : 'bg-gray-800/50 border border-gray-700/30'}">
							<div class="flex items-center gap-2 mb-2">
								<span class="font-medium text-sm \${msg.type === 'user' ? 'text-blue-400' : 'text-green-400'}">
									\${msg.type === 'user' ? 'User' : 'Assistant'}
								</span>
								\${msg.timestamp ? \`<span class="text-xs text-gray-500">\${formatTime(msg.timestamp)}</span>\` : ''}
								\${msg.model ? \`<span class="text-xs text-gray-600">\${msg.model}</span>\` : ''}
							</div>
							<div class="message-content text-sm text-gray-300">
								\${formatContent(msg.content)}
							</div>
							\${msg.toolUses && msg.toolUses.length > 0 ? \`
								<div class="mt-3 pt-3 border-t border-gray-700/50">
									<div class="text-xs text-gray-500 mb-2">Tools used:</div>
									<div class="flex flex-wrap gap-1.5">
										\${msg.toolUses.map(t => \`
											<span class="tool-badge \${toolColors[t.name] || 'bg-gray-600'} text-white rounded flex items-center gap-1">
												\${t.name}
												\${t.input?.file_path || t.input?.path ? \`: \${truncate(t.input.file_path || t.input.path, 30)}\` : ''}
											</span>
										\`).join('')}
									</div>
								</div>
							\` : ''}
						</div>
					\`).join('')}
				</div>
			\`;
		}

		function renderStats() {
			if (!state.stats) return '<div class="text-gray-500">Loading statistics...</div>';

			const stats = state.stats;
			const topProjects = Object.entries(stats.projectCounts)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);
			const topTools = Object.entries(stats.toolCounts)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);

			return \`
				<div class="max-w-6xl mx-auto">
					<h2 class="text-2xl font-semibold mb-6">Usage Statistics</h2>

					<div class="grid grid-cols-4 gap-4 mb-8">
						<div class="bg-claude-dark rounded-lg p-6 border border-gray-800">
							<div class="text-3xl font-bold text-claude-orange">\${stats.totalConversations}</div>
							<div class="text-sm text-gray-400 mt-1">Total Conversations</div>
						</div>
						<div class="bg-claude-dark rounded-lg p-6 border border-gray-800">
							<div class="text-3xl font-bold text-blue-400">\${stats.totalMessages.toLocaleString()}</div>
							<div class="text-sm text-gray-400 mt-1">Total Messages</div>
						</div>
						<div class="bg-claude-dark rounded-lg p-6 border border-gray-800">
							<div class="text-3xl font-bold text-green-400">\${Object.keys(stats.projectCounts).length}</div>
							<div class="text-sm text-gray-400 mt-1">Projects</div>
						</div>
						<div class="bg-claude-dark rounded-lg p-6 border border-gray-800">
							<div class="text-3xl font-bold text-purple-400">\${stats.subagentCount}</div>
							<div class="text-sm text-gray-400 mt-1">Subagent Sessions</div>
						</div>
					</div>

					<div class="grid grid-cols-2 gap-6">
						<div class="bg-claude-dark rounded-lg p-6 border border-gray-800">
							<h3 class="font-medium mb-4">Top Projects</h3>
							<div class="space-y-2">
								\${topProjects.map(([name, count]) => \`
									<div class="flex items-center justify-between">
										<span class="text-sm text-gray-300">\${name}</span>
										<div class="flex items-center gap-2">
											<div class="h-2 bg-claude-orange/30 rounded" style="width: \${Math.max(20, (count / topProjects[0][1]) * 200)}px"></div>
											<span class="text-xs text-gray-500 w-8 text-right">\${count}</span>
										</div>
									</div>
								\`).join('')}
							</div>
						</div>

						<div class="bg-claude-dark rounded-lg p-6 border border-gray-800">
							<h3 class="font-medium mb-4">Tool Usage</h3>
							<div class="space-y-2">
								\${topTools.map(([name, count]) => \`
									<div class="flex items-center justify-between">
										<span class="text-sm">
											<span class="tool-badge \${toolColors[name] || 'bg-gray-600'} text-white rounded mr-2">\${name}</span>
										</span>
										<div class="flex items-center gap-2">
											<div class="h-2 \${toolColors[name] || 'bg-gray-600'} rounded opacity-50" style="width: \${Math.max(20, (count / topTools[0][1]) * 200)}px"></div>
											<span class="text-xs text-gray-500 w-12 text-right">\${count.toLocaleString()}</span>
										</div>
									</div>
								\`).join('')}
							</div>
						</div>
					</div>
				</div>
			\`;
		}

		function renderLoading() {
			return \`
				<div class="flex items-center justify-center h-64">
					<div class="flex flex-col items-center gap-3">
						<div class="w-8 h-8 border-2 border-claude-orange border-t-transparent rounded-full animate-spin"></div>
						<span class="text-gray-400 text-sm">Loading...</span>
					</div>
				</div>
			\`;
		}

		function renderError() {
			return \`
				<div class="bg-red-900/20 border border-red-800/50 rounded-lg p-4 mb-4">
					<div class="flex items-center gap-2 text-red-400">
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
						</svg>
						<span>\${state.error}</span>
					</div>
				</div>
			\`;
		}

		// Helper functions
		function formatDate(timestamp) {
			const date = new Date(timestamp);
			return date.toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
			});
		}

		function formatTime(timestamp) {
			const date = new Date(timestamp);
			return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		}

		function truncate(str, len) {
			if (!str) return '';
			return str.length > len ? str.substring(0, len) + '...' : str;
		}

		function formatContent(content) {
			if (!content) return '<span class="text-gray-500 italic">(no content)</span>';
			// Escape HTML and handle code blocks
			let escaped = content
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');

			// Simple code block detection
			escaped = escaped.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre class="bg-gray-900 rounded p-2 my-2 overflow-x-auto text-xs font-mono">$1</pre>');
			escaped = escaped.replace(/\`([^\`]+)\`/g, '<code class="bg-gray-900 px-1 rounded text-xs font-mono">$1</code>');

			return escaped;
		}

		// Navigation
		window.navigateTo = function(view) {
			if (view === 'list') {
				state.view = 'list';
				state.selectedConversation = null;
				state.selectedMessages = [];
				render();
			} else if (view === 'stats') {
				fetchStats();
			}
		};

		window.selectConversation = function(sessionId) {
			fetchConversation(sessionId);
		};

		window.scrollToMessage = function(index) {
			const el = document.getElementById('message-' + index);
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				el.classList.add('ring-2', 'ring-claude-orange');
				setTimeout(() => el.classList.remove('ring-2', 'ring-claude-orange'), 2000);
			}
		};

		// Event listeners
		let searchTimeout;
		function attachEventListeners() {
			const searchInput = document.getElementById('searchInput');
			if (searchInput) {
				searchInput.addEventListener('input', (e) => {
					clearTimeout(searchTimeout);
					searchTimeout = setTimeout(() => {
						state.filters.query = e.target.value;
						fetchConversations();
					}, 300);
				});
			}

			const projectFilter = document.getElementById('projectFilter');
			if (projectFilter) {
				projectFilter.addEventListener('change', (e) => {
					state.filters.project = e.target.value;
					fetchConversations();
				});
			}

			const toolFilter = document.getElementById('toolFilter');
			if (toolFilter) {
				toolFilter.addEventListener('change', (e) => {
					state.filters.tool = e.target.value;
					fetchConversations();
				});
			}
		}

		// Initialize
		async function init() {
			await fetchProjects();
			await fetchConversations();
		}

		init();
	</script>
</body>
</html>`;
}

// =============================================================================
// Server
// =============================================================================

function startServer(port: number) {
	console.log(chalk.cyan(`\nStarting Claude History Dashboard on port ${port}...`));

	const server = serve({
		port,
		fetch(request) {
			const url = new URL(request.url);

			// API routes
			if (url.pathname.startsWith("/api/")) {
				return handleApiRequest(request);
			}

			// Serve SPA
			return new Response(renderHTML(), {
				headers: { "Content-Type": "text/html" },
			});
		},
	});

	console.log(chalk.green(`\nDashboard running at: ${chalk.bold(`http://localhost:${port}`)}`));
	console.log(chalk.dim("Press Ctrl+C to stop\n"));

	return server;
}

// =============================================================================
// CLI
// =============================================================================

program
	.name("claude-history-dashboard")
	.description("Web-based dashboard for browsing Claude conversation history")
	.option("-p, --port <number>", "Port to run the server on", String(DEFAULT_PORT))
	.action((options) => {
		const port = parseInt(options.port, 10);
		startServer(port);
	});

program.parse();
