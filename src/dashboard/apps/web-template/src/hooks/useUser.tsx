import { useLocation } from "@tanstack/react-router";
import { useAuth } from "@workos-inc/authkit-react";
import { useEffect } from "react";

type UserOrNull = ReturnType<typeof useAuth>["user"];

// redirects to the sign-in page if the user is not signed in
export const useUser = (): UserOrNull => {
    const { user, isLoading, signIn } = useAuth();
    const location = useLocation();

    useEffect(() => {
        if (!isLoading && !user) {
            signIn({
                state: { returnTo: location.pathname },
            });
        } else {
            console.log(user);
        }
    }, [isLoading, user]);

    return user;
};
