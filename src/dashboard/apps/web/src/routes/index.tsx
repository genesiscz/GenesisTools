import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { Loader2 } from 'lucide-react'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const { isLoading, user } = useAuth()

  // Show loading while checking auth
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#030308] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 text-amber-500 animate-spin" />
          <span className="text-sm text-muted-foreground tracking-widest uppercase">
            Initializing...
          </span>
        </div>
      </div>
    )
  }

  // Redirect based on auth status
  if (user) {
    return <Navigate to="/dashboard" />
  }

  return <Navigate to="/auth/signin" />
}
