# Issue #15: Refresh Token Rotation, Multi-Device Session Revocation & RBAC Audit Logging

## 1. Summary

**Issue #15 Objective:** Upgrade authentication architecture to HTTP-only cookie Refresh Tokens with rotation, active multi-device session tracking and revocation, and administrative RBAC audit logging.

**Delivered:**
- **Refresh Token Rotation & Hashing (`backend/models/RefreshToken.js`, `backend/utils/session.js`):**
  - Stored securely in MongoDB hashed with SHA-256 (`tokenHash`). Raw values are transmitted strictly via HTTP-only cookies (`path: /api/auth`, `sameSite: none` in production, `secure: true` in production).
  - Every login or registration creates a dedicated device session family (`crypto.randomUUID()`).
  - Refresh requests (`POST /api/auth/refresh`) atomically rotate the token (`usedAt`), issuing a new refresh token under the same family and a fresh access token.
- **Token Reuse Detection & Grace Period:**
  - Replaying a previously rotated refresh token outside the 30-second grace window (`REUSE_GRACE_MS`) triggers immediate invalidation of the entire device session family (`revokeFamily`) and records a security audit log (`auth.refresh_reuse_detected`).
  - A 30-second grace window prevents race conditions from concurrent browser tabs refreshing simultaneously from logging out legitimate users.
- **Immediate Revocation via Session ID (`sid`):**
  - Access tokens (15-minute lifespan via `ACCESS_TOKEN_EXPIRES_IN`) embed a session ID claim (`sid`).
  - Authentication middleware (`backend/middlewares/authMiddleware.js`) verifies whether the session family is active (`isSessionActive`), ensuring revoking a session terminates access immediately without waiting for token expiration.
- **Multi-Device Session Management:**
  - `GET /api/auth/sessions`: Lists active devices with user agent names, IP addresses, creation dates, and current session indicator.
  - `DELETE /api/auth/sessions/:id`: Revokes a specific device session.
  - `POST /api/auth/logout`: Revokes current device session and clears the HTTP-only cookie.
  - `POST /api/auth/logout-all`: Revokes all active sessions across all devices for the authenticated user.
- **Administrative RBAC Audit Logging (`backend/models/AuditLog.js`, `backend/utils/auditLog.js`):**
  - Security events captured: RBAC access denials (`rbac.denied`), admin updates and deactivations (`user.update`, `user.deactivate`, `doctor.update`, `doctor.deactivate`, `department.update`, `department.deactivate`), session revocations (`session.revoke`, `session.revoke_all`), and refresh token reuse detection.
  - Query endpoint: `GET /api/admin/audit-logs?action=&outcome=&limit=` protected by `protect` and `authorize('admin')`.
- **Frontend Interceptor & Silent Refresh:**
  - Axios client (`frontend/src/api/axios.js`) configured with `withCredentials: true`.
  - Response interceptor automatically catches 401 Unauthorized errors on protected endpoints, executes a single coalesced call to `/api/auth/refresh`, updates local storage, and replays the original request seamlessly.
  - On refresh failure, triggers global `auth:logout` event to cleanly reset application state.
- **Automated Test Suite:**
  - Backend test runner (`backend/tests/session_auth.test.js`) verifying JWT `sid` embedding, SHA-256 hashing, schema indexes, audit error swallowing, and RBAC authorization middleware.
  - Frontend test suite (`frontend/tests/axios.test.js`) verifying endpoint resolution including refresh, session, and audit routes.

---

## 2. Files Changed

| File | Status | Purpose |
| :--- | :--- | :--- |
| `backend/models/RefreshToken.js` | New | Schema storing hashed refresh tokens, session family identifiers, device metadata, expiration TTL, and compound indexes. |
| `backend/models/AuditLog.js` | New | Schema storing actor, role, action, outcome, target, client IP, and contextual metadata. |
| `backend/utils/session.js` | New | Token hashing, HTTP-only cookie handlers, session family creation, rotation helpers, and active session verifier. |
| `backend/utils/auditLog.js` | New | Fail-safe audit recording helper that logs security events without disrupting request execution. |
| `backend/controllers/auditController.js` | New | Controller for `GET /api/admin/audit-logs` supporting action, outcome, and limit filters. |
| `backend/middlewares/authMiddleware.js` | Modified | Verifies access token `sid` against active sessions, immediately rejecting revoked sessions. |
| `backend/middlewares/roleMiddleware.js` | Modified | Audits unauthorized access attempts (`rbac.denied`) with method, path, and roles. |
| `backend/controllers/authController.js` | Modified | Integrated session creation on login/register, token rotation on refresh, logout, multi-device listing, and session revocation. |
| `backend/controllers/userController.js` | Modified | Revokes sessions on user deactivation and logs admin updates. |
| `backend/controllers/doctorController.js` | Modified | Revokes sessions on doctor deactivation and logs admin updates. |
| `backend/controllers/departmentController.js` | Modified | Logs department creation, updates, and deactivations. |
| `backend/routes/authRoutes.js` | Modified | Registered `/refresh`, `/logout`, `/logout-all`, `/sessions`, and `/sessions/:id` routes. |
| `backend/routes/adminRoutes.js` | Modified | Registered `GET /audit-logs` route. |
| `backend/utils/generateToken.js` | Modified | Updated token generation to embed session identifier `sid` and use `ACCESS_TOKEN_EXPIRES_IN`. |
| `backend/server.js` | Modified | Added `cookie-parser`, configured CORS credentials, and enabled proxy trust for IP auditing. |
| `backend/.env.example` | Modified | Documented `ACCESS_TOKEN_EXPIRES_IN` and `REFRESH_TOKEN_DAYS`. |
| `backend/tests/session_auth.test.js` | New | Automated unit tests for tokens, hashing, models, audit logs, and RBAC middleware. |
| `backend/package.json` | Modified | Added `cookie-parser` dependency and `test` script. |
| `frontend/src/api/axios.js` | Modified | Added `withCredentials: true` and 401 response interceptor with silent token refresh. |
| `frontend/src/api/authApi.js` | Modified | Added `logout()` calling `POST /auth/logout`. |
| `frontend/src/context/AuthContext.jsx` | Modified | Updated `logout` handler to call `authApi.logout()`. |
| `frontend/tests/axios.test.js` | Modified | Added assertions for new auth and audit endpoints. |
| `README.md` | Modified | Updated environment variable documentation. |
| `ISSUE_15_CHANGES.md` | New | Implementation documentation and verification summary. |

---

## 3. Verification

1. **Backend Automated Tests:**
   ```bash
   cd backend
   npm test
   ```
   - 9/9 tests pass (token generation, hashing, schemas, audit recording resilience, RBAC access control).
2. **Frontend Automated Tests & Production Build:**
   ```bash
   cd frontend
   npm test
   npm run build
   ```
   - 7/7 tests pass.
   - Vite production bundle compiled cleanly with 0 errors.
