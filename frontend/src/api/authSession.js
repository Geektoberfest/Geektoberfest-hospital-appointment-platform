/**
 * Shared browser-side auth session helpers.
 *
 * Kept free of axios/React so the refresh coordination logic can be unit tested
 * directly (see frontend/tests/authSession.test.js).
 */

export const REFRESH_URL = '/auth/refresh';
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'X-CSRF-Token';

// Requests that must never trigger the silent-refresh path: they either are the
// refresh endpoint itself or are expected to answer 401 on bad credentials.
const AUTH_EXCLUDED = ['/auth/login', '/auth/register', REFRESH_URL];

export const isRefreshExcluded = (url) => {
  const path = String(url || '');
  return AUTH_EXCLUDED.some((excluded) => path.startsWith(excluded));
};

/** Read a non-HttpOnly cookie (used for the CSRF double-submit token). */
export const readCookie = (name) => {
  if (typeof document === 'undefined' || !document.cookie) return '';
  const prefix = `${name}=`;
  const match = document.cookie.split('; ').find((part) => part.startsWith(prefix));
  if (!match) return '';
  const raw = match.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

// After a failed refresh, hold off before trying again so a broken session cannot
// produce a refresh storm from many failing requests.
export const REFRESH_FAILURE_COOLDOWN_MS = 5000;

/**
 * Coordinate refresh calls so the whole tab shares at most one in-flight attempt.
 *
 * - Concurrent callers (several tabs/components hitting 401 at once) await the
 *   same promise, so exactly one refresh request is sent.
 * - A failed refresh clears local auth state through `onLogout` and starts a
 *   cooldown, which prevents infinite retry loops on a terminally rejected token.
 * - A successful refresh resets the cooldown.
 */
export function createRefreshManager({
  performRefresh,
  onLogout,
  now = () => Date.now(),
  cooldownMs = REFRESH_FAILURE_COOLDOWN_MS,
} = {}) {
  let inFlight = null;
  let failedAt = 0;

  const refresh = () => {
    if (inFlight) return inFlight;
    if (failedAt && now() - failedAt < cooldownMs) {
      return Promise.reject(new Error('Refresh recently failed; not retrying yet'));
    }

    inFlight = Promise.resolve()
      .then(() => performRefresh())
      .then((result) => {
        failedAt = 0;
        return result;
      })
      .catch(async (err) => {
        failedAt = now();
        if (onLogout) await onLogout(err);
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  return {
    refresh,
    isRefreshing: () => Boolean(inFlight),
    reset: () => {
      failedAt = 0;
      inFlight = null;
    },
  };
}
