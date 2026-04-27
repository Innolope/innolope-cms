# Enterprise SSO Setup

Innolope CMS supports **SAML 2.0** and **OpenID Connect (OIDC)** single sign-on, with **SCIM 2.0** for user provisioning. SSO is a license-gated Enterprise feature.

This guide walks through:

- [Prerequisites](#prerequisites)
- [OIDC setup (Okta, Azure AD, Google, Keycloak)](#oidc-setup)
- [SAML setup (Okta, Azure AD, ADFS)](#saml-setup)
- [SCIM provisioning](#scim-provisioning)
- [Enforcement and account linking](#enforcement-and-account-linking)
- [Certificate rotation (SAML)](#certificate-rotation-saml)
- [IdP-initiated SSO (SAML)](#idp-initiated-sso-saml)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

1. **Enterprise license** — your `INNOLOPE_LICENSE_KEY` must include the `sso` feature (cloud deployments get this automatically via `CLOUD_MODE=true`).
2. **Environment variables** — set these on the API:
   ```
   SSO_ENCRYPTION_KEY=<32-byte base64>      # openssl rand -base64 32
   SAML_SP_ENTITY_ID=https://cms.example.com
   SAML_SP_PRIVATE_KEY_PEM=<PEM>            # only for SAML
   SAML_SP_CERT_PEM=<PEM>                   # only for SAML
   SSO_CALLBACK_BASE_URL=https://cms.example.com
   SSO_ALLOWED_REDIRECT_ORIGINS=https://cms.example.com
   SSO_CLOCK_SKEW_SECONDS=120
   ```
3. **Project admin role** — only users with the `admin` role on a project can configure that project's SSO connections.

In the admin UI, go to **Settings → SSO**. If you don't see the tab, confirm the license includes `sso`.

---

## OIDC setup

The general flow is the same across every OIDC provider:

1. In your IdP, create an **OIDC / web application**.
2. Set the redirect URI to:
   ```
   https://cms.example.com/api/v1/auth/sso/<slug>/oidc/callback
   ```
   `<slug>` is the connection slug you'll pick in Innolope (e.g. `acme`).
3. Note the **issuer URL**, **client ID**, and **client secret**.
4. In Innolope **Settings → SSO → Add connection**, choose **OIDC**, fill in the fields, save.
5. Toggle **Enabled** and test via the login page: type an email whose domain is on your allowlist and click **Continue with \<name\>**.

### Okta (OIDC)

1. Okta admin → **Applications → Create App Integration → OIDC - Web**.
2. Redirect URI: `https://cms.example.com/api/v1/auth/sso/<slug>/oidc/callback`.
3. Grant types: Authorization Code.
4. Copy **Client ID** and **Client Secret**.
5. Issuer: `https://<your-org>.okta.com` (for default authorization server).

### Azure AD / Microsoft Entra ID (OIDC)

1. Azure Portal → **App registrations → New registration**.
2. Redirect URI (Web): `https://cms.example.com/api/v1/auth/sso/<slug>/oidc/callback`.
3. Under **Certificates & secrets**, create a client secret.
4. Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
5. Under **API permissions**, add `openid`, `email`, `profile`, and grant admin consent.

### Google Workspace (OIDC)

1. Google Cloud Console → **OAuth consent screen** (Internal).
2. **Credentials → Create OAuth client ID → Web application**.
3. Authorized redirect URI: `https://cms.example.com/api/v1/auth/sso/<slug>/oidc/callback`.
4. Issuer: `https://accounts.google.com`.
5. Innolope's `attrGroups` default is `groups`, but Google doesn't include groups by default — use the `hd` (hosted domain) claim instead, or push group membership via SAML or SCIM.

### Keycloak (OIDC, for local development)

```bash
docker run -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:25 start-dev
```

1. Create a realm (e.g. `innolope-test`).
2. **Clients → Create**, Client ID `cms`, Access Type `confidential`, Redirect URI `http://localhost:3000/api/v1/auth/sso/<slug>/oidc/callback`.
3. **Credentials** tab → copy the client secret.
4. Issuer: `http://localhost:8080/realms/innolope-test`.

---

## SAML setup

1. In Innolope **Settings → SSO**, create a SAML connection with a slug.
2. Innolope will expose SP metadata at:
   ```
   https://cms.example.com/api/v1/auth/sso/<slug>/saml/metadata
   ```
   Use this URL to register the SP in your IdP, or download it and upload the XML manually.
3. The IdP's **ACS URL** must be:
   ```
   https://cms.example.com/api/v1/auth/sso/<slug>/saml/acs
   ```
4. The IdP's **Audience / Entity ID** must match `SAML_SP_ENTITY_ID`.
5. In Innolope, paste the **IdP Entity ID**, **IdP SSO URL**, and **IdP signing certificate (PEM)**.
6. Save, enable, and test via the login page.

### Okta (SAML)

1. Okta admin → **Applications → Create App Integration → SAML 2.0**.
2. Single sign-on URL: `https://cms.example.com/api/v1/auth/sso/<slug>/saml/acs`.
3. Audience URI: `https://cms.example.com` (must match `SAML_SP_ENTITY_ID`).
4. Name ID format: `EmailAddress`.
5. Attribute statements:
   - `email` ← `user.email`
   - `name` ← `user.displayName`
   - `groups` ← `appuser.groups` (optional, for group → role mapping)
6. Copy the **IdP metadata URL** → fetch it, extract `entityID`, `SingleSignOnService Location`, and the X509 cert → paste into Innolope.

### Azure AD / Microsoft Entra ID (SAML)

1. Azure Portal → **Enterprise applications → New application → Create your own application → Non-gallery**.
2. Single sign-on → SAML.
3. **Identifier (Entity ID)**: `https://cms.example.com`.
4. **Reply URL**: `https://cms.example.com/api/v1/auth/sso/<slug>/saml/acs`.
5. Download **Certificate (Base64)** and paste into Innolope's IdP certificates field.
6. Note the **Login URL** from Azure for the IdP SSO URL.

### ADFS (SAML)

1. ADFS Management → **Relying Party Trusts → Add Relying Party Trust**.
2. Import from SP metadata URL: `https://cms.example.com/api/v1/auth/sso/<slug>/saml/metadata`.
3. Choose **Permit everyone**.
4. Add claim rules to send `email`, `name`, and `groups`.

---

## SCIM provisioning

SCIM lets your IdP create, update, and deactivate Innolope users automatically.

1. Open the SSO connection in **Settings → SSO** and scroll to **SCIM provisioning tokens**.
2. Click **Generate token**, give it a name (e.g. `Okta sync`), copy the token. It is shown only once.
3. In your IdP's SCIM client:
   - **Base URL**: `https://cms.example.com/api/v1/scim/<slug>/v2`
   - **Auth type**: Bearer token (HTTP Header)
   - **Unique identifier field**: `userName`
4. Test the connection. Innolope supports:
   - `POST /Users` — create (creates user if new, or links by email)
   - `GET /Users?filter=userName eq "x@y.com"`
   - `PATCH /Users/:id` with `active:false` — deactivates (removes project membership, revokes sessions)
   - `DELETE /Users/:id` — same as deactivate

### Okta SCIM

Applications → \<your app\> → Provisioning → Configure API Integration. Enter the base URL and bearer token. Enable Create / Update / Deactivate.

### Azure AD SCIM

Provisioning tab → Automatic → Tenant URL = base URL, Secret Token = the token.

---

## Enforcement and account linking

- **`enforceSso`** — when enabled on a connection, any user whose email domain matches will see SSO as the *only* option on the login page. Password login is hidden on the client; existing password sessions for matching users survive until they expire.
- **Silent linking** — on first SSO login, if a user already exists with the same email, their SSO identity is linked silently. No user action required.
- **Manual linking** — users can link or unlink SSO identities from **Account → Linked Accounts**. The last identity cannot be unlinked if the account has no password and the connection enforces SSO.

---

## Certificate rotation (SAML)

1. In **Settings → SSO → \<connection\>**, add the new IdP certificate (append it below the existing one in the certificates textarea — each cert goes between its `-----BEGIN CERTIFICATE-----`/`-----END CERTIFICATE-----` markers).
2. Save. Innolope now accepts assertions signed by either cert.
3. Flip the IdP to sign with the new cert.
4. Verify a fresh login works.
5. Remove the old cert from the textarea and save again.

Two-cert rollover avoids downtime. Having only one cert produces a UI warning.

---

## IdP-initiated SSO (SAML)

Disabled by default. To support Okta's "sign in from the dashboard tile" experience:

1. Enable **Allow IdP-initiated** on the SAML connection.
2. In Okta (or similar), set the **Default Relay State** to the path you want users to land on (e.g. `/dashboard`).
3. When `allowIdpInitiated` is off, SAML responses without `InResponseTo` are rejected.

Even with IdP-initiated enabled, Innolope enforces:
- Signature verification against `samlIdpCertPems`.
- Audience = `SAML_SP_ENTITY_ID`.
- Recipient = the ACS URL.
- `NotBefore` / `NotOnOrAfter` within ±`SSO_CLOCK_SKEW_SECONDS`.
- Replay cache (same `Response.ID` cannot be used twice within 10 min).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login page shows "Continue with password" but not SSO for the matched email | `enabled` is false on the connection, or the email domain isn't in the allowlist |
| "Invalid SAML response" | Signature doesn't match any of the configured `samlIdpCertPems`, or audience/recipient mismatch |
| "Replay detected" | Same `Response.ID` seen twice — typically a browser retry or a proxy double-posting |
| "Unknown or replayed state" (OIDC) | State TTL exceeded (10 min) or the user's IdP session bounced between two tabs |
| "Email domain is not allowed for this SSO connection" | The email's domain isn't listed in the connection's `domains` allowlist |
| SCIM returns 401 | Token is revoked, from a different connection, or mistyped |
| OIDC works, SAML doesn't | Check `SAML_SP_PRIVATE_KEY_PEM` and `SAML_SP_CERT_PEM` are set and match each other |

Enable trace logs: `LOG_LEVEL=debug` on the API to see SAML/OIDC events in detail.
