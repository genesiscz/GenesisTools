/**
 * CriticalPathGraph - Interactive SVG dependency graph
 *
 * Features:
 * - Pan: Drag on background
 * - Zoom: Scroll wheel
 * - Click node: Show task details tooltip
 * - Critical path highlighted in red with pulse
 * - Non-critical tasks in gray
 * - Cyberpunk grid background
 */

import { useNavigate } from "@tanstack/react-router";
import { Home, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Task } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { DependencyNode, NodeTooltip } from "./DependencyNode";
import type { GraphEdge, GraphNode } from "./types";
import { useCriticalPath, useGraphInteractions } from "./useCriticalPath";

interface CriticalPathGraphProps {
    tasks: Task[];
    width?: number;
    height?: number;
    includeCompleted?: boolean;
    className?: string;
    onTaskSelect?: (taskId: string) => void;
}

/**
 * Draw arrow marker definition
 */
function ArrowMarker({ id, color }: { id: string; color: string }) {
    return (
        <marker
            id={id}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
        >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
        </marker>
    );
}

/**
 * Grid background pattern
 */
function GridBackground() {
    return (
        <defs>
            <pattern id="grid-small" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(139, 92, 246, 0.05)" strokeWidth="0.5" />
            </pattern>
            <pattern id="grid-large" width="100" height="100" patternUnits="userSpaceOnUse">
                <rect width="100" height="100" fill="url(#grid-small)" />
                <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(139, 92, 246, 0.1)" strokeWidth="1" />
            </pattern>
        </defs>
    );
}

/**
 * Draw edge between nodes
 */
function GraphEdgeLine({
    edge,
    fromPos,
    toPos,
}: {
    edge: GraphEdge;
    fromPos: { x: number; y: number };
    toPos: { x: number; y: number };
}) {
    const { isOnCriticalPath } = edge;

    // Calculate control points for curved line
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const cx = fromPos.x + dx / 2;
    const cy = fromPos.y + dy / 2;

    // Offset control point for curve
    const offset = Math.min(Math.abs(dy) * 0.3, 30);
    const cpy = cy - offset;

    const path = `M ${fromPos.x} ${fromPos.y} Q ${cx} ${cpy} ${toPos.x} ${toPos.y}`;

    return (
        <g>
            {/* Glow effect for critical path */}
            {isOnCriticalPath && (
                <path
                    d={path}
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth="6"
                    opacity="0.3"
                    className="animate-pulse"
                    style={{ filter: "blur(4px)" }}
                />
            )}

            {/* Main line */}
            <path
                d={path}
                fill="none"
                stroke={isOnCriticalPath ? "#ef4444" : "rgba(139, 92, 246, 0.4)"}
                strokeWidth={isOnCriticalPath ? 3 : 2}
                markerEnd={`url(#arrow-${isOnCriticalPath ? "critical" : "normal"})`}
                strokeDasharray={isOnCriticalPath ? undefined : "5,5"}
            />
        </g>
    );
}

