/**
 * Critical Path Visualizer Types
 *
 * Types for the dependency graph visualization and analysis
 */

import type { Task } from '@/lib/assistant/types'

/**
 * Node position in the graph
 */
export interface NodePosition {
  x: number
  y: number
}

/**
 * Graph node representing a task
 */
export interface GraphNode {
  task: Task
  position: NodePosition
  /** Level in the topological sort (0 = no dependencies) */
  level: number
  /** Whether this node is on the critical path */
  isOnCriticalPath: boolean
  /** Whether this node is a bottleneck */
  isBottleneck: boolean
  /** Number of tasks this blocks (directly + indirectly) */
  downstreamCount: number
}

/**
 * Edge connecting two nodes
 */
export interface GraphEdge {
  from: string // taskId
  to: string // taskId
  isOnCriticalPath: boolean
}

/**
 * Analysis results for the critical path
 */
export interface CriticalPathAnalysis {
  /** Tasks on the critical path in order */
  criticalPath: Task[]
  /** Estimated days to completion based on average task completion time */
  daysToCompletion: number
  /** Tasks that block the most other tasks */
  bottlenecks: Task[]
  /** Total number of incomplete tasks */
  totalTasks: number
  /** Number of tasks with no dependencies */
  rootTasks: number
  /** Number of tasks that block nothing */
  leafTasks: number
  /** Deepest level of dependencies */
  maxDepth: number
}

/**
 * Graph viewport state for pan and zoom
 */
export interface ViewportState {
  x: number
  y: number
  scale: number
}

/**
 * Props for the dependency selector
 */
export interface DependencySelectorProps {
  taskId: string
  currentDependencies: string[]
  availableTasks: Task[]
  onUpdate: (dependencies: string[]) => void
}
