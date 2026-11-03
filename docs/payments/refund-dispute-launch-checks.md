# Refund/dispute launch checks — 2026-10-22

## Review of the live definitions supplied by the owner

The three exported single-card RPCs exist in the live database and expose EXECUTE only to postgres and service_role. Both claim and begin lack payout_hold_reason checks. The local 20261022135144 migration adds those checks, but that migration is not reflected in the exported live definitions. Do not assume it has been applied successfully.

The exported completion RPC records an already verified transfer and allows identical replay. Its source was missing from the uploaded repository. The new 20261022213000 migration preserves that signature and adds format validation, existing-charge conflict checks, split-mode rejection, timestamps, explicit permissions, and preservation/escalation of a late hold. It records money that already moved; it does not release a hold or send a transfer.

Both transfer verifiers previously checked reversed alone. They now also require amount_reversed === 0, so partial recoveries cannot be accepted as an intact payout.

## What was tested locally

- 24 offline Node tests: signed webhook routing and rejection, retries, risk matching, stale payload status, transfer attempt refusal, both funding parts, partial/full reversal rejection.
- PGlite executes the three safeguard migrations against a minimal fixture. Assertions cover duplicate/conflicting holds, ownership mismatch, terminal dispute preservation, late attempts, both payout gates, restricted completion/claim permissions, identical completion replay, conflicting completion IDs, missing authorization, charge mismatch, and a hold surviving completion of an already sent payout.
- TypeScript and targeted ESLint passed.

These are not a full Supabase migration replay, true concurrent PostgreSQL transaction tests, or Stripe sandbox end-to-end tests.

## Read-only recovery review

For any payment with a hold, an uncertain attempt, refund activity, dispute activity, or a reversal:

1. Keep the hold. Do not reset attempted_at, set not_transferred, or retry transfer creation.
2. Match the parent payment, both split parts where applicable, stored PaymentIntent/charge IDs, transfer metadata, destination, currency, group, and amount. Do not associate a transfer using amount alone.
3. Retrieve Stripe's current charge, all refund pages, dispute, transfer, and all reversal pages. Compare with database IDs. If a transfer ID was not saved, search all candidate transfers and require one unambiguous match; absence after an uncertain attempt is not permission to create again.
4. A refund to the customer and a transfer reversal are separate accounting entries. Reversing provider funds does not prove the customer was refunded. A disputed amount and a refund must not cause duplicate customer reimbursement.
5. Record customer refund status/amount, dispute status/deadline, provider transfer amount, amount already reversed, remaining unrecovered transfer amount, and reviewed Stripe object IDs. amount_reversed is the recovered total on that transfer, not the amount of customer refund.
6. If Stripe confirms an intact transfer already happened but the database is pending, reconciliation may record that transfer while preserving the hold. Do not reconcile a partially/full reversed transfer as an intact payout.
7. Any actual reversal/refund requires a separately reviewed amount, available balance assessment, idempotency key, and explicit owner authorization. Do not blindly reverse the full transfer for a partial refund or infer a reversal amount from the 15% fee alone.
8. Retain the hold through partial recovery, failed refund, won/closed dispute, or uncertain network response. Verify customer reimbursement and provider recovery separately before an authorized release. No automated release or recovery executor is included in this patch.

## Sandbox execution — pending environment access

Use an isolated Stripe sandbox and a separate non-production Supabase project/local stack. Never run these scenarios against the production project shown in the owner's screenshots. Keep test credentials in the Mac's local environment; do not paste keys into chat. No credentials were available in this review session, and no Stripe account/settings were accessed.

Before execution, verify the sandbox account identity, test-mode key, non-production database URL, exact app build, migration state, connected recipient account, and risk-event endpoint subscriptions. Use test payment methods only. Do not run a generic CLI trigger expecting it to test ownership matching: fixtures must use real sandbox PaymentIntents registered to the seeded service payment/parts.

| Scenario | Required evidence |
| --- | --- |
| Single and split clean success | One provider transfer with correct destination/group/amount; correct stored IDs |
| Refund before claim; before begin | Hold blocks transfer; no new transfer in Stripe |
| Dispute on either split card | Parent hold blocks the entire payout |
| Refund/dispute after begin; after send; before completion | Preserved attempt, manual review hold, no duplicate transfer; already sent transfer remains discoverable |
| Completion before hold; hold before completion | Hold survives both execution orders; same transfer ID retained |
| Webhook replay/out-of-order delivery | Idempotent effect; no new payout; terminal dispute status does not regress |
| Timeout after transfer/refund API accepts request | Reconcile existing object; no second object or automatic retry |
| Partial refund; failed/pending refund; partial/full reversal | Hold retained; separate customer/provider accounting; intact-settlement verifier rejects reversed transfer |
| Wrong PaymentIntent/charge/account or ambiguous ownership | No hold on unrelated payment and no transfer authorization |
| Connected account loses recipient capability | New transfer rejected/held by the settlement system; no unintended retry |
| True concurrent database transactions | Two sessions interleave hold/claim/begin/completion; at most one attempt and no lost hold |

For each case record sandbox account, database environment, app version, Stripe event/object IDs, before/after database state, and whether the expected transfer count is met. Redact credentials. These executions remain required before launch.

## Approval boundary

No live migrations, deployment, charges, refunds, transfers, reversals, webhook setting changes or hold releases were performed. The migration files and local installer are review artifacts. Applying database changes still requires the owner's approval, with staging validation first.
