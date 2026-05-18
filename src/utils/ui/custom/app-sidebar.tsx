import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from "@ui/components/sidebar";
import { ChevronUp, LogOut, Settings as SettingsIcon, User as UserIcon } from "lucide-react";
import type React from "react";
import { type ReactNode, useState } from "react";

export type SidebarGroupTheme = "primary" | "purple" | "accent" | "neutral";
type IconComponent = React.ElementType<{ className?: string }>;

export interface SidebarNavItem {
    title: string;
    url: string;
    icon: IconComponent;
    /** Optional label rendered after the title (e.g. live timer "25:00") */
    accessoryLabel?: string;
}

export interface SidebarNavGroup {
    label: string;
    theme: SidebarGroupTheme;
    items: SidebarNavItem[];
}

interface AppSidebarProps {
    /** Default brand block. Omit when supplying `renderBrand`. */
    brand?: { initial: string; name: string; tagline: string; to?: string };
    /** Full override for the brand/header block (custom logo lockup). */
    renderBrand?: () => ReactNode;
    navGroups: SidebarNavGroup[];
    activePath: string;
    /** Optional account footer. Omitted entirely when not provided (e.g. tools with no auth). */
    user?: { name: string; email?: string; avatarUrl?: string; initials: string };
    onSignOut?: () => void;
    /** Per-item render override. Replaces the default menu-button rendering. */
    MenuItemComponent?: React.ComponentType<{
        item: SidebarNavItem;
        active: boolean;
        LinkComponent: React.ElementType;
    }>;
    LinkComponent: React.ElementType;
}

const groupLabel: Record<SidebarGroupTheme, string> = {
    primary: "text-sidebar-primary/70",
    purple: "text-purple-400/70",
    accent: "text-sidebar-accent/70",
    neutral: "text-sidebar-foreground/50",
};

const groupButton: Record<SidebarGroupTheme, string> = {
    primary:
        "data-[active=true]:bg-sidebar-primary/15 data-[active=true]:text-sidebar-primary data-[active=true]:border-l-2 data-[active=true]:border-sidebar-primary hover:bg-sidebar-primary/10 hover:text-sidebar-foreground transition-colors",
    purple: "data-[active=true]:bg-purple-500/15 data-[active=true]:text-purple-400 data-[active=true]:border-l-2 data-[active=true]:border-purple-500 hover:bg-purple-500/10 hover:text-sidebar-foreground transition-colors",
    accent: "data-[active=true]:bg-sidebar-accent/15 data-[active=true]:text-sidebar-accent data-[active=true]:border-l-2 data-[active=true]:border-sidebar-accent hover:bg-sidebar-accent/10 hover:text-sidebar-foreground transition-colors",
    neutral:
        "data-[active=true]:bg-sidebar-foreground/10 data-[active=true]:text-sidebar-foreground hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground transition-colors",
};

export function AppSidebar({
    brand,
    renderBrand,
    navGroups,
    activePath,
    user,
    onSignOut,
    MenuItemComponent,
    LinkComponent,
}: AppSidebarProps) {
    const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

    const isActive = (url: string) => activePath === url || activePath.startsWith(`${url}/`);

    return (
        <Sidebar className="border-r border-primary/20 bg-sidebar">
            <SidebarHeader className="border-b border-sidebar-border p-4 bg-gradient-to-b from-sidebar to-sidebar/80">
                {renderBrand
                    ? renderBrand()
                    : brand && (
                          <LinkComponent to={brand.to ?? "/dashboard"} className="flex items-center gap-3">
                              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 text-black font-bold text-sm">
                                  {brand.initial}
                              </div>
                              <div className="flex flex-col">
                                  <span className="font-semibold text-sm tracking-tight gradient-text">
                                      {brand.name}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground tracking-widest uppercase">
                                      {brand.tagline}
                                  </span>
                              </div>
                          </LinkComponent>
                      )}
            </SidebarHeader>

            <SidebarContent className="px-2">
                {navGroups.map((group) => (
                    <SidebarGroup key={group.label}>
                        {group.label && (
                            <SidebarGroupLabel
                                className={`${groupLabel[group.theme]} text-[10px] tracking-widest uppercase font-semibold`}
                            >
                                {group.label}
                            </SidebarGroupLabel>
                        )}
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {group.items.map((item) => {
                                    const active = isActive(item.url);

                                    if (MenuItemComponent) {
                                        return (
                                            <SidebarMenuItem key={item.title}>
                                                <MenuItemComponent
                                                    item={item}
                                                    active={active}
                                                    LinkComponent={LinkComponent}
                                                />
                                            </SidebarMenuItem>
                                        );
                                    }

                                    const Icon = item.icon;

                                    return (
                                        <SidebarMenuItem key={item.title}>
                                            <SidebarMenuButton
                                                asChild
                                                isActive={active}
                                                className={groupButton[group.theme]}
                                            >
                                                <LinkComponent to={item.url}>
                                                    <Icon className="h-4 w-4" />
                                                    <span>{item.title}</span>
                                                    {item.accessoryLabel && (
                                                        <span className="ml-auto text-[10px] font-mono text-amber-500/70">
                                                            {item.accessoryLabel}
                                                        </span>
                                                    )}
                                                </LinkComponent>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    );
                                })}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                ))}
            </SidebarContent>

            {user && (
                <SidebarFooter className="border-t border-sidebar-border p-2 bg-gradient-to-t from-sidebar to-sidebar/80">
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <div className="relative">
                                <SidebarMenuButton
                                    className="h-12 hover:bg-sidebar-accent/10 transition-colors"
                                    onClick={() => setIsUserMenuOpen((current) => !current)}
                                >
                                    <div className="h-7 w-7 rounded-full border border-sidebar-primary/30 overflow-hidden bg-sidebar-primary/10 text-sidebar-primary text-xs font-semibold flex items-center justify-center">
                                        {user.avatarUrl ? (
                                            <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                                        ) : (
                                            user.initials
                                        )}
                                    </div>
                                    <div className="flex flex-col items-start text-xs">
                                        <span className="font-medium text-sidebar-foreground">{user.name}</span>
                                        <span className="text-sidebar-foreground/60 text-[10px] truncate max-w-[120px]">
                                            {user.email}
                                        </span>
                                    </div>
                                    <ChevronUp className="ml-auto h-4 w-4 text-sidebar-foreground/50" />
                                </SidebarMenuButton>

                                {isUserMenuOpen && (
                                    <div className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-md border border-border/50 bg-card p-1 shadow-lg">
                                        <MenuLink LinkComponent={LinkComponent} to="/profile">
                                            <UserIcon className="mr-2 h-4 w-4" />
                                            Profile
                                        </MenuLink>
                                        <MenuLink LinkComponent={LinkComponent} to="/settings">
                                            <SettingsIcon className="mr-2 h-4 w-4" />
                                            Settings
                                        </MenuLink>
                                        <div className="my-1 h-px bg-amber-500/10" />
                                        <button
                                            type="button"
                                            onClick={() => onSignOut?.()}
                                            className="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors text-red-400 focus:text-red-400 hover:bg-accent hover:text-accent-foreground"
                                        >
                                            <LogOut className="mr-2 h-4 w-4" />
                                            Sign out
                                        </button>
                                    </div>
                                )}
                            </div>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarFooter>
            )}

            <SidebarRail />
        </Sidebar>
    );
}

function MenuLink({
    LinkComponent,
    to,
    children,
}: {
    LinkComponent: React.ElementType;
    to: string;
    children: ReactNode;
}) {
    return (
        <LinkComponent
            to={to}
            className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
        >
            {children}
        </LinkComponent>
    );
}
