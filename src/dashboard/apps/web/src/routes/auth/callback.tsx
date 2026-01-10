import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Dynamic import inside handler - this code is tree-shaken from client bundle
        const { handleCallbackRoute } = await import('@workos/authkit-tanstack-react-start')

        const handler = handleCallbackRoute({
          onSuccess: async ({ user }) => {
            console.log('Authentication successful:', user.email)
          },
          onError: ({ error }) => {
            console.error('Authentication failed:', error)
          },
        })

        return handler({ request })
      },
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
