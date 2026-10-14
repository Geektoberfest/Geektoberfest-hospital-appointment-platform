import axios from 'axios';

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

const api = axios.create({
  baseURL: normalizeApiUrl(import.meta.env?.VITE_API_URL),
  headers: { 'Content-Type': 'application/json' },
  // Sends the HTTP-only refresh cookie to the API.
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auth endpoints handle their own 401s; retrying them would loop.
const AUTH_PATH = /^\/auth\/(login|register|refresh|logout)/;

// Shared promise so parallel 401s trigger one refresh, not several.
let refreshing = null;
const refreshAccessToken = () => {
  if (!refreshing) {
    // Plain axios, not `api`, so this request skips the 401 handler.
    refreshing = axios
      .post(`${api.defaults.baseURL}/auth/refresh`, null, { withCredentials: true })
      .then((res) => {
        localStorage.setItem(TOKEN_KEY, res.data.data.token);
        return res.data.data.token;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
};

// An expired access token is renewed from the refresh cookie and the call is retried.
// If renewal fails, the user is signed out (login failures are ignored).
api.interceptors.response.use(
  (res) => res,
  (error) => {
    const original = error.config;
    const url = original?.url || '';
    if (error.response?.status !== 401 || AUTH_PATH.test(url) || !localStorage.getItem(TOKEN_KEY)) {
      return Promise.reject(error);
    }
    if (original._retry) {
      window.dispatchEvent(new Event('auth:logout'));
      return Promise.reject(error);
    }
    original._retry = true;
    return refreshAccessToken()
      .then(() => api(original))
      .catch(() => {
        window.dispatchEvent(new Event('auth:logout'));
        return Promise.reject(error);
      });
  }
);

/** Unwrap { success, message, data } and return the full payload. */
export const unwrap = (promise) => promise.then((res) => res.data);

export default api;
