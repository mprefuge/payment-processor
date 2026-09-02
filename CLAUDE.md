# Working agreements for Claude in this repository

## Background work

- **Never schedule check-ins or self-re-arming timers.** No `send_later`, no routines, no cron, no
  polling loops to watch the status of a PR, a CI run, a deploy, or anything else. A check-in that
  re-arms itself wakes the session on a timer whether or not anything changed, and every wake
  replays the whole conversation. It runs until someone finds and deletes it.
- **Do not call `subscribe_pr_activity`.** After opening a pull request, report the link and stop.
- If a PR should be watched, Micah will ask for it in that session. That request covers that
  session only; it is not standing permission.
- Before ending a session in which you opened a PR, make sure you left nothing armed. Scheduled
  routines outlive the session that created them.

## Verification

- `npm run verify` is the gate: typecheck, Prettier, build, then the full test suite.
- Ten suites load the compiled bundle from `dist/`, so `npm run test:unit` fails on a fresh clone
  until `tsc` has run. Use `npm run verify`, or run `tsc` first.

## Financial correctness

- Every cent must reconcile across Stripe, QuickBooks, and Salesforce.
- Refunds are excluded from positive totals.
- Net is computed from its components (gross, fee, refund). Never trust a stored net.
- Default to read-only. Flag any write to Stripe, QuickBooks, or Salesforce and get approval before
  running it, including from operational and reconciliation endpoints.
