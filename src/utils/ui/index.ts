// Components

export { Badge, badgeVariants } from "./components/badge";
export { Button, buttonVariants } from "./components/button";
export {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "./components/card";
export {
    Command,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from "./components/command";
export { DateRangePicker } from "./components/date-range-picker";
export {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger,
} from "./components/dialog";
export { Input } from "./components/input";
export { ScrollArea, ScrollBar } from "./components/scroll-area";
export type { SkeletonProps, SkeletonVariant } from "./components/skeleton";
export { Skeleton } from "./components/skeleton";
export {
    Table,
    TableBody,
    TableCaption,
    TableCell,
    TableFooter,
    TableHead,
    TableHeader,
    TableRow,
} from "./components/table";
export type { DashboardAppConfig } from "./create-app";
// App factory
export { createDashboardApp } from "./create-app";
export type { DashboardLayoutProps, NavLink } from "./layouts/DashboardLayout";
// Layout
export { DashboardLayout } from "./layouts/DashboardLayout";
// Utilities
export { cn } from "./lib/utils";
export type { DashboardViteConfig } from "./vite.base";
// Vite config
export { createDashboardViteConfig } from "./vite.base";
