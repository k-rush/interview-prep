# Enable Interview Prep customer sign-in

The `customer` profile is a separate installation. It has no anonymous workspace, no private-test workspace, and no Firebase login fallback. Customers don't need Azure accounts. Don't change the existing workforce registration, tester allowlist, public demo, or private test to configure this profile.

## Configure the customer tenant

1. In a dedicated **Microsoft Entra External ID external tenant**, register Interview Prep as a **Web** application. Register exactly `https://YOUR-APP-HOST/auth/callback`, not a wildcard, SPA redirect, or the private-test callback. Use separate registrations, credentials and data for staging and production. Put the client secret in the hosting secret store.
2. Create a **Sign up and sign in** user flow with **Email with password**, email verification and self-service password reset. Enable **Username** in **Sign-in identifiers**, then collect and require **Username** for local sign-up in the flow. This is a real sign-in alias in addition to the recovery email, not the display name. [Username sign-up is in preview](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-sign-in-alias); confirm it is available and acceptable before public launch.
3. Configure [Apple](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-apple-federation-customers) (Services ID, Team ID, key ID and private key), [Google](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-google-federation-customers) (web OAuth client), and [personal Microsoft accounts](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-microsoft-accounts-federation-customers) (custom OIDC provider, `https://login.live.com` issuer). At each upstream provider register **Entra's federation return URLs**, not the app callback. Add all three providers and the Interview Prep web app to the same user flow. Request only sign-in/profile information; don't require a social user to create a password or disclose their non-relay email.
4. Configure the web registration to emit the `auth_time` optional **ID token** claim. The app checks fresh authentication for linking and sensitive actions; a missing or stale claim cannot authorize those operations. `idp` and `email` can improve the account settings display, but neither establishes ownership.
5. In **Company branding > Default sign-in**, upload [`banner.png`](../infra/identity/banner.png), [`favicon.png`](../infra/identity/favicon.png), and the [hosted stylesheet](../infra/identity/sign-in.css). Set the background to `#fdfdfa`, the title to **Sign in to Interview Prep**, and the footer links to your published privacy notice and terms. Apply the Interview Prep name when configuring upstream consent screens. The provider controls its own credential screens. Renew credentials before expiry, including the Apple client secret at least every six months.

## Configure the app

Use the existing application image behind HTTPS-only ingress on the exact public host. Use one writer on durable, access-controlled storage that supports SQLite locking; this profile does **not** make ephemeral container disk or a shared SQLite file production-ready. Keep `customers.sqlite` and the `customer-keys` directory private and backed up. Don't log OIDC callback query strings, tokens, cookies or secrets at the proxy.

| Environment setting | Value |
| --- | --- |
| `INTERVIEW_PREP_PLANE` | `customer` |
| `INTERVIEW_PREP_PUBLIC_ORIGIN` | `https://YOUR-APP-HOST` |
| `INTERVIEW_PREP_DATA` | Absolute private path for this customer installation. Do not mount the private test's checkpoint share. |
| `INTERVIEW_PREP_CUSTOMER_TENANT_ID` | External directory's tenant GUID |
| `INTERVIEW_PREP_CUSTOMER_CLIENT_ID` | Web app's client GUID, **not** an upstream social provider's ID |
| `INTERVIEW_PREP_CUSTOMER_CLIENT_SECRET` | Inject a secret-store reference; never put the value in Git or the browser bundle. |
| `INTERVIEW_PREP_CUSTOMER_LOGIN_HOST` | Optional: the DNS hostname of a [verified, configured custom login domain](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-custom-url-domain). Omit to use `ciamlogin.com`. Pick the final issuer and client before onboarding; changing them can change the identity key. |

Use the normal container settings (`INTERVIEW_PREP_PRIVATE_CONTAINER=1` in the container). Do not set `INTERVIEW_PREP_DEMO_ONLY`, tester, Firebase, billing or paid model credentials for a new pilot. Visit the app and select **Sign in**. `/healthz` should report `customer`; anonymous `/api/workspace` should return 401. On an isolated deployment exercise all four choices, a username collision, password reset and Apple Hide My Email. Verify that two users cannot see each other's workspace and that removing a method revokes that method's sessions.

**Sessions:** the app retains a hashed session handle; browser cookies last at most one hour. **Account > Sign-in methods** verifies the current method, then lets the user prove control of another one. Removing the current/last method is not allowed. Sign-out revokes this app session, not the customer's Apple, Google, or Microsoft account. For immediate operator revocation, disable the identity at the provider and revoke its app sessions in the customer store; disabling an upstream identity alone does not erase existing app cookies.

## Optional: move existing Firebase accounts

Skip this for a new installation. For an authorized cutover, stop the old writer and back up the legacy database. Use an isolated, consistent copy containing **only the intended managed accounts and their data** as `customers.sqlite`; never import the private-test or local anonymous workspace. Test restore before cutover. Retain the old Firebase project for email-link verification and authorize the new app origin for its email links.

Set `INTERVIEW_PREP_CUSTOMER_MIGRATE_FIREBASE=1` and the legacy `INTERVIEW_PREP_FIREBASE_PROJECT`, `INTERVIEW_PREP_FIREBASE_WEB_API_KEY` and, if used, `INTERVIEW_PREP_FIREBASE_SERVER_API_KEY`. Before creating a new customer workspace, the signed-out user selects the legacy email-link option, proves the old login, then authenticates with the new customer method. The app retains the same workspace ID, evidence, billing mapping and usage, invalidates the old sessions and consumes the migration proof. An existing customer identity is never silently reassigned. For an account with a test Stripe customer, also configure its original test integration and `INTERVIEW_PREP_CUSTOMER_TEST_BILLING=1`; live Stripe remains disabled. Remove migration and Firebase settings together after cutover.
