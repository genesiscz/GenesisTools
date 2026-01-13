/**
 * Graph Utilities for Critical Path Analysis
 *
 * Implements algorithms for:
 * - Topological sorting (Kahn's algorithm)
 * - Critical path calculation (longest path)
 * - Bottleneck detection
 * - Force-directed layout within levels
 */

import type { Task } from '@/lib/assistant/types'
import type {
  GraphNode,
  GraphEdge,
  CriticalPathAnalysis,
  NodePosition,
} from './types'

// Average days per task for estimation (configurable)
const AVG_DAYS_PER_TASK = 2

/**
 * Build adjacency list from tasks
 */
function buildAdjacencyList(tasks: Task[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()

  for (const task of tasks) {
    adjacency.set(task.id, [])
  }

  for (const task of tasks) {
    if (task.blockedBy) {
      for (const depId of task.blockedBy) {
        const deps = adjacency.get(depId)
        if (deps) {
          deps.push(task.id)
        }
      }
    }
  }

  return adjacency
}

/**
 * Build reverse adjacency list (who depends on whom)
 */
function buildReverseAdjacency(tasks: Task[]): Map<string, string[]> {
  const reverse = new Map<string, string[]>()

  for (const task of tasks) {
    reverse.set(task.id, task.blockedBy ?? [])
  }

  return reverse
}

/**
 * Topological sort using Kahn's algorithm
 * Returns tasks sorted by dependency level
 */
export function topologicalSort(tasks: Task[]): {
  sorted: Task[]
  levels: Map<string, number>
  hasCycle: boolean
} {
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const inDegree = new Map<string, number>()
  const adjacency = buildAdjacencyList(tasks)

  // Initialize in-degrees
  for (const task of tasks) {
    inDegree.set(task.id, 0)
  }

  // Count in-degrees
  for (const task of tasks) {
    if (task.blockedBy) {
      for (const depId of task.blockedBy) {
        if (taskMap.has(depId)) {
          inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
        }
      }
    }
  }

  // Initialize queue with nodes having no dependencies
  const queue: string[] = []
  const levels = new Map<string, number>()

  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id)
      levels.set(id, 0)
    }
  }

  const sorted: Task[] = []
  let processed = 0

  while (queue.length > 0) {
    const current = queue.shift()!
    const task = taskMap.get(current)

    if (task) {
      sorted.push(task)
      processed++

      const neighbors = adjacency.get(current) ?? []
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) ?? 0) - 1
        inDegree.set(neighbor, newDegree)

        if (newDegree === 0) {
          queue.push(neighbor)
          // Level is max of dependency levels + 1
          const currentLevel = levels.get(current) ?? 0
          const existingLevel = levels.get(neighbor) ?? 0
          levels.set(neighbor, Math.max(existingLevel, currentLevel + 1))
        }
      }
    }
  }

  return {
    sorted,
    levels,
    hasCycle: processed !== tasks.length,
  }
}

/**
 * Calculate downstream count (how many tasks are blocked by this one)
 */
function calculateDownstreamCounts(tasks: Task[]): Map<string, number> {
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const adjacency = buildAdjacencyList(tasks)
  const counts = new Map<string, number>()
  const visited = new Set<string>()

  function dfs(taskId: string): number {
    if (visited.has(taskId)) {
      return counts.get(taskId) ?? 0
    }

    visited.add(taskId)
    let count = 0

    const neighbors = adjacency.get(taskId) ?? []
    for (const neighbor of neighbors) {
      if (taskMap.has(neighbor)) {
        count += 1 + dfs(neighbor)
      }
    }

    counts.set(taskId, count)
    return count
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      dfs(task.id)
    }
  }

  return counts
}

/**
 * Find the critical path (longest path through the graph)
 */
