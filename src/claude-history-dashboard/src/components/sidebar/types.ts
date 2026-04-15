import type { SidebarSession } from "@/server/serializers";

export interface ProjectGroup {
	name: string;
	sessions: SidebarSession[];
	subagents: SidebarSession[];
	totalCount: number;
	latestTimestamp: string;
}
