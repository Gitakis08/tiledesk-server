# Local end-to-end checklist: Microsoft Entra → Tiledesk Server → Dashboard

Use this when exercising OAuth2/OIDC sign-in with Entra ID against a local API (`tiledesk-server`) and local Angular app (`tiledesk-dashboard`). **No code changes required** for the flow itself if env and runtime config are correct.

---

## 1. Required server `.env` values

| Variable | Purpose |
|----------|---------|
| `OAUTH2_SIGNIN_ENABLED` | Must be `true` (string) so the OAuth2 strategy is registered (`middleware/passport.js`). |
| `OAUTH2_AUTH_URL` | Entra authorize endpoint, e.g. `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize`. |
| `OAUTH2_TOKEN_URL` | Entra token endpoint, e.g. `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token`. |
| `OAUTH2_CLIENT_ID` | App (client) ID from Entra. |
| `OAUTH2_CLIENT_SECRET` | Client secret (confidential client). |
| `OAUTH2_CALLBACK_URL` | **Must match** the redirect URI registered in Entra (recommended local: `http://localhost:3000/auth/oauth2/callback`). |
| `OAUTH2_USER_INFO_URL` | OIDC UserInfo URL used after token exchange (e.g. Microsoft Graph userinfo `https://graph.microsoft.com/oidc/userinfo`, or the issuer’s documented userinfo endpoint). Must return JSON with `sub` and resolvable email (see section 11). |
| `OAUTH2_SCOPE` | Optional; space-separated. If unset, server defaults to `openid profile email`. For Entra you may need `openid profile email offline_access` and sometimes extra Graph scopes depending on token/userinfo setup. |

Also required for a working stack (not Entra-specific):

- JWT signing: whatever your deployment already uses for `auth/google` (e.g. secret / `GLOBAL_SECRET_ALGORITHM` if set).
- MongoDB reachable with the same `DATABASE_URI` (or equivalent) your server uses.
- **Express session** must work across the browser redirect to Entra and back to `/auth/oauth2/callback` if you rely on `redirect_url` / `forced_redirect_url` stored in `req.session` (see section 11).

---

## 2. Required dashboard runtime config values

Loaded from `./dashboard-config.json` (or your substituted template) when `remoteConfig: true`:

| Key | Purpose |
|-----|---------|
| `SERVER_BASE_URL` | Base URL of the API, e.g. `http://localhost:3000/` (trailing slash as your app expects). The sign-in button opens `{SERVER_BASE_URL}auth/oauth2`. |
| `oauth2SigninEnabled` | JSON **boolean** `true` so the OAuth2 button is shown. |

Optional but typical for local dev: `firebaseAuth: false` (matches default autologin branch that uses `ssoLogin`, not Firebase custom token).

---

## 3. Required `EMAIL_BASEURL` value

Set in **server** `.env`:

- `EMAIL_BASEURL=http://localhost:4200` (no path; match your `ng serve` origin).

`routes/auth.js` uses `process.env.EMAIL_BASEURL || config.baseUrl` when building the post-login redirect for OAuth2 callback. Wrong host/port sends the user to the wrong SPA after Entra.

---

## 4. Expected authorize URL

After opening `GET http://localhost:3000/auth/oauth2` (or with query params as in section 7), the server responds with a **302** to:

- **`OAUTH2_AUTH_URL`** with standard OAuth2 query parameters (`client_id`, `redirect_uri`, `response_type`, `scope`, `state`, etc., as produced by `passport-oauth2`).

Example shape (values vary):

`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Foauth2%2Fcallback&client_id=...&scope=openid%20profile%20email&state=...`

---

## 5. Expected callback URL

The **redirect URI** Entra calls after consent/login:

- **`http://localhost:3000/auth/oauth2/callback`**  
  (or the exact value of `OAUTH2_CALLBACK_URL` if you override it)

This must be **identical** (scheme, host, port, path) to an entry under the Entra app registration **Redirect URIs**.

---

## 6. Expected final redirect URL (dashboard)

Implemented in `routes/auth.js` (`GET /auth/oauth2/callback`):

**A. Default** (no `redirect_url` / `forced_redirect_url` in session):

`{EMAIL_BASEURL || config.baseUrl}` + `/#/` + `?` + `token=JWT ` + `{signed-dashboard-jwt}`  

Example: `http://localhost:4200/#/?token=JWT eyJ...`

**B. With `req.session.redirect_url` set** (from `GET /auth/oauth2?redirect_url=...`):

`{redirect_url}` + `?` or `&` + `token=JWT ` + `{jwt}`  
(`redirect_url` must be a **full absolute URL** for this branch; it replaces the whole target, unlike `/auth/google`.)

**C. Ionic / alternate:** `forced_redirect_url` uses query name **`jwt=`**, not `token=` — not the standard dashboard hash flow.

The dashboard then uses `AuthGuard` to detect `?token=JWT ...` and navigates to `autologin/:route/:token`.

---

## 7. How to test with a full absolute `redirect_url` to `/#/projects`

1. Ensure session cookies work for `http://localhost:3000` (same site, not blocking third-party cookies for your test profile).
2. Start the OAuth flow with an explicit **`redirect_url`** (URL-encoded), for example in the browser:

   `http://localhost:3000/auth/oauth2?redirect_url=http%3A%2F%2Flocalhost%3A4200%2F%23%2Fprojects`

   Decoded `redirect_url`: `http://localhost:4200/#/projects`

