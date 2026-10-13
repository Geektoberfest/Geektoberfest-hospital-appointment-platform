import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import * as authApi from '../api/authApi';
import * as sessionApi from '../api/sessionApi';
import { TOKEN_KEY } from '../api/axios';

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [doctor, setDoctor] = useState(null); // doctor profile when role === 'doctor'
  const [loading, setLoading] = useState(Boolean(localStorage.getItem(TOKEN_KEY)));

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setDoctor(null);
  }, []);

  const applySession = useCallback((data) => {
    localStorage.setItem(TOKEN_KEY, data.token);
    setUser(data.user);
    setDoctor(data.doctor || null);
    return data.user;
  }, []);

  // Restore the session on first load. An expired access token is refreshed
  // silently by the axios interceptor using the HttpOnly refresh cookie.
  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    authApi
      .getMe()
      .then((res) => {
        setUser(res.data.user);
        setDoctor(res.data.doctor || null);
      })
      .catch(clearSession)
      .finally(() => setLoading(false));
  }, [clearSession]);

  // Axios interceptor fires this when the token is rejected.
  useEffect(() => {
    window.addEventListener('auth:logout', clearSession);
    return () => window.removeEventListener('auth:logout', clearSession);
  }, [clearSession]);

  const login = useCallback(async (credentials) => applySession((await authApi.login(credentials)).data), [applySession]);
  const register = useCallback(async (payload) => applySession((await authApi.register(payload)).data), [applySession]);

  /**
   * Sign out. Revokes the current server-side session and clears the auth cookies;
   * local state is cleared even when the API call cannot be reached.
   */
  const logout = useCallback(async () => {
    try {
      await sessionApi.logout();
    } catch {
      // Nothing to do: local state is cleared below regardless.
    }
    clearSession();
  }, [clearSession]);

  const value = useMemo(
    () => ({
      user,
      doctor,
      loading,
      isAuthenticated: Boolean(user),
      login,
      register,
      logout,
      // Local-only teardown, used after a server-side revocation already happened.
      clearSession,
      setUser,
      setDoctor,
    }),
    [user, doctor, loading, login, register, logout, clearSession]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
