import { createFileRoute } from "@tanstack/react-router";
import { Bell, Database, Globe, Monitor, Moon, Palette, Shield, Sun } from "lucide-react";
import { toast } from "sonner";
import { DashboardLayout } from "@/components/dashboard";
import { SettingCard, SettingRow } from "@/components/settings";
import { Button } from "@ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Separator } from "@ui/components/separator";
import { Switch } from "@ui/components/switch";
import { useSettings } from "@/lib/hooks/useSettings";

export const Route = createFileRoute("/settings")({
    component: SettingsPage,
});

function SettingsPage() {
    const { settings, updateSetting } = useSettings();

    const handleSettingChange = <K extends keyof typeof settings>(
        key: K,
        value: (typeof settings)[K],
        label: string
    ) => {
        updateSetting(key, value);
        toast.success(`${label} ${value ? "enabled" : "disabled"}`);
    };

    return (
        <DashboardLayout title="Settings" description="Configure your NEXUS experience">
            <div className="max-w-3xl space-y-6">
                {/* Appearance */}
                <SettingCard
                    title="Appearance"
                    description="Customize how NEXUS looks and feels"
                    icon={<Palette className="h-4 w-4" />}
                    tint="primary"
                >
                    <SettingRow label="Theme" description="Choose your preferred color scheme">
                        <Select defaultValue="dark">
                            <SelectTrigger className="w-32 bg-card/50 border-primary/20">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-card border-primary/20">
                                <SelectItem value="dark">
                                    <div className="flex items-center gap-2">
                                        <Moon className="h-3 w-3" /> Dark
                                    </div>
                                </SelectItem>
                                <SelectItem value="light">
                                    <div className="flex items-center gap-2">
                                        <Sun className="h-3 w-3" /> Light
                                    </div>
                                </SelectItem>
                                <SelectItem value="system">
                                    <div className="flex items-center gap-2">
                                        <Monitor className="h-3 w-3" /> System
                                    </div>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingRow>

                    <Separator className="bg-primary/10" />

                    <SettingRow label="Scan Lines Effect" description="Enable retro CRT scan lines">
                        <Switch
                            checked={settings.scanLinesEffect}
                            onCheckedChange={(checked) =>
                                handleSettingChange("scanLinesEffect", checked, "Scan lines")
                            }
                            className="data-[state=checked]:bg-primary"
                        />
                    </SettingRow>

                    <SettingRow label="Grid Background" description="Show cyber grid background">
                        <Switch
                            checked={settings.gridBackground}
                            onCheckedChange={(checked) =>
                                handleSettingChange("gridBackground", checked, "Grid background")
                            }
                            className="data-[state=checked]:bg-primary"
                        />
                    </SettingRow>

                    <SettingRow label="Reduced Motion" description="Minimize animations">
                        <Switch
                            checked={settings.reducedMotion}
                            onCheckedChange={(checked) =>
                                handleSettingChange("reducedMotion", checked, "Reduced motion")
                            }
                            className="data-[state=checked]:bg-primary"
                        />
                    </SettingRow>
                </SettingCard>

                {/* Notifications */}
                <SettingCard
                    title="Notifications"
                    description="Manage how you receive alerts"
                    icon={<Bell className="h-4 w-4" />}
                    tint="accent"
                >
                    <SettingRow label="Push Notifications" description="Get notified in your browser">
                        <Switch
                            checked={settings.pushNotifications}
                            onCheckedChange={(checked) =>
                                handleSettingChange("pushNotifications", checked, "Push notifications")
                            }
                            className="data-[state=checked]:bg-accent"
                        />
                    </SettingRow>

                    <Separator className="bg-accent/10" />

                    <SettingRow label="Sound Effects" description="Play sounds for timer events">
                        <Switch
                            checked={settings.soundEffects}
                            onCheckedChange={(checked) =>
                                handleSettingChange("soundEffects", checked, "Sound effects")
                            }
                            className="data-[state=checked]:bg-accent"
                        />
                    </SettingRow>

                    <SettingRow label="Timer Complete Alert" description="Visual flash when countdown ends">
                        <Switch
                            checked={settings.timerCompleteAlert}
                            onCheckedChange={(checked) =>
                                handleSettingChange("timerCompleteAlert", checked, "Timer complete alert")
                            }
                            className="data-[state=checked]:bg-accent"
                        />
                    </SettingRow>
                </SettingCard>

                {/* Data & Privacy */}
                <SettingCard
                    title="Data & Privacy"
                    description="Control your data and sync settings"
                    icon={<Shield className="h-4 w-4" />}
                    tint="secondary"
                >
                    <SettingRow label="Cloud Sync" description="Sync data across devices">
                        <Switch
                            checked={settings.cloudSync}
                            onCheckedChange={(checked) => handleSettingChange("cloudSync", checked, "Cloud sync")}
                            className="data-[state=checked]:bg-secondary"
                        />
                    </SettingRow>

                    <Separator className="bg-secondary/10" />

                    <SettingRow label="Local Storage" description="Keep data offline">
                        <Switch
                            checked={settings.localStorage}
                            onCheckedChange={(checked) =>
                                handleSettingChange("localStorage", checked, "Local storage")
                            }
                            className="data-[state=checked]:bg-secondary"
                        />
                    </SettingRow>

                    <SettingRow label="Analytics" description="Help improve NEXUS">
                        <Switch
                            checked={settings.analytics}
                            onCheckedChange={(checked) => handleSettingChange("analytics", checked, "Analytics")}
                            className="data-[state=checked]:bg-secondary"
                        />
                    </SettingRow>

                    <Separator className="bg-secondary/10" />

                    <div className="pt-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                            <Database className="h-3 w-3 mr-2" />
                            Clear Local Data
                        </Button>
                    </div>
                </SettingCard>

                {/* Language */}
                <SettingCard
                    title="Language & Region"
                    description="Set your locale preferences"
                    icon={<Globe className="h-4 w-4" />}
                    tint="muted"
                >
                    <SettingRow label="Language" description="Interface language">
                        <Select defaultValue="en">
                            <SelectTrigger className="w-40 bg-card/50 border-muted/20">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-card border-muted/20">
                                <SelectItem value="en">English</SelectItem>
                                <SelectItem value="cs">Čeština</SelectItem>
                                <SelectItem value="de">Deutsch</SelectItem>
                                <SelectItem value="ja">日本語</SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingRow>

                    <SettingRow label="Time Format" description="12-hour or 24-hour">
                        <Select defaultValue="24h">
                            <SelectTrigger className="w-40 bg-card/50 border-muted/20">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-card border-muted/20">
                                <SelectItem value="12h">12-hour (AM/PM)</SelectItem>
                                <SelectItem value="24h">24-hour</SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingRow>
                </SettingCard>
            </div>
        </DashboardLayout>
    );
}