export function findCriticalPath(tasks: Task[]): Task[] {
  const { sorted, levels, hasCycle } = topologicalSort(tasks)

  if (hasCycle || sorted.length === 0) {
    return []
  }

  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const reverseAdj = buildReverseAdjacency(tasks)

  // Find max level
  let maxLevel = 0
  for (const level of levels.values()) {
    maxLevel = Math.max(maxLevel, level)
  }

  // Find all tasks at max level (endpoints)
  const endpoints: string[] = []
  for (const [id, level] of levels) {
    if (level === maxLevel) {
      endpoints.push(id)
    }
  }

  // Pick the endpoint with highest priority (critical > important > nice-to-have)
  const priorityOrder: Record<string, number> = {
    critical: 3,
    important: 2,
    'nice-to-have': 1,
  }

  let bestEndpoint = endpoints[0]
  let bestPriority = 0

  for (const id of endpoints) {
    const task = taskMap.get(id)
    if (task) {
      const priority = priorityOrder[task.urgencyLevel] ?? 0
      if (priority > bestPriority) {
        bestPriority = priority
        bestEndpoint = id
      }
    }
  }

  // Trace back from endpoint to find the critical path
  const path: Task[] = []
  let current = bestEndpoint

  while (current) {
    const task = taskMap.get(current)
    if (task) {
      path.unshift(task)
    }

    // Find the dependency with highest level
    const deps = reverseAdj.get(current) ?? []
    let nextTask: string | null = null
    let maxDepLevel = -1

    for (const dep of deps) {
      if (taskMap.has(dep)) {
        const depLevel = levels.get(dep) ?? 0
        if (depLevel > maxDepLevel) {
          maxDepLevel = depLevel
          nextTask = dep
        }
      }
    }

    current = nextTask!
  }

  return path
}

/**
 * Find bottleneck tasks (block the most other tasks)
 */
export function findBottlenecks(tasks: Task[], threshold = 2): Task[] {
  const counts = calculateDownstreamCounts(tasks)
  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  const bottlenecks: Array<{ task: Task; count: number }> = []

  for (const [id, count] of counts) {
    if (count >= threshold) {
      const task = taskMap.get(id)
      if (task && task.status !== 'completed') {
        bottlenecks.push({ task, count })
      }
    }
  }

  // Sort by count descending
  bottlenecks.sort((a, b) => b.count - a.count)

  return bottlenecks.map((b) => b.task)
}

/**
 * Calculate node positions using layered layout
 */
export function calculateLayout(
  tasks: Task[],
  width: number,
  height: number,
  nodeSize = 80
): Map<string, NodePosition> {
  const { levels, hasCycle } = topologicalSort(tasks)
  const positions = new Map<string, NodePosition>()

  if (hasCycle || tasks.length === 0) {
    // Fallback: simple grid layout
    const cols = Math.ceil(Math.sqrt(tasks.length))
    tasks.forEach((task, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      positions.set(task.id, {
        x: 100 + col * (nodeSize + 40),
        y: 100 + row * (nodeSize + 40),
      })
    })
    return positions
  }

  // Group tasks by level
  const levelGroups = new Map<number, Task[]>()
  let maxLevel = 0

  for (const task of tasks) {
    const level = levels.get(task.id) ?? 0
    maxLevel = Math.max(maxLevel, level)

    if (!levelGroups.has(level)) {
      levelGroups.set(level, [])
    }
    levelGroups.get(level)!.push(task)
  }

  // Calculate horizontal spacing
  const levelCount = maxLevel + 1
  const horizontalSpacing = Math.max(
    nodeSize + 60,
    (width - 200) / Math.max(levelCount, 1)
  )

  // Position nodes
  for (let level = 0; level <= maxLevel; level++) {
    const tasksAtLevel = levelGroups.get(level) ?? []
    const verticalSpacing = Math.max(
      nodeSize + 40,
      (height - 200) / Math.max(tasksAtLevel.length, 1)
    )

    // Sort tasks at level by urgency for consistent layout
    const priorityOrder: Record<string, number> = {
      critical: 3,
      important: 2,
      'nice-to-have': 1,
    }
    tasksAtLevel.sort(
      (a, b) =>
        (priorityOrder[b.urgencyLevel] ?? 0) -
        (priorityOrder[a.urgencyLevel] ?? 0)
    )

    tasksAtLevel.forEach((task, i) => {
      const x = 100 + level * horizontalSpacing
      const y =
        100 +
        i * verticalSpacing +
        (height - 200 - tasksAtLevel.length * verticalSpacing) / 2

      positions.set(task.id, { x, y })
    })
  }

  return positions
}

