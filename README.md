
### Frontend Deployment (Vercel)

1. **Import Repository:** Log in to [Vercel](https://vercel.com/) and click **Add New... > Project**. Import the project repository.
2. **Configure Project Settings:**
   - **Framework Preset:** Vite
   - **Root Directory:** Set to `frontend` (enable "Include source files outside of the Root Directory" if necessary).
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Install Command:** `npm ci` or `npm install`
3. **Environment Variables:**
   - In **Project Settings > Environment Variables**, add:
     ```env
     VITE_API_URL=https://hospital-appointment-platform.onrender.com/api
     ```
   - Set this for Production (and Preview environments if appropriate).
   - Vite statically injects `VITE_` variables during the build. Whenever you change `VITE_API_URL`, trigger a redeployment for the changes to take effect.
4. **Deploy:** Click **Deploy**. Vercel will provision the project and provide your live frontend URL (e.g., `https://hospital-appointment-platform-front.vercel.app`).

### Backend Deployment (Render)

1. **Create Web Service:** In the [Render Dashboard](https://dashboard.render.com/), click **New + > Web Service** and connect the repository.
2. **Configure Service Settings:**
   - **Name:** `hospital-appointment-backend`
   - **Root Directory:** `backend`
   - **Runtime:** Node
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Plan:** Free / Starter
3. **Environment Variables:**
   - In the **Environment** tab, configure the following variables:
     ```env
     NODE_ENV=production
     MONGO_URI=<your MongoDB Atlas connection string>
     JWT_SECRET=<a long, random, unique production secret>
     ACCESS_TOKEN_EXPIRES_IN=15m
     CLIENT_URL=https://hospital-appointment-platform-front.vercel.app
     TRUST_PROXY=1
     ```
   - Render automatically provisions and sets the `PORT` environment variable. Do not hardcode `PORT`.
   - Ensure `CLIENT_URL` matches your exact Vercel frontend URL without trailing slashes. For multiple domains, supply comma-separated values (e.g., `http://localhost:5173,https://hospital-appointment-platform-front.vercel.app`).

### Authentication and Session Configuration

Access tokens are short-lived (15 minutes by default) and bound to a session ID.

The long-lived credential is a refresh token stored in an HttpOnly cookie. The frontend origin specified in `CLIENT_URL` must be allowed for credentialed requests.

`JWT_EXPIRES_IN` is no longer used. Instead, configure `ACCESS_TOKEN_EXPIRES_IN` for access-token expiration.

See [issue-15-changes.md](issue-15-changes.md) for refresh-token, session-revocation, and audit-logging settings:

- `REFRESH_TOKEN_TTL_DAYS`
- `REFRESH_TOKEN_GRACE_MS`
- `REFRESH_COOKIE_SAMESITE`
- `REFRESH_COOKIE_SECURE`

Do not commit `.env` files, database credentials, JWT secrets, refresh tokens, or real admin passwords.

### Waiting-List Notification Streaming

The waiting-list notification system uses Server-Sent Events (SSE) to notify patients about appointment-slot reassignment.

The following configuration variables are documented in [issue-11-changes.md](issue-11-changes.md):

- `SSE_TICKET_TTL_MS`
- `SSE_HEARTBEAT_MS`
- `SSE_MAX_TICKETS`

Reverse-proxy requirements and notification-stream behavior are also documented in that file.

Ensure `CLIENT_URL` contains the frontend origin because the browser's `EventSource` connects across origins.

### MongoDB Atlas Setup & Troubleshooting

#### 1. Cluster & Database User Setup

1. Create a free-tier M0 cluster in [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Under **Security > Database Access**, add a database user with the minimum permissions required for the application.
3. Avoid special characters like `@` or `:` in the database password, or URL-encode them in the MongoDB connection string.

#### 2. Network Access (IP Allowlisting)

By default, MongoDB Atlas rejects incoming connections from IP addresses that are not allowed.

1. Navigate to **Security > Network Access**.
2. Click **Add IP Address**.
3. For local development, add your current public IP using **Add Current IP Address**.
4. For Render or other cloud providers, allow the backend's outbound IP addresses where possible.

If your hosting environment uses dynamic outbound IP addresses and a restricted allowlist is not practical, `0.0.0.0/0` (Allow Access from Anywhere) may be used when necessary.

**Security warning:** `0.0.0.0/0` allows connection attempts from any IP address. Use strong database credentials, least-privilege database permissions, and restrict network access wherever practical.

#### 3. Troubleshooting Common Connection Issues

**`MongooseServerSelectionError: connect ETIMEDOUT` or `MongoServerSelectionError: connection timed out`**

- Verify that the backend's outbound IP addresses are allowed under MongoDB Atlas **Network Access**.
- Check whether a corporate firewall or VPN is blocking outbound connections to MongoDB Atlas.
- Confirm that the MongoDB cluster is running and the connection string is correct.

**`MongoServerError: bad auth : authentication failed`**

- Verify that the username and password in `MONGO_URI` match the database user created under **Database Access**, not your Atlas dashboard login.
- URL-encode special characters in passwords (e.g., `@` becomes `%40`).
- Verify that the database user has the required permissions.

**CORS / Preflight Failure in Browser**

- Verify that `CLIENT_URL` in the backend environment matches the exact origin (scheme + domain) of the deployed frontend.
- Check that the backend allows credentialed requests from the configured frontend origin.
- Verify that the frontend's `VITE_API_URL` points to the correct backend API URL.
- Redeploy the frontend after changing Vite environment variables.

### Health Check

Open [Backend health check](https://hospital-appointment-platform.onrender.com/api/health).

A healthy response returns HTTP 200:
