// Components
export {
	Card,
	CardHeader,
	CardFooter,
	CardTitle,
	CardAction,
	CardDescription,
	CardContent,
} from "./components/card";
export { Button, buttonVariants } from "./components/button";
export { Badge, badgeVariants } from "./components/badge";
export { Skeleton } from "./components/skeleton";
export type { SkeletonProps, SkeletonVariant } from "./components/skeleton";
export { Input } from "./components/input";
export { ScrollArea, ScrollBar } from "./components/scroll-area";
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
export {
	Command,
	CommandDialog,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandShortcut,
	CommandSeparator,
} from "./components/command";
export { DateRangePicker } from "./components/date-range-picker";
export {
	Table,
	TableHeader,
	TableBody,
	TableFooter,
	TableHead,
	TableRow,
	TableCell,
	TableCaption,
} from "./components/table";

// Layout
export { DashboardLayout } from "./layouts/DashboardLayout";
export type { DashboardLayoutProps, NavLink } from "./layouts/DashboardLayout";

// Utilities
export { cn } from "./lib/utils";

// App factory
export { createDashboardApp } from "./create-app";
export type { DashboardAppConfig } from "./create-app";

// Vite config
export { createDashboardViteConfig } from "./vite.base";
export type { DashboardViteConfig } from "./vite.base";