/**
 * Build graph nodes from tasks
 */
export function buildGraphNodes(
  tasks: Task[],
  width: number,
  height: number
): GraphNode[] {
  const { levels } = topologicalSort(tasks)
  const criticalPath = findCriticalPath(tasks)
  const criticalPathIds = new Set(criticalPath.map((t) => t.id))
  const bottlenecks = findBottlenecks(tasks)
  const bottleneckIds = new Set(bottlenecks.map((t) => t.id))
  const downstreamCounts = calculateDownstreamCounts(tasks)
  const positions = calculateLayout(tasks, width, height)

  return tasks.map((task) => ({
    task,
    position: positions.get(task.id) ?? { x: 0, y: 0 },
    level: levels.get(task.id) ?? 0,
    isOnCriticalPath: criticalPathIds.has(task.id),
    isBottleneck: bottleneckIds.has(task.id),
    downstreamCount: downstreamCounts.get(task.id) ?? 0,
  }))
}

/**
 * Build graph edges from tasks
 */
export function buildGraphEdges(tasks: Task[]): GraphEdge[] {
  const taskIds = new Set(tasks.map((t) => t.id))
  const criticalPath = findCriticalPath(tasks)
  const criticalPathIds = new Set(criticalPath.map((t) => t.id))
  const edges: GraphEdge[] = []

  for (const task of tasks) {
    if (task.blockedBy) {
      for (const depId of task.blockedBy) {
        if (taskIds.has(depId)) {
          edges.push({
            from: depId,
            to: task.id,
            isOnCriticalPath:
              criticalPathIds.has(depId) && criticalPathIds.has(task.id),
          })
        }
      }
    }
  }

  return edges
}

/**
 * Perform full critical path analysis
 */
export function analyzeCriticalPath(tasks: Task[]): CriticalPathAnalysis {
  const incompleteTasks = tasks.filter((t) => t.status !== 'completed')
  const { levels, hasCycle } = topologicalSort(incompleteTasks)
  const criticalPath = findCriticalPath(incompleteTasks)
  const bottlenecks = findBottlenecks(incompleteTasks)

  // Count root tasks (no dependencies)
  let rootTasks = 0
  let leafTasks = 0
  let maxDepth = 0

  const adjacency = buildAdjacencyList(incompleteTasks)

  for (const task of incompleteTasks) {
    const deps = task.blockedBy?.filter((d) =>
      incompleteTasks.some((t) => t.id === d)
    )
    const hasNoDeps = !deps || deps.length === 0
    const blocksNothing = (adjacency.get(task.id) ?? []).length === 0

    if (hasNoDeps) rootTasks++
    if (blocksNothing) leafTasks++

    const level = levels.get(task.id) ?? 0
    maxDepth = Math.max(maxDepth, level)
  }

  return {
    criticalPath,
    daysToCompletion: criticalPath.length * AVG_DAYS_PER_TASK,
    bottlenecks,
    totalTasks: incompleteTasks.length,
    rootTasks,
    leafTasks,
    maxDepth: maxDepth + 1, // Convert to 1-indexed depth
  }
}

/**
 * Check if adding a dependency would create a cycle
 */
export function wouldCreateCycle(
  tasks: Task[],
  fromId: string,
  toId: string
): boolean {
  // Create a temporary task list with the new dependency
  const tempTasks = tasks.map((t) => {
    if (t.id === toId) {
      return {
        ...t,
        blockedBy: [...(t.blockedBy ?? []), fromId],
      }
    }
    return t
  })

  const { hasCycle } = topologicalSort(tempTasks)
  return hasCycle
}
