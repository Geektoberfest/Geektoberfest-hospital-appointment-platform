import api, { unwrap } from './axios';

export const login = (body) => unwrap(api.post('/auth/login', body));
export const register = (body) => unwrap(api.post('/auth/register', body));
export const getMe = () => unwrap(api.get('/auth/me'));
export const logout = () => unwrap(api.post('/auth/logout'));
