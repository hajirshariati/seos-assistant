# Security & Incident Response Policy — SEoS Assistant

_Last updated: June 18, 2026 · Owner: Hajir Shariati (help@aetrex.com)_

This is the internal operational policy for how the SEoS Assistant app
protects merchant and customer data and responds to security incidents.
It backs the attestations made in Shopify's Protected Customer Data
request. It is an **internal** document — it is not the customer-facing
privacy policy (that lives at `/privacy`).

## 1. Data we handle

- **Merchant/store data**: catalog, configuration, knowledge files
  (stored in our PostgreSQL database).
- **Protected customer data**: a signed-in shopper's **name, email,
  address**, and **order history** — accessed **live** from Shopify's
  Admin API to answer that shopper's own
  questions. **We do not persist customer PII in our database**; it is
  used in-session and discarded.

## 2. Safeguards (current practices)

- **Encryption in transit**: all traffic is HTTPS/TLS.
- **Encryption at rest**: database and managed backups are encrypted by
  our host (Railway).
- **Test/production separation**: development uses a separate database
  and store from production.
- **Least privilege**: production database and hosting access is
  restricted to authorized operators only.
- **Strong auth**: 2FA is required on all admin accounts (Shopify
  Partners, Railway, GitHub).
- **Secrets**: API keys and tokens are stored as environment variables,
  never committed to source control.
- **PII access logging**: every access to protected customer data is
  recorded in our platform logs as a `[pii-access]` event (shop,
  customer id, field groups, purpose) — **values are never logged**.
- **Data subject requests**: we honor Shopify's privacy webhooks —
  `customers/redact`, `customers/data_request`, `shop/redact`.

## 3. Data retention

- Customer PII: **not stored** (fetched live, used in-session).
- Operational data (catalog, config, chat usage/analytics): retained
  only as long as the app is installed; removed on uninstall / shop
  redaction.

## 4. Incident response procedure

If a security incident is suspected (data exposure, unauthorized access,
leaked credential, vulnerability report):

1. **Detect & record** — log the time, what was observed, and who
   reported it.
2. **Contain** — rotate affected credentials/keys immediately; revoke
   sessions; if needed, take the affected component offline.
3. **Assess** — determine what data was involved, how many merchants/
   customers are affected, and the root cause.
4. **Notify**:
   - **Shopify** — report security issues affecting Shopify merchants/
     customers promptly (within Shopify's required window, target ≤ 24h
     of confirmation) via the Partner Dashboard / security contact.
   - **Affected merchants** — notify without undue delay with scope and
     remediation steps.
   - Regulators/customers where legally required.
5. **Remediate** — deploy the fix; verify the vulnerability is closed.
6. **Post-incident review** — document root cause, timeline, and
   preventive actions; update this policy.

## 5. Reporting a vulnerability

Email **help@aetrex.com** with details. We aim to acknowledge
within 2 business days.

## 6. Review

This policy is reviewed at least annually and after any incident.
