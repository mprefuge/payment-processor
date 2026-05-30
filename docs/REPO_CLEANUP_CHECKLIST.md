# Repository Cleanup Checklist

Use this checklist before production deployment to keep the repository clean and reduce confusion for operators.

Guidance:

- `Delete` means remove from the active repo when retention is not required.
- `Archive` means move to a dated operator archive or separate internal artifacts repo.
- `Keep` means retain in the active repo with a current owner and purpose.

## Completed Cleanup

- [x] Delete [summary](/c:/Projects/payment-processor/summary)
  Reason: root-level generated analysis output.
  Completed: removed on 2026-03-31 after confirming it was untracked.

- [x] Delete [null](/c:/Projects/payment-processor/null)
  Reason: accidental root-level JSON output with a non-descriptive filename.
  Completed: removed on 2026-03-31 after confirming it was untracked.

- [x] Delete [.artifacts](/c:/Projects/payment-processor/.artifacts)
  Reason: one-off audit, validation, and debugging residue.
  Completed: removed on 2026-03-31 after confirming it was untracked.

- [x] Remove stale [dist](/c:/Projects/payment-processor/dist) contents and rebuild cleanly
  Reason: stale compiled output should never be treated as canonical.
  Completed: removed and regenerated with a clean `npm run build` on 2026-03-31.

- [x] Delete [scripts/audit-broken-shared-qbo-links.js](/c:/Projects/payment-processor/scripts/audit-broken-shared-qbo-links.js)
  Reason: untracked one-off recovery utility with no live references.
  Completed: removed on 2026-03-31.

- [x] Delete [scripts/resync-qbo-stripe-transactions.js](/c:/Projects/payment-processor/scripts/resync-qbo-stripe-transactions.js)
  Reason: untracked manual resync helper with no live references.
  Completed: removed on 2026-03-31.

- [x] Delete [scripts/retry-stripe-salesforce-by-charge.js](/c:/Projects/payment-processor/scripts/retry-stripe-salesforce-by-charge.js)
  Reason: untracked targeted replay utility with no live references.
  Completed: removed on 2026-03-31.

- [x] Delete [scripts/sync-specific-stripe-charges-to-salesforce.js](/c:/Projects/payment-processor/scripts/sync-specific-stripe-charges-to-salesforce.js)
  Reason: untracked targeted sync helper with no live references.
  Completed: removed on 2026-03-31.

- [x] Delete [scripts/sync-stripe-to-salesforce.js](/c:/Projects/payment-processor/scripts/sync-stripe-to-salesforce.js)
  Reason: untracked bulk sync helper with no live references.
  Completed: removed on 2026-03-31.

- [x] Delete [docs/stripe-salesforce-live-dry-run-2026-03-30.json](/c:/Projects/payment-processor/docs/stripe-salesforce-live-dry-run-2026-03-30.json)
  Reason: dated environment-specific output rather than evergreen documentation.
  Completed: removed on 2026-03-31 after confirming it was untracked.

## Remaining Review

- [ ] Review [salesforce/layouts/Transaction__c-Stripe%20Transaction.layout-meta.xml](/c:/Projects/payment-processor/salesforce/layouts/Transaction__c-Stripe%20Transaction.layout-meta.xml)
  Proposed action: Keep unless Salesforce metadata deployment has moved elsewhere.
  Reason: appears to be intentional platform metadata.

- [ ] Review remaining deployment/helper scripts in [scripts](/c:/Projects/payment-processor/scripts)
  Proposed action: Keep only scripts that have an owner, a documented purpose, and a current runbook reference.
  Reason: some scripts may still be valid operator tools even if they are not wired into CI.

- [ ] Review implementation-summary and incident-specific docs in [docs](/c:/Projects/payment-processor/docs)
  Proposed action: Keep docs that describe current behavior; archive stale summaries and superseded notes.
  Reason: the docs directory likely mixes evergreen references with historical writeups.

## Packaging Hygiene

- [ ] Verify [.funcignore](/c:/Projects/payment-processor/.funcignore) still excludes docs, scripts, tests, source, and local settings from publish output.
- [ ] Verify [.gitignore](/c:/Projects/payment-processor/.gitignore) excludes generated output and local investigation residue.
- [ ] Add a clean-build deployment step that removes stale [dist](/c:/Projects/payment-processor/dist) contents before rebuilding.

## Exit Criteria

- [x] High-confidence residue is removed.
- [x] Untracked medium-confidence residue is removed.
- [ ] Low-confidence files have explicit keep/archive decisions.
- [x] Deployment packaging is based on a fresh clean build.
- [ ] The repo root contains only intentional project files.