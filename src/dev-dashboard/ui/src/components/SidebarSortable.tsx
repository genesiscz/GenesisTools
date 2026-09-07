import {
    closestCenter,
    DndContext,
    type DragEndEvent,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isNavRouteActive, NavRailLink } from "@/components/nav-rail-link";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { NavRoute } from "@/lib/nav-routes";

interface SidebarSortableProps {
    routes: NavRoute[];
    pathname: string;
    onMove: (from: number, to: number) => void;
}

/**
 * The icon rail while it is reorderable. Sidebar loads it lazily, so @dnd-kit stays
 * out of the first chunk for every session that never reorders. The pointer sensor
 * only takes over after 4px of travel, so a plain click still navigates; Space or
 * Enter picks an icon up for the keyboard, and NavOrderEditor is the button path.
 *
 * The drag activator IS the wrapper, so it owns the single Tab stop per icon and the
 * link inside it is taken out of the tab order: a focusable link inside a
 * `role="button"` activator gave every icon two stops and two roles. Keyboard
 * navigation is the plain rail's job, one Escape away.
 */
export function SidebarSortable({ routes, pathname, onMove }: SidebarSortableProps) {
    const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );
    const ids = routes.map((route) => route.to);

    const handleDragEnd = ({ active, over }: DragEndEvent) => {
        if (over === null || active.id === over.id) {
            return;
        }

        const from = ids.indexOf(String(active.id));
        const to = ids.indexOf(String(over.id));

        if (from === -1 || to === -1) {
            return;
        }

        onMove(from, to);
    };

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {routes.map((route) => (
                    <SortableNavIcon
                        key={route.to}
                        route={route}
                        active={isNavRouteActive(route, pathname)}
                        reducedMotion={reducedMotion}
                    />
                ))}
            </SortableContext>
        </DndContext>
    );
}

interface SortableNavIconProps {
    route: NavRoute;
    active: boolean;
    reducedMotion: boolean;
}

function SortableNavIcon({ route, active, reducedMotion }: SortableNavIconProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: route.to });

    return (
        <div
            ref={setNodeRef}
            className="touch-none"
            style={{
                // Transform and opacity only: the rail animates on the compositor, and a
                // reduced-motion visitor gets the reorder with no travel animation at all.
                transform: CSS.Transform.toString(transform),
                transition: reducedMotion ? undefined : transition,
                opacity: isDragging ? 0.6 : 1,
                zIndex: isDragging ? 1 : undefined,
                cursor: isDragging ? "grabbing" : "grab",
            }}
            {...attributes}
            {...listeners}
            // dnd-kit's attributes already say `role="button"`; the label says WHICH
            // icon, which the wrapper would otherwise take from the link it hides.
            aria-label={route.label}
        >
            <NavRailLink route={route} active={active} tabIndex={-1} />
        </div>
    );
}
