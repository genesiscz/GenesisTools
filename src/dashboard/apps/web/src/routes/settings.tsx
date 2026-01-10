import { createFileRoute } from '@tanstack/react-router'
import { useAuth } from '@workos-inc/authkit-react'
import {
  Bell,
  Moon,
  Sun,
  Globe,
  Shield,
  Database,
  Palette,
  Volume2,
  Monitor,
} from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <DashboardLayout title="Settings" description="Configure your NEXUS experience">
      <div className="max-w-3xl space-y-6">
        {/* Appearance */}
        <Card className="border-amber-500/20 bg-[#0a0a14]/80 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Palette className="h-4 w-4 text-amber-400" />
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
                <SelectTrigger className="w-32 bg-black/30 border-amber-500/20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a0a14] border-amber-500/20">
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

            <Separator className="bg-amber-500/10" />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Scan Lines Effect</Label>
                <p className="text-xs text-muted-foreground">Enable retro CRT scan lines</p>
              </div>
              <Switch defaultChecked className="data-[state=checked]:bg-amber-500" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Grid Background</Label>
                <p className="text-xs text-muted-foreground">Show cyber grid background</p>
              </div>
              <Switch defaultChecked className="data-[state=checked]:bg-amber-500" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Reduced Motion</Label>
                <p className="text-xs text-muted-foreground">Minimize animations</p>
              </div>
              <Switch className="data-[state=checked]:bg-amber-500" />
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card className="border-cyan-500/20 bg-[#0a0a14]/80 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-cyan-500/10">
                <Bell className="h-4 w-4 text-cyan-400" />
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
              <Switch defaultChecked className="data-[state=checked]:bg-cyan-500" />
            </div>

            <Separator className="bg-cyan-500/10" />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Sound Effects</Label>
                <p className="text-xs text-muted-foreground">Play sounds for timer events</p>
              </div>
              <Switch defaultChecked className="data-[state=checked]:bg-cyan-500" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Timer Complete Alert</Label>
                <p className="text-xs text-muted-foreground">Visual flash when countdown ends</p>
              </div>
              <Switch defaultChecked className="data-[state=checked]:bg-cyan-500" />
            </div>
          </CardContent>
        </Card>

        {/* Data & Privacy */}
        <Card className="border-emerald-500/20 bg-[#0a0a14]/80 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Shield className="h-4 w-4 text-emerald-400" />
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
              <Switch defaultChecked className="data-[state=checked]:bg-emerald-500" />
            </div>

            <Separator className="bg-emerald-500/10" />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Local Storage</Label>
                <p className="text-xs text-muted-foreground">Keep data offline</p>
              </div>
              <Switch defaultChecked className="data-[state=checked]:bg-emerald-500" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">Analytics</Label>
                <p className="text-xs text-muted-foreground">Help improve NEXUS</p>
              </div>
              <Switch className="data-[state=checked]:bg-emerald-500" />
            </div>

            <Separator className="bg-emerald-500/10" />

            <div className="pt-2">
              <Button variant="outline" size="sm" className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-400">
                <Database className="h-3 w-3 mr-2" />
                Clear Local Data
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Language */}
        <Card className="border-purple-500/20 bg-[#0a0a14]/80 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Globe className="h-4 w-4 text-purple-400" />
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
                <SelectTrigger className="w-40 bg-black/30 border-purple-500/20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a0a14] border-purple-500/20">
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
                <SelectTrigger className="w-40 bg-black/30 border-purple-500/20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a0a14] border-purple-500/20">
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
