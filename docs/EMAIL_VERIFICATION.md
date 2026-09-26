# Arenifi email verification

## Behaviour

- New password registrations receive a 24-hour, single-use verification link.
- Google accounts are treated as verified when Google supplies the same account email.
- Legacy accounts with an email must verify it before changing username or withdrawing.
- Legacy accounts without an email must add and verify one before either action.
- Verification is permanent unless account email behaviour is changed in a future migration.
- Only a SHA-256 hash of the verification token is stored. A resend invalidates the older link.

## Backend variables (Railway)

```ini
FRONTEND_URL=https://arenifi.fun
RESEND_API_KEY=re_...
EMAIL_FROM=Arenifi <verify@arenifi.fun>
EMAIL_REPLY_TO=support@arenifi.fun
```

`RESEND_API_KEY` is a backend secret. Never add it to Vite, Cloudflare Pages, or client code.

## DNS and Resend

1. Add `arenifi.fun` as a sending domain in Resend.
2. Add the DNS records displayed by Resend to the authoritative Cloudflare DNS zone exactly as shown.
3. Keep mail-related CNAME records DNS-only (not proxied). TXT and MX records are not proxied.
4. Wait for Resend to mark the domain verified.
5. Create a sending API key and add it to Railway as `RESEND_API_KEY`.
6. Make sure the address in `EMAIL_FROM` belongs to the verified domain.

Cloudflare Email Routing is only needed if replies to `support@arenifi.fun` should arrive in an inbox. It is not the service that sends these verification emails.

## Release and smoke test

Email changes are available in Profile > Account settings. The current inbox must approve each change, even if already verified, then the new inbox must confirm. The current account email remains active until both steps complete. Links expire after 24 hours; a new request replaces the previous pending change. The existing Resend and DNS configuration is reused. Existing linked Google sign-in remains linked to the same account.

1. Deploy the backend after setting the Railway variables.
2. Deploy the frontend.
3. Register a new test account with an inbox you control.
4. Check that one email arrives, the link opens `/verify-email`, and the account becomes verified.
5. Confirm the same link cannot be used twice.
6. For a legacy unverified account, confirm username change and withdrawal redirect to verification.
7. For a verified account, confirm both actions work without another prompt.
8. In Admin > Users, confirm the account shows Verified, Unverified, or No email.
