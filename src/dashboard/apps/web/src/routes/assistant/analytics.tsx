import { createFileRoute } from '@tanstack/react-router'
import { BarChart3, Clock } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
} from '@/components/ui/feature-card'

export const Route = createFileRoute('/assistant/analytics')({
  component: AnalyticsPage,
})

function AnalyticsPage() {
  return (
    <DashboardLayout
      title="Analytics"
      description="Productivity insights and patterns"
    >
      <div className="flex flex-col items-center justify-center py-24 px-6">
        <FeatureCard color="purple" className="max-w-md w-full">
          <FeatureCardHeader className="text-center">
            <div className="w-20 h-20 mx-auto rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mb-4">
              <BarChart3 className="h-10 w-10 text-purple-400" />
            </div>

            <h2 className="text-2xl font-bold mb-2">Productivity Analytics</h2>
            <p className="text-muted-foreground">
              Understand your work patterns and optimize your productivity.
            </p>
          </FeatureCardHeader>

          <FeatureCardContent>
            <div className="flex items-center justify-center gap-2 py-4 px-6 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <Clock className="h-5 w-5 text-purple-400" />
              <span className="font-semibold text-purple-300">Coming in Phase 2</span>
            </div>

            <div className="mt-6 space-y-3 text-sm text-muted-foreground">
              <p className="flex items-start gap-2">
                <span className="text-purple-400">-</span>
                Weekly review dashboard
              </p>
              <p className="flex items-start gap-2">
                <span className="text-purple-400">-</span>
                Task completion trends
              </p>
              <p className="flex items-start gap-2">
                <span className="text-purple-400">-</span>
                Focus time heatmap
              </p>
              <p className="flex items-start gap-2">
                <span className="text-purple-400">-</span>
                Streak and badge history
              </p>
              <p className="flex items-start gap-2">
                <span className="text-purple-400">-</span>
                Distraction pattern detection
              </p>
              <p className="flex items-start gap-2">
                <span className="text-purple-400">-</span>
                AI-generated insights and suggestions
              </p>
            </div>
          </FeatureCardContent>
        </FeatureCard>
      </div>
    </DashboardLayout>
  )
}
