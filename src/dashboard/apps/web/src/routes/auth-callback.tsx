import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { AuthLayout } from '@/components/auth'
import { handleOAuthCallback } from '@/lib/auth.functions'

export const Route = createFileRoute('/auth-callback')({
  component: CallbackPage,
  validateSearch: (search: Record<string, unknown>) => ({
    code: search.code as string | undefined,
    error: search.error as string | undefined,
    error_description: search.error_description as string | undefined,
  }),
})

function CallbackPage() {
  const navigate = useNavigate()
  const { code, error, error_description } = Route.useSearch()
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    // If there's an OAuth error from the provider
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

    // If we have a code, exchange it for tokens
    if (code) {
      handleOAuthCallback({ data: { code } })
        .then((result) => {
          if (result.success) {
            // Force a full page reload to pick up the new cookie
            window.location.href = '/dashboard'
          }
        })
        .catch((err) => {
          console.error('OAuth callback error:', err)
          setAuthError(err instanceof Error ? err.message : 'Authentication failed')
        })
    }
  }, [code, error, error_description, navigate])

  if (authError) {
    return (
      <AuthLayout>
        <div className="space-y-6">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center">
                <AlertCircle className="h-8 w-8 text-red-500" />
              </div>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Authentication Failed
            </h1>
            <p className="text-gray-400">
              {authError}
            </p>
            <button
              onClick={() => navigate({ to: '/auth/signin' })}
              className="text-amber-500 hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      </AuthLayout>
    )
  }

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
