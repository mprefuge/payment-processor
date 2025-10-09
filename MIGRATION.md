# Migration Guide

Follow these steps to safely roll out the accounting sync feature to production:

1. Deploy the code with the feature flag `ACCOUNTING_SYNC_ENABLED=false`.
2. Verify that the health check endpoint reports green status.
3. Enable the feature in staging and exercise both `processTransaction` and a test checkout. Confirm that Salesforce `Transactions__c` records upsert correctly and that QuickBooks Online posts succeed in the sandbox environment.
4. Enable the feature in production by setting `ACCOUNTING_SYNC_ENABLED=true`.
5. Run `stripeTrueUp?from=YYYY-MM-DD&to=YYYY-MM-DD&type=payments&dryRun=true`, review the summary output, and then rerun the command with `dryRun=false` once everything looks correct.
6. Monitor the Stripe clearing rollforward against Stripe payouts for the first close to ensure balances align.

These steps ensure the deployment maintains system stability while validating integrations before full production rollout.