export function CriticalPathGraph({
    tasks,
    width = 800,
    height = 600,
    includeCompleted = false,
    className,
    onTaskSelect,
}: CriticalPathGraphProps) {
    const navigate = useNavigate();
    const svgRef = useRef<SVGSVGElement>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

    const { nodes, edges, viewport, setViewport, resetViewport, selectedNodeId, setSelectedNodeId } = useCriticalPath({
        tasks,
        width,
        height,
        includeCompleted,
    });

    // Set up pan and zoom interactions
    useGraphInteractions(svgRef, viewport, setViewport);

    // Get position map for edges
    const positionMap = new Map(nodes.map((n) => [n.task.id, n.position]));

    function handleNodeClick(node: GraphNode) {
        setSelectedNodeId(node.task.id);
        if (onTaskSelect) {
            onTaskSelect(node.task.id);
        } else {
            navigate({
                to: "/assistant/tasks/$taskId",
                params: { taskId: node.task.id },
            });
        }
    }

    function handleZoomIn() {
        setViewport({ ...viewport, scale: Math.min(2, viewport.scale * 1.2) });
    }

    function handleZoomOut() {
        setViewport({ ...viewport, scale: Math.max(0.25, viewport.scale / 1.2) });
    }

    function handleFitToScreen() {
        // Calculate bounds
        if (nodes.length === 0) {
            return;
        }

        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;

        for (const node of nodes) {
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x);
            maxY = Math.max(maxY, node.position.y);
        }

        const padding = 100;
        const contentWidth = maxX - minX + padding * 2;
        const contentHeight = maxY - minY + padding * 2;

        const scaleX = width / contentWidth;
        const scaleY = height / contentHeight;
        const scale = Math.min(scaleX, scaleY, 1);

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        setViewport({
            x: width / 2 - centerX * scale,
            y: height / 2 - centerY * scale,
            scale,
        });
    }

    // Empty state
    if (nodes.length === 0) {
        return (
            <div
                className={cn(
                    "flex items-center justify-center rounded-xl border border-purple-500/20 bg-[#0a0a14]/80",
                    className
                )}
                style={{ width, height }}
            >
                <div className="text-center p-8">
                    <p className="text-muted-foreground mb-2">No tasks to display</p>
                    <p className="text-xs text-muted-foreground/70">Create some tasks to see the dependency graph</p>
                </div>
            </div>
        );
    }

    // Suppress unused variable warning - hoveredNodeId used for future enhancements
    void hoveredNodeId;

    return (
        <div className={cn("relative", className)}>
            {/* Control buttons */}
            <div className="absolute top-4 right-4 z-10 flex gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleZoomIn}
                    className="h-8 w-8 p-0 bg-background/80 backdrop-blur-sm"
                    title="Zoom in"
                >
                    <ZoomIn className="h-4 w-4" />
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleZoomOut}
                    className="h-8 w-8 p-0 bg-background/80 backdrop-blur-sm"
                    title="Zoom out"
                >
                    <ZoomOut className="h-4 w-4" />
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleFitToScreen}
                    className="h-8 w-8 p-0 bg-background/80 backdrop-blur-sm"
                    title="Fit to screen"
                >
                    <Maximize2 className="h-4 w-4" />
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={resetViewport}
                    className="h-8 w-8 p-0 bg-background/80 backdrop-blur-sm"
                    title="Reset view"
                >
                    <Home className="h-4 w-4" />
                </Button>
            </div>

            {/* Scale indicator */}
            <div className="absolute bottom-4 left-4 z-10 px-2 py-1 rounded bg-background/80 backdrop-blur-sm text-xs text-muted-foreground">
                {Math.round(viewport.scale * 100)}%
            </div>

            {/* Legend */}
            <div className="absolute bottom-4 right-4 z-10 flex gap-3 px-3 py-2 rounded-lg bg-background/80 backdrop-blur-sm text-xs">
                <div className="flex items-center gap-1.5">
                    <div className="w-3 h-0.5 bg-red-500 rounded" />
                    <span className="text-red-400">Critical Path</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <div
                        className="w-3 h-0.5 bg-purple-500/50 rounded"
                        style={{
                            background:
                                "repeating-linear-gradient(90deg, rgba(139,92,246,0.5) 0, rgba(139,92,246,0.5) 3px, transparent 3px, transparent 6px)",
                        }}
                    />
                    <span className="text-muted-foreground">Dependency</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-full bg-orange-500" />
                    <span className="text-orange-400">Bottleneck</span>
                </div>
            </div>

            {/* SVG Graph */}
            <svg
                ref={svgRef}
                width={width}
                height={height}
                className="rounded-xl border border-purple-500/20 bg-[#0a0a14]"
                style={{ cursor: "grab" }}
            >
                <GridBackground />

                {/* Background rect for grid */}
                <rect width="100%" height="100%" fill="url(#grid-large)" />

                {/* Arrow markers */}
                <defs>
                    <ArrowMarker id="arrow-critical" color="#ef4444" />
                    <ArrowMarker id="arrow-normal" color="rgba(139, 92, 246, 0.6)" />
                </defs>

                {/* Transformed content */}
                <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`}>
                    {/* Edges */}
                    <g className="edges">
                        {edges.map((edge) => {
                            const fromPos = positionMap.get(edge.from);
                            const toPos = positionMap.get(edge.to);

                            if (!fromPos || !toPos) {
                                return null;
                            }

                            return (
                                <GraphEdgeLine
                                    key={`${edge.from}-${edge.to}`}
                                    edge={edge}
                                    fromPos={fromPos}
                                    toPos={toPos}
                                />
                            );
                        })}
                    </g>

                    {/* Nodes */}
                    <g className="nodes">
                        {nodes.map((node) => (
                            <Tooltip key={node.task.id}>
                                <TooltipTrigger asChild>
                                    <g>
                                        <DependencyNode
                                            node={node}
                                            isSelected={selectedNodeId === node.task.id}
                                            onClick={() => handleNodeClick(node)}
                                            onMouseEnter={() => setHoveredNodeId(node.task.id)}
                                            onMouseLeave={() => setHoveredNodeId(null)}
                                        />
                                    </g>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="p-0">
                                    <NodeTooltip node={node} />
                                </TooltipContent>
                            </Tooltip>
                        ))}
                    </g>
                </g>
            </svg>
        </div>
    );
}
