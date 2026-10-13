import api, { normalizeApiUrl, unwrap } from './axios';
import { streamUrl } from './notificationStream';

/**
 * Ask the API for a single-use ticket for the notification stream.
 *
 * The request is an ordinary authenticated call, so the axios instance attaches the
 * bearer access token (and silently refreshes it when it expired). The access token is
 * therefore never part of the stream URL.
 */
export const requestTicket = async () => {
  const payload = await unwrap(api.post('/notifications/ticket'));
  const ticket = payload?.data?.ticket;
  if (!ticket) throw new Error('Notification ticket response did not include a ticket');
  return ticket;
};

/** Absolute stream URL for a ticket, honouring the configured API base URL. */
export const buildStreamUrl = (ticket, baseUrl) =>
  streamUrl(baseUrl || normalizeApiUrl(import.meta.env?.VITE_API_URL), ticket);
