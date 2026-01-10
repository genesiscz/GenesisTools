import { createFileRoute, Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuthLayout } from '@/components/auth'

export const Route = createFileRoute('/auth/error')({
  component: AuthErrorPage,
  validateSearch: (search: Record<string, unknown>) => ({
    error: search.error as string | undefined,
    description: search.description as string | undefined,
  }),
})

const errorMessages: Record<string, string> = {
  access_denied: 'You denied access to your account',
  invalid_request: 'The authentication request was invalid',
  unauthorized_client: 'This application is not authorized',
  unsupported_response_type: 'The response type is not supported',
  invalid_scope: 'The requested scope is invalid',
  server_error: 'The authentication server encountered an error',
  temporarily_unavailable: 'The server is temporarily unavailable',
  default: 'An unexpected error occurred during authentication',
}

function AuthErrorPage() {
  const { error, description } = Route.useSearch()

  const errorTitle = error
    ? errorMessages[error] || errorMessages.default
    : errorMessages.default

  return (
    <AuthLayout>
      <div className="space-y-6">
        {/* Header with glitch effect */}
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center glitch-effect">
              <AlertTriangle className="h-8 w-8 text-red-500" />
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Authentication Error
          </h1>
          <p className="text-gray-400">{errorTitle}</p>
          {description && (
            <p className="text-sm text-gray-500 max-w-sm mx-auto">
              {description}
            </p>
          )}
        </div>

        {/* Error code display */}
        {error && (
          <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <span>Error code</span>
            </div>
            <code className="text-sm text-red-400 font-mono">{error}</code>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-3">
          <Link to="/auth/signin">
            <Button className="w-full h-11 bg-amber-500 hover:bg-amber-600 text-black neon-glow">
              <RefreshCw className="h-4 w-4 mr-2" />
              Try again
            </Button>
          </Link>
          <Link to="/">
            <Button
              variant="outline"
              className="w-full h-11 border-amber-500/20 text-white hover:bg-amber-500/5"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to home
            </Button>
          </Link>
        </div>

        {/* Help text */}
        <div className="text-center text-sm text-gray-500">
          <p>
            If this problem persists, please{' '}
            <a href="mailto:support@example.com" className="text-amber-500 hover:underline">
              contact support
            </a>
          </p>
        </div>
      </div>
    </AuthLayout>
  )
}
