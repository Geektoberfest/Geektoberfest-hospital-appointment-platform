import api, { unwrap } from './axios';

export const getStats = () => unwrap(api.get('/users/stats'));
export const getAnalytics = () => unwrap(api.get('/admin/analytics'));
export const getAuditLogs = (params) => unwrap(api.get('/admin/audit-logs', { params }));
export const listPatients = (params) => unwrap(api.get('/patients', { params }));
export const updateUser = (id, body) => unwrap(api.put(`/users/${id}`, body));
