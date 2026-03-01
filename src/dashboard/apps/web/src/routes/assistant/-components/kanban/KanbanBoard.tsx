import {
    closestCenter,
    DndContext,
    type DragEndEvent,
    DragOverlay,
    type DragStartEvent,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import { useState } from "react";
import type { Task, TaskInput, TaskStatus } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { KanbanCardOverlay } from "./KanbanCard";
import { KanbanColumn } from "./KanbanColumn";

interface KanbanBoardProps {
    tasks: Task[];
    onStatusChange: (taskId: string, newStatus: TaskStatus) => Promise<void>;
    onAddTask: (input: TaskInput) => Promise<void>;
    onOpenTaskForm: (status: TaskStatus) => void;
    className?: string;
}

/**
 * Column order for the Kanban board
 */
const COLUMN_ORDER: TaskStatus[] = ["backlog", "in-progress", "blocked", "completed"];

/**
 * KanbanBoard - Main container with DndContext for drag and drop
 */
export function KanbanBoard({ tasks, onStatusChange, onOpenTaskForm, className }: KanbanBoardProps) {
    const [activeTask, setActiveTask] = useState<Task | null>(null);

    // Configure drag sensors
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8, // Start drag after 8px movement
            },
        }),
        useSensor(KeyboardSensor)
    );

    // Group tasks by status
    const tasksByStatus = COLUMN_ORDER.reduce(
        (acc, status) => {
            acc[status] = tasks.filter((task) => task.status === status);
            return acc;
        },
        {} as Record<TaskStatus, Task[]>
    );

    // Handle drag start
    function handleDragStart(event: DragStartEvent) {
        const task = event.active.data.current?.task as Task | undefined;
        if (task) {
            setActiveTask(task);
        }
    }

    // Handle drag end
    async function handleDragEnd(event: DragEndEvent) {
        setActiveTask(null);

        const { active, over } = event;

        if (!over) {
            return;
        }

        const taskId = active.id as string;
        const newStatus = over.id as TaskStatus;

        // Find the task
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
            return;
        }

        // If dropped on a different status, update it
        if (task.status !== newStatus) {
            await onStatusChange(taskId, newStatus);
        }
    }

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
        >
            {/* Board container with horizontal scroll on mobile */}
            <div
                className={cn(
                    "flex gap-4 pb-4",
                    // Horizontal scroll on mobile
                    "overflow-x-auto overflow-y-hidden",
                    // Custom scrollbar
                    "scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent",
                    // Snap scrolling on mobile
                    "snap-x snap-mandatory md:snap-none",
                    className
                )}
            >
                {COLUMN_ORDER.map((status) => (
                    <div key={status} className="snap-start">
                        <KanbanColumn status={status} tasks={tasksByStatus[status]} onAddTask={onOpenTaskForm} />
                    </div>
                ))}
            </div>

            {/* Drag overlay - rendered outside columns for smooth animation */}
            <DragOverlay
                dropAnimation={{
                    duration: 200,
                    easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)",
                }}
            >
                {activeTask ? <KanbanCardOverlay task={activeTask} /> : null}
            </DragOverlay>
        </DndContext>
    );
}
