import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function StatCardSkeleton() {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-4">
          <Skeleton className="h-11 w-11 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function StatCardsGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
      <StatCardSkeleton />
      <StatCardSkeleton />
      <StatCardSkeleton />
      <StatCardSkeleton />
    </div>
  )
}
