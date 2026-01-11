import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import {
  Mail,
  Lock,
  Loader2,
  Github,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuthLayout } from '@/components/auth'
import { signInFn, getOAuthUrlFn } from '@/lib/auth-actions'
import type { AuthError } from '@/lib/auth-actions'

export const Route = createFileRoute('/auth/signin')({
  component: SignInPage,
  validateSearch: (search: Record<string, unknown>) => ({
    reset: search.reset === 'success',
  }),
})

function SignInPage() {
  const { reset: resetSuccess } = useSearch({ from: '/auth/signin' })
  const navigate = useNavigate()
  const [authState, setAuthState] = useState<AuthError | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)
    setAuthState(null)

    const formData = new FormData(e.currentTarget)
    const email = formData.get('email') as string
    const password = formData.get('password') as string

    try {
      const result = await signInFn({
        data: { email, password },
      })

      // Check if result has success property (successful response)
      if (result && typeof result === 'object' && 'success' in result && result.success) {
        // Store session in localStorage or cookie
        const sessionData = result as { success: true; session: string; user: unknown }
        // Store encrypted session
        if (typeof window !== 'undefined') {
          localStorage.setItem('wos-session', sessionData.session)
        }
        // Redirect to dashboard
        await navigate({ to: '/dashboard' })
      } else {
        // Error response
        setAuthState(result as AuthError)
      }
    } catch (err) {
      setAuthState({
        code: 'unknown',
        message: err instanceof Error ? err.message : 'An error occurred',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleOAuthSignIn = async (provider: 'GoogleOAuth' | 'GitHubOAuth') => {
    try {
      setOauthLoading(provider)
      const url = await getOAuthUrlFn({ data: { provider } })
      if (typeof window !== 'undefined') {
        window.location.href = url
      }
    } catch (err) {
      setAuthState({
        code: 'unknown',
        message: err instanceof Error ? err.message : 'Failed to start OAuth',
      })
      setOauthLoading(null)
    }
  }

  return (
    <AuthLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-white">Welcome back</h1>
          <p className="text-gray-400">Sign in to your account to continue</p>
        </div>

        {/* Success message for password reset */}
        {resetSuccess && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              Password reset successful. Please sign in with your new password.
            </span>
          </div>
        )}

        {/* Error message */}
        {authState && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{authState.message}</span>
          </div>
        )}

        {/* OAuth Buttons */}
        <div className="space-y-3">
          <Button
            type="button"
            variant="outline"
            className="w-full h-11 border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/5 text-white"
            onClick={() => handleOAuthSignIn('GoogleOAuth')}
            disabled={!!oauthLoading || isLoading}
          >
            {oauthLoading === 'GoogleOAuth' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            Continue with Google
          </Button>

          <Button
            type="button"
            variant="outline"
            className="w-full h-11 border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/5 text-white"
            onClick={() => handleOAuthSignIn('GitHubOAuth')}
            disabled={!!oauthLoading || isLoading}
          >
            {oauthLoading === 'GitHubOAuth' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Github className="mr-2 h-4 w-4" />
            )}
            Continue with GitHub
          </Button>
        </div>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-amber-500/10" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-[#030308] px-4 text-gray-500">Or continue with email</span>
          </div>
        </div>

        {/* Sign In Form */}
        <form onSubmit={handleSubmit} className="space-y-4" suppressHydrationWarning>
          {/* Email Field */}
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium text-gray-300">
              Email
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="off"
                required
                placeholder="you@example.com"
                className="w-full h-11 pl-10 pr-4 rounded-lg bg-[#1a1a1f] border border-amber-500/20 focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20 outline-none transition-all placeholder:text-gray-600 text-white"
              />
            </div>
          </div>

          {/* Password Field */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="text-sm font-medium text-gray-300">
                Password
              </label>
              <Link
                to="/auth/forgot-password"
                className="text-xs text-amber-500 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Enter your password"
                className="w-full h-11 pl-10 pr-4 rounded-lg bg-[#1a1a1f] border border-amber-500/20 focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20 outline-none transition-all placeholder:text-gray-600 text-white"
              />
            </div>
          </div>

          {/* Submit Button */}
          <Button
            type="submit"
            className="w-full h-11 text-base font-semibold neon-glow btn-glow"
            disabled={isLoading || !!oauthLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </form>

        {/* Sign Up Link */}
        <div className="text-center text-sm">
          <span className="text-gray-500">Don't have an account? </span>
          <Link to="/auth/signup" className="text-amber-500 font-medium hover:underline">
            Sign up
          </Link>
        </div>
      </div>
    </AuthLayout>
  )
}
