/**
 * DependencyNode - Hexagonal task node for the critical path graph
 *
 * Features:
 * - Hexagonal shape with cyberpunk glow
 * - Color based on task urgency
 * - Critical path nodes have red glow
 * - Bottleneck indicator
 * - Progress indicator ring
 */

import type { TaskStatus, UrgencyLevel } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import type { GraphNode } from "./types";

interface DependencyNodeProps {
    node: GraphNode;
    isSelected: boolean;
    onClick: () => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

// Hexagon dimensions
const _NODE_WIDTH = 80;
const _NODE_HEIGHT = 70;

/**
 * Generate hexagon points for SVG polygon
 */
function getHexagonPoints(cx: number, cy: number, size: number): string {
    const points: string[] = [];
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        const x = cx + size * Math.cos(angle);
        const y = cy + size * Math.sin(angle);
        points.push(`${x},${y}`);
    }
    return points.join(" ");
}

/**
 * Get colors based on urgency level
 */
function getUrgencyColors(urgency: UrgencyLevel): {
    fill: string;
    stroke: string;
    glow: string;
    text: string;
} {
    switch (urgency) {
        case "critical":
            return {
                fill: "rgba(239, 68, 68, 0.15)",
                stroke: "#ef4444",
                glow: "#ef4444",
                text: "#fca5a5",
            };
        case "important":
            return {
                fill: "rgba(249, 115, 22, 0.15)",
                stroke: "#f97316",
                glow: "#f97316",
                text: "#fdba74",
            };
        case "nice-to-have":
            return {
                fill: "rgba(234, 179, 8, 0.15)",
                stroke: "#eab308",
                glow: "#eab308",
                text: "#fde047",
            };
    }
}

/**
 * Get status icon indicator
 */
function getStatusColor(status: TaskStatus): string {
    switch (status) {
        case "backlog":
            return "#6b7280"; // gray-500
        case "in-progress":
            return "#3b82f6"; // blue-500
        case "blocked":
            return "#ef4444"; // red-500
        case "completed":
            return "#22c55e"; // green-500
    }
}