3. Complete Entra login. After callback, you should land on something like:

   `http://localhost:4200/#/projects?token=JWT%20...`

4. Confirm the SPA routes through **AuthGuard** → **Autologin** and ends on the projects area with a stored user.

**Note:** The built-in dashboard button currently calls `/auth/oauth2` **without** `redirect_url`; using the URL above is a manual or tooling step unless you later add it in the client.

---

## 8. How to verify `localStorage` values

In DevTools → Application → Local Storage → your dashboard origin (`http://localhost:4200`):

| Key | Expectation |
|-----|-------------|
| `user` | JSON object with at least `email`, `firstname`, `lastname`, `_id`, `emailverified`, and `token` (dashboard JWT, often `JWT eyJ...`). |
| `tiledesk_token` | Same token string as in `user.token` after successful autologin. |

Optional / follow-up navigation:

| Key | Expectation |
|-----|-------------|
| `last_project` | May be populated after project list loads. |
| `{projectId}` | May hold cached project JSON when you open a project route. |

If `user` is missing or token is wrong, check Network for failing API calls and server logs on `/auth/oauth2/callback`.

---

## 9. How to verify the user record and Auth link in MongoDB

**User document** (collection name depends on your Mongoose model; commonly `users`):

- Find by email used in Entra (normalized lowercase in OAuth2 verify).
- Expect `status: 100` for an active user the strategy can load on subsequent logins.

**Auth link** (model `auth` → collection typically `auths`):

- Query documents with:

  - `providerId`: issuer string from the ID token or access token JWT (`iss`), e.g. `https://login.microsoftonline.com/<tenant-id>/v2.0`
  - `subject`: OIDC `sub` for that user
  - `email`: same email used for login

- First-time login: strategy may **upsert** via `Auth.findOne` / `new Auth({ providerId, email, subject })` after `userService.signup` (see `middleware/passport.js` OAuth2 verify).

Example `mongosh` (adjust DB name):

```javascript
use tiledesk;
db.users.find({ email: "you@yourtenant.com" }).pretty();
db.auths.find({ email: "you@yourtenant.com" }).pretty();
```

---

## 10. How to verify project role checks still work

1. After login, open a URL under a real project, e.g. `#/project/<projectId>/home` (or navigate from Projects).
2. Confirm the UI loads without repeated **401** / unauthorized redirects.
3. In Network, inspect API calls that send `Authorization: JWT ...` (or the header shape your dashboard uses) and return 200 for project-scoped routes.
4. Optionally confirm in MongoDB the user’s membership in that project (e.g. `project_users` or your deployment’s equivalent collection) and that the role returned matches what the UI expects.

`AuthGuard` + `UsersService` / `ProjectService` paths use `SERVER_BASE_URL` and the stored user token; if the token is valid and the user is a member of the project, role checks should behave like after email/password login.

---

## 11. Common failure cases

### Callback URL mismatch

- **Symptom:** Entra error page (“redirect_uri mismatch”), or no callback hit on your server.
- **Fix:** Entra app registration redirect URI must **exactly** match `OAUTH2_CALLBACK_URL` (including `http` vs `https`, port, and path `/auth/oauth2/callback`).

### Missing session

- **Symptom:** After login you always get the **default** dashboard URL (`.../#/?token=...`) even though you passed `redirect_url`, or `redirect_url` behavior seems ignored.
- **Cause:** `req.session.redirect_url` is set on `GET /auth/oauth2` but **lost** on callback (no session cookie, different domain, `DISABLE_SESSION_STRATEGY` / no session middleware, cookie `Secure`/`SameSite` issues over mixed HTTP/HTTPS).
- **Fix:** Ensure session middleware is enabled and the browser sends the same session cookie to `GET /auth/oauth2/callback`. For local HTTP, use consistent `localhost` host and check cookie flags.

### Missing `email` / `preferred_username` / `upn`

- **Symptom:** Server logs warn `OAuth2 sign-in: no email, preferred_username, or upn...`; Passport returns `false`; user sees failed auth.
- **Cause:** UserInfo (or ID token claims) does not expose an email-like claim, or `OAUTH2_USER_INFO_URL` / scopes do not return what `passport.js` expects.
- **Fix:** Grant **email** (and **profile**) scopes; ensure the user has an email on the Entra object; verify UserInfo JSON contains `email` or `preferred_username` usable as email; for guest users, check Entra documentation for claim availability.

### `oauth2SigninEnabled` passed as string instead of boolean (dashboard)

- **Symptom:** OAuth2 button **always visible** even when you intended `false`, or confusing UI state.
- **Cause:** JSON like `"oauth2SigninEnabled": "false"` makes the value a **non-empty string**, which is **truthy** in JavaScript for `*ngIf="OAUTH2_SIGNIN_ENABLED"`.
- **Fix:** In `dashboard-config.json` use unquoted JSON booleans: `"oauth2SigninEnabled": true` or `false`. If using `envsubst`, ensure the template expands to valid JSON booleans, not quoted `"true"`/`"false"` strings when you need a real `false`.

---

## Quick local smoke order

1. Set server `.env` (section 1) + `EMAIL_BASEURL` (section 3).  
2. Register Entra redirect URI (section 5).  
3. Set dashboard `SERVER_BASE_URL` + `oauth2SigninEnabled: true` (section 2).  
4. Open dashboard → **Sign in with OAuth2** → complete Entra → verify final URL (section 6), `localStorage` (section 8), MongoDB (section 9), project page (section 10).  
5. Repeat with section 7 URL to validate `redirect_url` + session.
