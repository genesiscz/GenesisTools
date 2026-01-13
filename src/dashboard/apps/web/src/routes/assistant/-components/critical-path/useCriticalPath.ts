/**
 * Hook for Critical Path Analysis
 *
 * Provides computed graph data and analysis from tasks
 */

import { useState, useEffect, useRef } from 'react'
import type { Task } from '@/lib/assistant/types'
import type { GraphNode, GraphEdge, CriticalPathAnalysis, ViewportState } from './types'
import {
  buildGraphNodes,
  buildGraphEdges,
  analyzeCriticalPath,
  wouldCreateCycle,
} from './graph-utils'

interface UseCriticalPathOptions {
  tasks: Task[]
  width?: number
  height?: number
  includeCompleted?: boolean
}

interface UseCriticalPathResult {
  // Graph data
  nodes: GraphNode[]
  edges: GraphEdge[]
  analysis: CriticalPathAnalysis

  // Viewport state
  viewport: ViewportState
  setViewport: (viewport: ViewportState) => void
  resetViewport: () => void

  // Selected node
  selectedNodeId: string | null
  setSelectedNodeId: (id: string | null) => void

  // Dependency management
  canAddDependency: (fromId: string, toId: string) => boolean

  // Dimensions
  graphWidth: number
  graphHeight: number
}

const DEFAULT_VIEWPORT: ViewportState = {
  x: 0,
  y: 0,
  scale: 1,
}

const MIN_SCALE = 0.25
const MAX_SCALE = 2

export function useCriticalPath({
  tasks,
  width = 800,
  height = 600,
  includeCompleted = false,
}: UseCriticalPathOptions): UseCriticalPathResult {
  const [viewport, setViewportState] = useState<ViewportState>(DEFAULT_VIEWPORT)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Filter tasks if needed
  const filteredTasks = includeCompleted
    ? tasks
    : tasks.filter((t) => t.status !== 'completed')

  // Calculate graph dimensions based on task count
  const graphWidth = Math.max(width, filteredTasks.length * 150 + 200)
  const graphHeight = Math.max(height, filteredTasks.length * 80 + 200)

  // Build graph data
  const nodes = buildGraphNodes(filteredTasks, graphWidth, graphHeight)
  const edges = buildGraphEdges(filteredTasks)
  const analysis = analyzeCriticalPath(tasks) // Use all tasks for analysis

  // Set viewport with bounds checking
  function setViewport(newViewport: ViewportState) {
    setViewportState({
      x: newViewport.x,
      y: newViewport.y,
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, newViewport.scale)),
    })
  }

  function resetViewport() {
    setViewportState(DEFAULT_VIEWPORT)
  }

  // Check if adding a dependency would create a cycle
  function canAddDependency(fromId: string, toId: string): boolean {
    if (fromId === toId) return false
    return !wouldCreateCycle(filteredTasks, fromId, toId)
  }

  return {
    nodes,
    edges,
    analysis,
    viewport,
    setViewport,
    resetViewport,
    selectedNodeId,
    setSelectedNodeId,
    canAddDependency,
    graphWidth,
    graphHeight,
  }
}

/**
 * Hook for pan and zoom interactions
 */
export function useGraphInteractions(
  svgRef: React.RefObject<SVGSVGElement | null>,
  viewport: ViewportState,
  setViewport: (viewport: ViewportState) => void
) {
  const isPanningRef = useRef(false)
  const lastPosRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    function handleWheel(e: WheelEvent) {
      e.preventDefault()

      const rect = svg!.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      // Calculate zoom
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const newScale = Math.min(2, Math.max(0.25, viewport.scale * delta))

      // Zoom towards mouse position
      const scaleChange = newScale / viewport.scale
      const newX = mouseX - (mouseX - viewport.x) * scaleChange
      const newY = mouseY - (mouseY - viewport.y) * scaleChange

      setViewport({ x: newX, y: newY, scale: newScale })
    }

    function handleMouseDown(e: MouseEvent) {
      if (e.button !== 0) return // Only left click
      if ((e.target as Element).closest('[data-node]')) return // Don't pan on nodes

      isPanningRef.current = true
      lastPosRef.current = { x: e.clientX, y: e.clientY }
      svg!.style.cursor = 'grabbing'
    }

    function handleMouseMove(e: MouseEvent) {
      if (!isPanningRef.current) return

      const dx = e.clientX - lastPosRef.current.x
      const dy = e.clientY - lastPosRef.current.y

      lastPosRef.current = { x: e.clientX, y: e.clientY }
      setViewport({
        x: viewport.x + dx,
        y: viewport.y + dy,
        scale: viewport.scale,
      })
    }

    function handleMouseUp() {
      isPanningRef.current = false
      svg!.style.cursor = 'grab'
    }

    svg.addEventListener('wheel', handleWheel, { passive: false })
    svg.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      svg.removeEventListener('wheel', handleWheel)
      svg.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [svgRef, viewport, setViewport])
}
