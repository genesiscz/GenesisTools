import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useAuth } from '@workos-inc/authkit-react'
import { Loader2 } from 'lucide-react'
import { AuthLayout } from '@/components/auth'

export const Route = createFileRoute('/auth/callback')({
  component: CallbackPage,
  validateSearch: (search: Record<string, unknown>) => ({
    code: search.code as string | undefined,
    state: search.state as string | undefined,
    error: search.error as string | undefined,
    error_description: search.error_description as string | undefined,
  }),
})

function CallbackPage() {
  const navigate = useNavigate()
  const { isLoading, user } = useAuth()
  const { error, error_description } = Route.useSearch()

  useEffect(() => {
    // If there's an OAuth error, redirect to error page
    if (error) {
      navigate({
        to: '/auth/error',
        search: {
          error,
          description: error_description,
        },
      })
      return
    }

    // If user is authenticated, redirect to home
    if (!isLoading && user) {
      navigate({ to: '/' })
    }
  }, [isLoading, user, error, error_description, navigate])

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="h-16 w-16 rounded-full bg-amber-500/10 flex items-center justify-center">
              <Loader2 className="h-8 w-8 text-amber-500 animate-spin" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Authenticating...
          </h1>
          <p className="text-gray-400">
            Please wait while we complete your sign in
          </p>
        </div>

        {/* Animated progress indicator */}
        <div className="flex justify-center gap-1">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
      </div>
    </AuthLayout>
  )
}
