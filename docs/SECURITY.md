# Production Security Checklist

The codebase intentionally treats frontend role checks as presentation only. Every sensitive operation is authorized by the Express API.

## Required before a government production launch

1. **HTTPS only.** Put the API behind a managed TLS reverse proxy/load balancer. Enable `SESSION_COOKIE_SECURE=true`.
2. **Same-site deployment.** Prefer `https://lgs.gov.lk` and `https://api.lgs.gov.lk` so secure cookies work predictably. Keep the CORS list exact; never use `*` with credentials.
3. **Managed MySQL with TLS.** Set `DB_SSL=true`, encryption at rest, automated backups, point-in-time recovery, multi-AZ/high availability where required.
4. **Separate DB identities.** The runtime application user should receive only DML permissions. Use a separate migration identity for schema changes.
5. **Secrets manager.** Do not keep production `.env` files on servers or in Git. Use the hosting platform's secret manager/KMS.
6. **MFA or government SSO for GOV_ADMIN / APPROVER / SUPERIOR.** The included session system is a secure baseline, but privileged production access should add MFA/IdP controls.
7. **Private object storage.** Replace local `uploads/` with S3/R2/Azure Blob or equivalent, private buckets, server-side encryption, short-lived signed downloads, malware scanning, retention rules.
8. **WAF / DDoS controls.** Put the public API behind a managed edge/WAF and keep application rate limits as a second layer.
9. **Central audit retention.** Forward application logs/audit events to a write-protected central log/SIEM. Decide retention based on government records policy.
10. **Vulnerability management.** CI should run dependency scanning, secret scanning, SAST, container scanning, and patch SLAs.
11. **Penetration testing.** Test auth, RBAC, IDOR/BOLA, file uploads, XSS in stored content, SQL injection, SSRF, CSRF, session management, GIS endpoints, and privilege boundaries.
12. **Privacy/data minimization.** Do not expose citizen identity, internal notes, tax data, or operational officer details on public map endpoints.
13. **Backups and recovery drills.** A backup that has never been restored is not a tested backup.

## Role control

- public registration always becomes `CITIZEN`
- government accounts are invitation-based
- role changes require `users.manage`
- a user cannot modify their own role
- an account status/role change revokes active sessions
- a password change revokes active sessions
- only `SUPERIOR` receives `users.manage` in the supplied permission seed

## Session model

A random session token is stored only in an `HttpOnly` browser cookie. MySQL stores only its SHA-256 hash. Compromise of the session table therefore does not directly reveal live bearer tokens.

## Request confidentiality

- Citizen request lists are automatically scoped to their creator ID.
- Worker request lists are automatically scoped to the assigned worker ID.
- Government-wide visibility requires `request.all.read`.
- Private request IDs should not be used as the authorization mechanism; every lookup applies scope checks.
- Internal notes and internal attachments are filtered from citizen responses.

## GIS privacy

Public building endpoints contain only public-safe location/name/type data. Property, assessment, and tax tables are separate and protected by dedicated permissions.

The Visigeo proxy only proxies a fixed configured provider and validated tile coordinates. Do not add a generic `?url=` proxy endpoint.

## External OSM services

Nominatim/Overpass public endpoints are useful for development and low-volume validation, but they are not a government production SLA. For production scale, use an approved geocoding provider or operate an internal instance, then update the fixed environment URLs.
