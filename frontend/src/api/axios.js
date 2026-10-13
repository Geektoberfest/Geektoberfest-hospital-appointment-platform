import axios from 'axios';
// Explicit .js extension keeps this module loadable by plain Node ESM (the test runner).
import { createRefreshManager, isRefreshExcluded, readCookie, CSRF_COOKIE, CSRF_HEADER } from './authSession.js';

export const TOKEN_KEY = 'hospital_token';

/**
 * Normalizes the API base URL.
 * Ensures the base URL always points to the '/api' prefix, preventing 404s
 * when VITE_API_URL is configured without '/api' (e.g. on Vercel deployment),
 * and handles trailing slashes properly.
 */
export const normalizeApiUrl = (url) => {
  const fallback = 'http://localhost:5000/api';
  if (!url || typeof url !== 'string') return fallback;
  const cleaned = url.trim().replace(/\/+$/, '');
  if (!cleaned) return fallback;
  return cleaned.endsWith('/api') ? cleaned : `${cleaned}/api`;
};

const MUTATING_METHODS = ['post', 'put', 'patch', 'delete'];

const api = axios.create({
  baseURL: normalizeApiUrl(import.meta.env?.VITE_API_URL),
  headers: { 'Content-Type': 'application/json' },
  // Required so the browser stores and returns the HttpOnly refresh cookie.
  withCredentials: true,
});

export const clearAuthState = () => {
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event('auth:logout'));
};

/**
 * Same-tab single-flight refresh used by the response interceptor.
 * The server-side grace window covers genuinely concurrent tabs.
 */
export const authRefresh = createRefreshManager({
  performRefresh: async () => {
    // Uses the shared instance so the CSRF header and cookie credentials apply.
    const res = await api.post('/auth/refresh', {});
    const token = res.data?.data?.token;
    if (!token) throw new Error('Refresh response did not include an access token');
    localStorage.setItem(TOKEN_KEY, token);
    return res.data;
  },
  onLogout: clearAuthState,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Double-submit CSRF token for state-changing requests (the refresh cookie is
  // sent cross-site in production, so it cannot be the only proof of intent).
  if (MUTATING_METHODS.includes((config.method || 'get').toLowerCase())) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) config.headers[CSRF_HEADER] = csrf;
  }
  return config;
});

/**
 * Response handling:
 * - a 401 on a normal request triggers one silent refresh and one retry,
 * - a failed refresh (or a retry that is rejected again) signs the user out,
 * - login/register/refresh responses never re-enter the refresh path.
 */
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const config = error.config || {};
    const url = config.url || '';
    const status = error.response?.status;

    if (status === 401 && !config.__isRetryRequest && !isRefreshExcluded(url)) {
      try {
        await authRefresh.refresh();
        const token = localStorage.getItem(TOKEN_KEY);
        config.__isRetryRequest = true;
        config.headers = { ...(config.headers || {}) };
        if (token) config.headers.Authorization = `Bearer ${token}`;
        return api(config);
      } catch {
        // authRefresh already cleared local state via onLogout.
        return Promise.reject(error);
      }
    }

    if (status === 401 && !isRefreshExcluded(url) && localStorage.getItem(TOKEN_KEY)) {
      clearAuthState();
    }
    return Promise.reject(error);
  }
);

/** Unwrap { success, message, data } and return the full payload. */
export const unwrap = (promise) => promise.then((res) => res.data);

export default api;
