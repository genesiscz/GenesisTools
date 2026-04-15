import { useEffect, useMemo, useState } from "react";
import { getSidebarSessions } from "@/server/conversations";
import type { SidebarSession } from "@/server/serializers";
import type { ProjectGroup } from "./types";

function groupByProject(sessions: SidebarSession[]): ProjectGroup[] {
	const map = new Map<string, { sessions: SidebarSession[]; subagents: SidebarSession[] }>();

	for (const s of sessions) {
		let group = map.get(s.project);

		if (!group) {
			group = { sessions: [], subagents: [] };
			map.set(s.project, group);
		}

		if (s.isSubagent) {
			group.subagents.push(s);
		} else {
			group.sessions.push(s);
		}
	}

	const projects: ProjectGroup[] = [];

	for (const [name, group] of map) {
		const all = [...group.sessions, ...group.subagents];
		const sortByTime = (a: SidebarSession, b: SidebarSession) =>
			new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();

		group.sessions.sort(sortByTime);
		group.subagents.sort(sortByTime);

		const latest = all.reduce((max, s) => (s.timestamp > max ? s.timestamp : max), all[0].timestamp);

		projects.push({
			name,
			sessions: group.sessions,
			subagents: group.subagents,
			totalCount: all.length,
			latestTimestamp: latest,
		});
	}

	projects.sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime());
	return projects;
}

function matchesSearch(session: SidebarSession, query: string): boolean {
	const q = query.toLowerCase();
	return (
		session.project.toLowerCase().includes(q) ||
		(session.customTitle?.toLowerCase().includes(q) ?? false) ||
		(session.summary?.toLowerCase().includes(q) ?? false)
	);
}

export function useSidebarData() {
	const [sessions, setSessions] = useState<SidebarSession[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [search, setSearch] = useState("");

	useEffect(() => {
		getSidebarSessions().then((data) => {
			setSessions(data);
			setIsLoading(false);
		});
	}, []);

	const projects = useMemo(() => {
		const filtered = search ? sessions.filter((s) => matchesSearch(s, search)) : sessions;
		return groupByProject(filtered);
	}, [sessions, search]);

	return { projects, search, setSearch, isLoading };
}
