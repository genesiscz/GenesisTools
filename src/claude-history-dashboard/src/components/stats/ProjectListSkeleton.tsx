import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { FolderOpen, Wrench } from "lucide-react"

// Deterministic widths to avoid SSR hydration mismatch
const PROJECT_SKELETON_WIDTHS = ['75%', '85%', '65%', '90%', '70%']
const TOOL_BADGE_WIDTHS = [72, 84, 68, 96, 76, 88, 64, 92, 80, 70, 86, 74]

export function ProjectListSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="w-5 h-5 text-secondary animate-pulse-glow" />
          <Skeleton className="h-5 w-28" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <Skeleton
                    className="h-4"
                    style={{
                      width: PROJECT_SKELETON_WIDTHS[i],
                      animationDelay: `${i * 150}ms`,
                    }}
                  />
                  <Skeleton className="h-3 w-8" />
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <Skeleton
                    variant="data-stream"
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(20, 100 - i * 15)}%`,
                      animationDelay: `${i * 100}ms`,
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function ToolBadgesSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="w-5 h-5 text-primary animate-pulse-glow" />
          <Skeleton className="h-5 w-32" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-6 rounded-full"
              style={{
                width: `${TOOL_BADGE_WIDTHS[i]}px`,
                animationDelay: `${i * 50}ms`,
              }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
