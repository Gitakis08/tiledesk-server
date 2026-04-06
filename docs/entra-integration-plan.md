# Microsoft Entra ID — Integration Plan (Least Invasive)

This plan aligns with the current **tiledesk-server** architecture: Entra handles **identity**; Tiledesk continues to issue its **own JWT** for API and websocket access; **project roles** remain in `Project_user`.

## Current integration points (no Entra-specific code today)

| Component | Role |
|-----------|------|
| `middleware/passport.js` | Generic `passport-oauth2` strategy when `OAUTH2_SIGNIN_ENABLED=true`; fetches profile from `OAUTH2_USER_INFO_URL`; creates/links `User` via `Auth` + `userService.signup`. |
| `routes/auth.js` | `GET /auth/oauth2`, `GET /auth/oauth2/callback`; redirects to dashboard with Tiledesk JWT in query string (same pattern as Google). |
| `models/auth.js` | Stores `providerId` (issuer) + `subject` + `email` to link IdP identity to Tiledesk user. |
| Dashboard | Optional “OAuth2” button opens `{SERVER_BASE_URL}auth/oauth2` (see `tiledesk-dashboard/docs/auth-notes.md`). |

## Recommended approach: reuse OAuth2 route

1. **App registration in Entra ID**
   - Register a web application.
   - Redirect URI: `{public-server-url}/auth/oauth2/callback` (must match `OAUTH2_CALLBACK_URL`).
   - Grant delegated permissions appropriate for sign-in and user read (e.g. `openid`, `profile`, `email`); follow Microsoft guidance for your tenant.

2. **Environment variables (server)**

   Set at minimum:

   - `OAUTH2_SIGNIN_ENABLED=true`
   - `OAUTH2_CLIENT_ID` — Entra application (client) ID  
   - `OAUTH2_CLIENT_SECRET` — client secret (or move to certificate-based auth in a later hardening phase)  
   - `OAUTH2_AUTH_URL` — Entra authorize endpoint (tenant-specific v2 URL)  
   - `OAUTH2_TOKEN_URL` — Entra token endpoint  
   - `OAUTH2_USER_INFO_URL` — Microsoft OIDC userinfo endpoint (or adapt code to use ID token claims only)  
   - `OAUTH2_CALLBACK_URL` — must match Entra redirect URI  

   Optional but important for UX:

   - `EMAIL_BASEURL` — dashboard base URL used when building post-login redirect (see `routes/auth.js`).

3. **Claim / profile mapping**

   The existing OAuth2 strategy expects a userinfo-shaped JSON object (historically Keycloak-oriented). Entra returns standard OIDC claims (`sub`, `email`, `name`, `given_name`, `family_name`, etc.). **Implementation work** (when you leave “docs only”): adjust the `userProfile` / callback logic in `middleware/passport.js` so `email` and display name are populated reliably for `userService.signup` and `User.findOne`.

4. **Sessions and redirect state — main risk**

   Google and OAuth2 routes store **`redirect_url`** and **`forced_redirect_url`** on **`req.session`** before sending the user to the IdP.

   - **Helm default** in the deployment repo often sets **`DISABLE_SESSION_STRATEGY=true`**, which **skips** `express-session` and `passport.session()` in `app.js`.
   - If sessions are disabled, **`req.session` may be undefined or non-persistent**, so after Entra redirects back to `/auth/oauth2/callback`, the intended dashboard path may be lost or behavior may be inconsistent.

   **Mitigations to plan for (when implementing):**

   - Set **`DISABLE_SESSION_STRATEGY=false`** and provide a valid **`SESSION_SECRET`**; optionally **`ENABLE_REDIS_SESSION=true`** with a working Redis client for multi-instance deployments; **or**
   - Encode `redirect_url` in OAuth **`state`** (signed or encrypted) and read it back in the callback instead of session (requires code change but removes dependency on server session for OAuth).

5. **Roles and permissions**

   - Entra **app roles / groups** are **not** mapped automatically to Tiledesk **project** roles (`agent`, `admin`, etc.).
   - **Least invasive:** keep assigning roles via Tiledesk invitations / `Project_user` as today.
   - **Future:** map Entra groups to a Tiledesk flag (e.g. superadmin list) or sync job — out of scope for minimal integration.

6. **Dashboard**

   - Enable OAuth2 button via remote config: `oauth2SigninEnabled` (see dashboard auth notes).
   - No change to how APIs consume tokens: still **Tiledesk JWT** after callback.

7. **Security operations**

   - Rotate `GLOBAL_SECRET` / key pair with a documented JWT invalidation strategy (optional enterprise JWT history module).
   - Treat `SUPER_PASSWORD` and `ADMIN_EMAIL` as break-glass; align with org policy.

## Alternative (more invasive)

- **MSAL in the Angular dashboard** + backend token exchange that still ends with issuing the **same** Tiledesk JWT — use only if full-page redirects to the API host are unacceptable.

## References in this repo

- `docs/auth-flow.md` — full server auth flow  
- `middleware/passport.js` — OAuth2 strategy  
- `routes/auth.js` — OAuth2 routes and JWT issuance after IdP success  
- `app.js` — session toggles and `app.use('/auth', auth)`  

Deployment-related env wiring: **`tiledesk/docs/auth-env-notes.md`**.
