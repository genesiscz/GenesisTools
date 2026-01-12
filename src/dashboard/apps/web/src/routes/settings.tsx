import { createFileRoute } from '@tanstack/react-router'
import {
  Bell,
  Moon,
  Sun,
  Globe,
  Shield,
  Database,
  Palette,
  Monitor,
} from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { useSettings } from '@/lib/hooks/useSettings'
import { toast } from 'sonner'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const { settings, updateSetting } = useSettings()

  const handleSettingChange = <K extends keyof typeof settings>(
    key: K,
    value: typeof settings[K],
    label: string
  ) => {
    updateSetting(key, value)
    toast.success(`${label} ${value ? 'enabled' : 'disabled'}`)
  }
  return (
    <DashboardLayout title="Settings" description="Configure your NEXUS experience">
      <div className="max-w-3xl space-y-6">
        {/* Appearance */}
        <Card className="border-primary/20 bg-card/80 backdrop-blur-sm hover:border-primary/40 transition-colors">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Palette className="h-4 w-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">Appearance</CardTitle>
                <CardDescription className="text-xs">
                  Customize how NEXUS looks and feels
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Theme</Label>
                <p className="text-xs text-muted-foreground">Choose your preferred color scheme</p>
              </div>
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
            </div>

            <Separator className="bg-primary/10" />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Scan Lines Effect</Label>
                <p className="text-xs text-muted-foreground">Enable retro CRT scan lines</p>
              </div>
              <Switch
                checked={settings.scanLinesEffect}
                onCheckedChange={(checked) => handleSettingChange('scanLinesEffect', checked, 'Scan lines')}
                className="data-[state=checked]:bg-primary"
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Grid Background</Label>
                <p className="text-xs text-muted-foreground">Show cyber grid background</p>
              </div>
              <Switch
                checked={settings.gridBackground}
                onCheckedChange={(checked) => handleSettingChange('gridBackground', checked, 'Grid background')}
                className="data-[state=checked]:bg-primary"
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Reduced Motion</Label>
                <p className="text-xs text-muted-foreground">Minimize animations</p>
              </div>
              <Switch
                checked={settings.reducedMotion}
                onCheckedChange={(checked) => handleSettingChange('reducedMotion', checked, 'Reduced motion')}
                className="data-[state=checked]:bg-primary"
              />
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card className="border-accent/20 bg-card/80 backdrop-blur-sm hover:border-accent/40 transition-colors">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent/10">
                <Bell className="h-4 w-4 text-accent" />
              </div>
              <div>
                <CardTitle className="text-base">Notifications</CardTitle>
                <CardDescription className="text-xs">
                  Manage how you receive alerts
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Push Notifications</Label>
                <p className="text-xs text-muted-foreground">Get notified in your browser</p>
              </div>
              <Switch
                checked={settings.pushNotifications}
                onCheckedChange={(checked) => handleSettingChange('pushNotifications', checked, 'Push notifications')}
                className="data-[state=checked]:bg-accent"
              />
            </div>

            <Separator className="bg-accent/10" />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Sound Effects</Label>
                <p className="text-xs text-muted-foreground">Play sounds for timer events</p>
              </div>
              <Switch
                checked={settings.soundEffects}
                onCheckedChange={(checked) => handleSettingChange('soundEffects', checked, 'Sound effects')}
                className="data-[state=checked]:bg-accent"
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Timer Complete Alert</Label>
                <p className="text-xs text-muted-foreground">Visual flash when countdown ends</p>
              </div>
              <Switch
                checked={settings.timerCompleteAlert}
                onCheckedChange={(checked) => handleSettingChange('timerCompleteAlert', checked, 'Timer complete alert')}
                className="data-[state=checked]:bg-accent"
              />
            </div>
          </CardContent>
        </Card>

        {/* Data & Privacy */}
        <Card className="border-secondary/20 bg-card/80 backdrop-blur-sm hover:border-secondary/40 transition-colors">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-secondary/10">
                <Shield className="h-4 w-4 text-secondary" />
              </div>
              <div>
                <CardTitle className="text-base">Data & Privacy</CardTitle>
                <CardDescription className="text-xs">
                  Control your data and sync settings
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Cloud Sync</Label>
                <p className="text-xs text-muted-foreground">Sync data across devices</p>
              </div>
              <Switch
                checked={settings.cloudSync}
                onCheckedChange={(checked) => handleSettingChange('cloudSync', checked, 'Cloud sync')}
                className="data-[state=checked]:bg-secondary"
              />
            </div>

            <Separator className="bg-secondary/10" />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Local Storage</Label>
                <p className="text-xs text-muted-foreground">Keep data offline</p>
              </div>
              <Switch
                checked={settings.localStorage}
                onCheckedChange={(checked) => handleSettingChange('localStorage', checked, 'Local storage')}
                className="data-[state=checked]:bg-secondary"
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Analytics</Label>
                <p className="text-xs text-muted-foreground">Help improve NEXUS</p>
              </div>
              <Switch
                checked={settings.analytics}
                onCheckedChange={(checked) => handleSettingChange('analytics', checked, 'Analytics')}
                className="data-[state=checked]:bg-secondary"
              />
            </div>

            <Separator className="bg-secondary/10" />

            <div className="pt-2">
              <Button variant="outline" size="sm" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive">
                <Database className="h-3 w-3 mr-2" />
                Clear Local Data
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Language */}
        <Card className="border-muted/30 bg-card/80 backdrop-blur-sm hover:border-muted/50 transition-colors">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted/20">
                <Globe className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <CardTitle className="text-base">Language & Region</CardTitle>
                <CardDescription className="text-xs">
                  Set your locale preferences
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Language</Label>
                <p className="text-xs text-muted-foreground">Interface language</p>
              </div>
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
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Time Format</Label>
                <p className="text-xs text-muted-foreground">12-hour or 24-hour</p>
              </div>
              <Select defaultValue="24h">
                <SelectTrigger className="w-40 bg-card/50 border-muted/20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-muted/20">
                  <SelectItem value="12h">12-hour (AM/PM)</SelectItem>
                  <SelectItem value="24h">24-hour</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
