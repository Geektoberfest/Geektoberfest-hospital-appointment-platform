import api, { unwrap } from './axios';

/**
 * POST /api/notifications/ticket
 * Returns a 30-second single-use ticket string used to open the SSE stream.
 * @returns {Promise<string>} ticket
 */
export const issueTicket = () =>
  unwrap(api.post('/notifications/ticket')).then((body) => body.data.ticket);
