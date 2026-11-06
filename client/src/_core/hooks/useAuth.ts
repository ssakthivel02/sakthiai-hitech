import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { useCallback, useEffect, useMemo, useState } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const utils = trpc.useUtils();
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<Error | null>(null);

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logout = useCallback(async () => {
    setLogoutPending(true);
    setLogoutError(null);

    try {
      const response = await fetch("/api/auth/revoke-all", {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });

      // 401 means the server already considers the credential invalid and the
      // endpoint clears any stale browser cookie. Other failures must not be
      // presented as a successful logout while a valid server token may remain.
      if (!response.ok && response.status !== 401) {
        const error = new Error(`Server-side session revocation failed (${response.status})`);
        setLogoutError(error);
        throw error;
      }

      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    } finally {
      setLogoutPending(false);
    }
  }, [utils]);

  const state = useMemo(() => ({
    user: meQuery.data ?? null,
    loading: meQuery.isLoading || logoutPending,
    error: meQuery.error ?? logoutError,
    isAuthenticated: Boolean(meQuery.data),
  }), [
    logoutError,
    logoutPending,
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
  ]);

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutPending) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    if (redirectPath && window.location.pathname === redirectPath) return;

    if (redirectPath) {
      window.location.href = redirectPath;
    } else {
      startLogin();
    }
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutPending,
    meQuery.isLoading,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
