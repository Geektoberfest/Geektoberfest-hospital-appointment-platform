import api, { unwrap } from './axios';

export const bookAppointment = (body) => unwrap(api.post('/appointments', body));
export const getMyAppointments = (params) => unwrap(api.get('/appointments/my', { params }));
export const listAllAppointments = (params) => unwrap(api.get('/appointments', { params }));
export const getAppointment = (id) => unwrap(api.get(`/appointments/${id}`));
export const cancelAppointment = (id, body) => unwrap(api.patch(`/appointments/${id}/cancel`, body));
export const updateAppointmentStatus = (id, body) => unwrap(api.patch(`/appointments/${id}/status`, body));
export const submitReview = (id, body) => unwrap(api.post(`/appointments/${id}/review`, body));
