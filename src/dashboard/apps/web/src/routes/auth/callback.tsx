import { createFileRoute } from '@tanstack/react-router'
import { handleCallbackRoute } from '@workos/authkit-tanstack-react-start'

export const Route = createFileRoute('/auth/callback')({
  server: {
    handlers: {
      GET: handleCallbackRoute({
        onSuccess: async ({ user, authenticationMethod }) => {
          console.log('Authentication successful:', user.email, authenticationMethod)
        },
        onError: ({ error }) => {
          console.error('Authentication failed:', error)
          return new Response(
            JSON.stringify({
              error: {
                message: 'Authentication failed',
                description: 'Something went wrong during sign in. Please try again.',
              },
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        },
      }),
    },
  },
  component: CallbackPage,
})

function CallbackPage() {
  return (
    <div className="min-h-screen bg-[#030308] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin h-8 w-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-gray-400">Processing authentication...</p>
      </div>
    </div>
  )
}
