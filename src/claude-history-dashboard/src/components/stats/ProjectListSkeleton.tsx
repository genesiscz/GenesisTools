import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { FolderOpen, Wrench } from "lucide-react"

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
                      width: `${60 + Math.random() * 30}%`,
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
                width: `${60 + Math.random() * 40}px`,
                animationDelay: `${i * 50}ms`,
              }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
