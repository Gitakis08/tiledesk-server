# Tiledesk Server — Authentication Flow

This document describes how authentication works in **tiledesk-server** (Express, Passport, JWT). It complements dashboard and deployment notes in sibling repos.

## Overview

- **Primary API credential:** a Tiledesk-issued JWT, sent as `Authorization: JWT <token>` (or HTTP Basic for some flows).
- **Identity store:** MongoDB `User` model; OAuth identities linked via `Auth` (`models/auth.js`).
- **Project authorization:** separate from JWT issuance — `Project_user` documents and `middleware/has-role.js` enforce roles per `/:projectid/...` route.

## Email and password sign-in

1. **Endpoint:** `POST /auth/signin`  
   **Route file:** `routes/auth.js`

2. **Validation:**
   - `express-validator` checks email and password.
   - `User.findOne({ email: normalizedEmail, status: 100 })`.
   - Password: `user.comparePassword` **or** match against `SUPER_PASSWORD` (env).

3. **JWT issuance:**
   - `jsonwebtoken.sign` with payload derived from the user document (password stripped).
   - Claims include `iss` (`https://tiledesk.com`), `sub` (`user`), `aud` (`https://tiledesk.com`), `jti` (UUID).
   - Signing key: `GLOBAL_SECRET` or asymmetric keys via `GLOBAL_SECRET_OR_PRIVATE_KEY` / `GLOBAL_SECRET_OR_PUB_KEY` and `GLOBAL_SECRET_ALGORITHM`.

4. **Response:** `{ success, token: 'JWT ' + token, user }`. If `email === ADMIN_EMAIL`, response may include `role: "admin"`.

**Related:** `services/userService.js` (signup), `routes/auth.js` (`POST /auth/signup`, verify email routes).

## Anonymous sign-in

- **Endpoint:** `POST /auth/signinAnonymously`
- Creates a guest identity and `Project_user` with `RoleConstants.GUEST`, then signs a JWT for the anonymous user object.

## Sign-in with existing JWT (custom token path)

- **Endpoint:** `POST /auth/signinWithCustomToken`
- Middleware: `noentitycheck`, `passport.authenticate(['jwt'], { session: false })`, `valid-token`.
- Used when a client already holds a JWT and needs the enriched user / project membership flow documented in `routes/auth.js`.

## Google sign-in

1. **Browser redirect:** `GET /auth/google` — stores `redirect_url` / `forced_redirect_url` on **`req.session`**, then `passport.authenticate('google', ...)`.
2. **Callback:** `GET /auth/google/callback` — `passport.authenticate('google', { session: false })`, then JWT issued like password sign-in and user redirected to dashboard with `?token=JWT ...` or `?jwt=JWT ...` (Ionic).

**Enabled when:** `GOOGLE_SIGNIN_ENABLED=true` and Google strategy is registered in `middleware/passport.js`.

**Strategy:** `passport-google-oidc` — links or creates `User`, persists `Auth` record (`providerId` + `subject`).

## OAuth2 sign-in (generic / Keycloak-oriented)

1. **Browser redirect:** `GET /auth/oauth2` — sets session redirect fields, then `passport.authenticate('oauth2', ...)`.
2. **Callback:** `GET /auth/oauth2/callback` — exchanges code, loads profile via `OAUTH2_USER_INFO_URL`, links or creates user via `Auth` + `userService.signup` (see `middleware/passport.js`).

**Enabled when:** `OAUTH2_SIGNIN_ENABLED=true`.

**Important:** This flow uses **`req.session`** for `redirect_url` / `forced_redirect_url`. If Express session is disabled globally, redirect state may be lost. See [Session behavior](#session-behavior) and `docs/entra-integration-plan.md`.

## Passport JWT validation (API requests)

- **Configuration:** `middleware/passport.js`
  - `JwtStrategy` extracts token via `Authorization: JWT ...` or query `secret_token`.
  - `secretOrKeyProvider` chooses verification secret from JWT `aud` (global secret, project `jwtSecret`, bot secret, subscription secret, etc.).
  - After verify, loads `req.user`: MongoDB `User`, `Faq_kb` (bot), `Subscription`, or decorated guest/external payloads.

- **Optional revocation:** If `@tiledesk-ent/tiledesk-server-jwthistory` is installed and enabled, JWTs can be rejected by `jti`.

- **HTTP Basic:** `BasicStrategy` for email/password on the wire (used alongside JWT on some routes).

## Protected routes pattern

**File:** `app.js`

Typical stack:

```text
passport.authenticate(['basic', 'jwt'], { session: false })
→ valid-token (ensures Authorization header present)
→ roleChecker.hasRole(...) / hasRoleOrTypes(...)
```

**Role enforcement:** `middleware/has-role.js`

- Resolves `Project_user` for `req.params.projectid` and `req.user._id` (or `uuid_user` for guest/external JWT subjects).
- Compares project role against a hierarchy (`guest` → … → `owner`).
- **Bypass:** if `req.user.email === ADMIN_EMAIL`, access may be allowed without a `Project_user` row.
- **Non-user principals:** bots and subscriptions can satisfy `types` in `hasRoleOrTypes` without project_user role checks.

## Session behavior

- **API JWT auth:** `session: false` — no server-side session for normal REST calls.
- **Express session:** Optional in `app.js`:
  - If `DISABLE_SESSION_STRATEGY` is `true` (common in Helm defaults), **session middleware is not mounted**.
  - If enabled: `SESSION_SECRET`, optional Redis store via `ENABLE_REDIS_SESSION` and pub module cache client.
- **OAuth (Google / OAuth2):** handlers read/write **`req.session.redirect_url`** and **`req.session.forced_redirect_url`**. Sessions must be active and sticky (or use a shared store) for redirects to work reliably.

## WebSockets

- **File:** `websocket/webSocketServer.js`
- Validates JWT similarly (global/project public key configuration) for socket connections.

## Unused / alternate code

- `routes/auth_newjwt.js` — **not** mounted in `app.js`; treat as legacy or reference only.

## Key file index

| Area | Path |
|------|------|
| Auth routes | `routes/auth.js` |
| Passport strategies | `middleware/passport.js` |
| Authorization header present | `middleware/valid-token.js` |
| Project roles | `middleware/has-role.js` |
| App mount | `app.js` (`app.use('/auth', auth)`, protected `/:projectid/...`) |
| User model | `models/user.js` |
| OAuth link model | `models/auth.js` |
| Default JWT secret (fallback) | `config/database.js` (`secret`) |
| Auth events | `event/authEvent.js` |
