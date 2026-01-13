import { useEffect } from 'react'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { useLocation, useNavigate } from '@tanstack/react-router'

// redirects to the sign-in page if the user is not signed in
export const useUser = () => {
  const { user, loading } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) {
      navigate({
        to: '/auth/signin',
        search: { returnTo: location.pathname },
      })
    }
  }, [loading, user, location.pathname, navigate])

  return user
}
