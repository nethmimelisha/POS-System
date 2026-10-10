import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { onUnauthorized } from "@/api/client";
import type { User } from "@/api/types";

interface AuthValue {
  user: User | null;
  /** True until the first /auth/me check finishes. */
  loading: boolean;
  /** Set when a request returned 401 while signed in. */
  sessionExpired: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

// The session lives in an HttpOnly cookie the browser manages; the app only keeps the user's profile in memory.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const qc = useQueryClient();

  // A slow initial /auth/me must never overwrite a sign-in that completed while it was in flight.
  const loggedInDuringBoot = useRef(false);

  useEffect(() => {
    api
      .me()
      .then((r) => !loggedInDuringBoot.current && setUser(r.user))
      .catch(() => !loggedInDuringBoot.current && setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      setUser((u) => {
        if (u) setSessionExpired(true);
        return null;
      });
      qc.clear();
    });
    return () => onUnauthorized(null);
  }, [qc]);

  const login = useCallback(
    async (username: string, password: string) => {
      const { user } = await api.login(username, password);
      loggedInDuringBoot.current = true;
      qc.clear();
      setSessionExpired(false);
      setUser(user);
      return user;
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setSessionExpired(false);
      qc.clear();
    }
  }, [qc]);

  const value = useMemo(() => ({ user, loading, sessionExpired, login, logout }), [user, loading, sessionExpired, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
