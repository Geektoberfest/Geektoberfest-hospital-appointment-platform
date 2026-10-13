import api, { unwrap } from './axios';

// Refresh/logout rely on the HttpOnly cookies (and the CSRF header), never on a
// token kept in JavaScript state.
export const refresh = () => unwrap(api.post('/auth/refresh'));
export const logout = () => unwrap(api.post('/auth/logout'));

export const listSessions = () => unwrap(api.get('/auth/sessions'));
export const revokeSession = (id) => unwrap(api.delete(`/auth/sessions/${id}`));
export const revokeAllSessions = () => unwrap(api.delete('/auth/sessions'));
