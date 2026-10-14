import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import * as authApi from '../api/authApi';
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

  // Restore the session on first load.
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

  // Revokes this device's refresh session on the server; local state clears either way.
  const logout = useCallback(() => {
    authApi.logout().catch(() => {});
    clearSession();
  }, [clearSession]);

  const value = useMemo(
    () => ({ user, doctor, loading, isAuthenticated: Boolean(user), login, register, logout, setUser, setDoctor }),
    [user, doctor, loading, login, register, logout, clearSession]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