export function DependencyNode({ node, isSelected, onClick, onMouseEnter, onMouseLeave }: DependencyNodeProps) {
    const { task, position, isOnCriticalPath, isBottleneck, downstreamCount } = node;
    const colors = getUrgencyColors(task.urgencyLevel);
    const statusColor = getStatusColor(task.status);
    const isCompleted = task.status === "completed";

    const cx = position.x;
    const cy = position.y;
    const hexSize = 35;

    // Calculate a "progress" for the task (simplified - could be enhanced)
    const progress = isCompleted ? 100 : task.status === "in-progress" ? 50 : 0;

    return (
        <g
            data-node
            className={cn("cursor-pointer transition-all duration-200", isCompleted && "opacity-50")}
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            style={{ transform: `translate(${cx}px, ${cy}px)` }}
        >
            {/* Critical path glow effect */}
            {isOnCriticalPath && !isCompleted && (
                <>
                    <polygon
                        points={getHexagonPoints(0, 0, hexSize + 12)}
                        fill="none"
                        stroke="#ef4444"
                        strokeWidth="2"
                        opacity="0.3"
                        className="animate-pulse"
                    />
                    <polygon
                        points={getHexagonPoints(0, 0, hexSize + 8)}
                        fill="none"
                        stroke="#ef4444"
                        strokeWidth="1"
                        opacity="0.5"
                    />
                </>
            )}

            {/* Selection ring */}
            {isSelected && (
                <polygon
                    points={getHexagonPoints(0, 0, hexSize + 6)}
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth="3"
                    strokeDasharray="4,4"
                    className="animate-spin"
                    style={{ animationDuration: "8s" }}
                />
            )}

            {/* Outer glow */}
            <defs>
                <filter id={`glow-${task.id}`} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feFlood floodColor={isOnCriticalPath ? "#ef4444" : colors.glow} />
                    <feComposite in2="blur" operator="in" />
                    <feMerge>
                        <feMergeNode />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>

            {/* Main hexagon background */}
            <polygon
                points={getHexagonPoints(0, 0, hexSize)}
                fill={isOnCriticalPath ? "rgba(239, 68, 68, 0.2)" : colors.fill}
                stroke={isOnCriticalPath ? "#ef4444" : colors.stroke}
                strokeWidth="2"
                filter={`url(#glow-${task.id})`}
            />

            {/* Inner hexagon */}
            <polygon
                points={getHexagonPoints(0, 0, hexSize - 6)}
                fill="rgba(10, 10, 20, 0.8)"
                stroke={isOnCriticalPath ? "#ef4444" : colors.stroke}
                strokeWidth="1"
                opacity="0.5"
            />

            {/* Progress arc (simplified) */}
            {progress > 0 && progress < 100 && (
                <circle
                    cx="0"
                    cy="0"
                    r={hexSize - 3}
                    fill="none"
                    stroke={statusColor}
                    strokeWidth="3"
                    strokeDasharray={`${(progress / 100) * (2 * Math.PI * (hexSize - 3))} ${2 * Math.PI * (hexSize - 3)}`}
                    strokeLinecap="round"
                    transform="rotate(-90)"
                    opacity="0.6"
                />
            )}

            {/* Completed check or task title */}
            {isCompleted ? (
                <g>
                    <circle cx="0" cy="0" r="12" fill="#22c55e" opacity="0.3" />
                    <path
                        d="M-6 0 L-2 4 L6 -4"
                        stroke="#22c55e"
                        strokeWidth="2.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </g>
            ) : (
                <>
                    {/* Task title (truncated) */}
                    <text
                        x="0"
                        y="-2"
                        textAnchor="middle"
                        fill={isOnCriticalPath ? "#fca5a5" : colors.text}
                        fontSize="9"
                        fontWeight="600"
                        className="pointer-events-none"
                    >
                        {task.title.length > 10 ? `${task.title.substring(0, 10)}...` : task.title}
                    </text>

                    {/* Status indicator */}
                    <circle cx="0" cy="16" r="4" fill={statusColor} />
                </>
            )}

            {/* Bottleneck warning indicator */}
            {isBottleneck && !isCompleted && (
                <g transform="translate(22, -22)">
                    <circle cx="0" cy="0" r="10" fill="#f97316" className="animate-pulse" />
                    <text x="0" y="4" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="bold">
                        !
                    </text>
                </g>
            )}

            {/* Downstream count badge */}
            {downstreamCount > 0 && !isCompleted && (
                <g transform="translate(-24, -22)">
                    <circle cx="0" cy="0" r="9" fill="#6366f1" opacity="0.9" />
                    <text x="0" y="3" textAnchor="middle" fill="#fff" fontSize="9" fontWeight="600">
                        {downstreamCount}
                    </text>
                </g>
            )}
        </g>
    );
}

/**
 * Tooltip content for node hover
 */
export function NodeTooltip({ node }: { node: GraphNode }) {
    const { task, level, isOnCriticalPath, isBottleneck, downstreamCount } = node;
    const colors = getUrgencyColors(task.urgencyLevel);

    return (
        <div className="p-3 max-w-xs">
            <div className="flex items-center gap-2 mb-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: colors.stroke }} />
                <h4 className="font-semibold text-sm">{task.title}</h4>
            </div>

            {task.description && <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{task.description}</p>}

            <div className="flex flex-wrap gap-1.5 text-[10px]">
                <span
                    className="px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: `${colors.stroke}20`, color: colors.text }}
                >
                    {task.urgencyLevel}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Level {level}</span>
                {isOnCriticalPath && (
                    <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Critical Path</span>
                )}
                {isBottleneck && (
                    <span className="px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">Bottleneck</span>
                )}
                {downstreamCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">
                        Blocks {downstreamCount} task{downstreamCount > 1 ? "s" : ""}
                    </span>
                )}
            </div>

            {task.deadline && (
                <p className="text-[10px] text-muted-foreground mt-2">
                    Due: {new Date(task.deadline).toLocaleDateString()}
                </p>
            )}
        </div>
    );
}
