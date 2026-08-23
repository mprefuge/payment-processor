# Changelog

## [Unreleased] - Production Readiness Improvements

### Added

- **The QuickBooks posting strategy in effect is logged once per process** on the first charge post (`[QBO] Accounting posting strategy in effect`), including whether it was reached through the `journal-entry` alias — so nobody has to read the deployment secret to find out which set of documents a running app is producing. The log carries the strategy name only, never a credential. Both strategies are documented side by side in `docs/QBO_POSTING_STRATEGIES.md`.
- **End-to-end field-population verification**: The smoke/E2E flow now posts a payload that fills in every input `/api/transaction` accepts, waits for propagation, reads the created records back via the new `POST /api/ops/test-artifact-verify` endpoint, and fails if any field the flow should have populated is empty or holds the wrong value — including the cross-system links between the Stripe customer, Checkout session, Salesforce `Contact` and `Transaction__c`. Cleanup then runs after a second delay, as before.
- **Comprehensive README.md**: Complete project documentation including setup, configuration, API endpoints, and deployment instructions
- **New Test Coverage**: Added unit tests for utility functions previously untested:
  - `__tests__/http.test.ts`: Tests for HTTP response utilities
  - `__tests__/time.test.ts`: Tests for time/date utilities
  - `__tests__/errors.test.ts`: Tests for custom error classes
- **Git Configuration Files**:
  - `.gitattributes`: Proper line ending configuration for cross-platform development
- **Total Test Coverage**: 20 test files, 104 passing tests, 7 skipped tests

### Fixed

- **The `sales-receipt` posting strategy booked revenue net and no processor-fee expense**: the Stripe fee was appended to the donor's SalesReceipt as a **negative** sales line carrying the _revenue_ Item with `ItemAccountRef` pointed at the fees account. A QuickBooks sales line posts to the income account configured on the Item itself — `ItemAccountRef` on the line does not redirect it — so the negative line landed as contra-revenue. A $100 gift with fees covered produced one receipt totalling $99.94 (`+100.00`, `+2.50`, `−2.56`) instead of a $102.50 receipt plus a $2.56 expense. The receipt now stays at gross and the fee is posted as its own paired journal entry (Dr Stripe Fees / Cr Stripe Clearing) via the previously dead `buildFeesJE`, with a `FEE-`-prefixed DocNumber sharing the receipt's date and charge-id tail so the pair is traceable and each half dedupes independently on retry. Both strategies now book revenue at gross, the fee as its own expense, and leave Stripe Clearing holding exactly the Stripe payout.
- **`ACCOUNTING_POSTING_STRATEGY=journal-entry` failed the whole function app at startup**: `journal-entry` was published in the operator docs but was never a valid enum value, so it failed `loadEnv` and took the entire app down rather than just the QuickBooks path. It names the same strategy as `je-transfer` and is now accepted as an alias for it; any genuinely unknown value still throws. The docs that named it (`docs/QUICK_START_CHECKLIST.md`, `docs/STRIPE_TRUE_UP_DEPLOYMENT_GUIDE.md`) now agree with the code.
- **Organization gifts no longer sync to QuickBooks as an anonymous customer**: the Salesforce side derived the QuickBooks customer name from the Contact alone, so any `Transaction__c` linked to an `Account__c` instead of a `Contact__c` fell through to an anonymous default and posted against a single shared customer. Fixed in both senders this repo describes — the `QBO_Customer_Name__c` formula field and the five `QBO_Bill_Addr_*` formulas now fall back to the Account's name and billing address, and `QBOManualSyncService` skips contact matching for Account-linked transactions so it no longer invents a Contact named after the organization. The equivalent formula for orgs that send from a record-triggered Flow instead of Apex is documented in `docs/SALESFORCE_MANUAL_QBO_SYNC_SETUP.md`. The name is built in Salesforce, so an org needs its own sender updated for the fix to take effect.
- **`POST /qbo/manual-sync` no longer posts a sales receipt with no customer**: reference resolution swallows its own failures, and `CustomerRef` was never validated, so an unresolved customer produced a receipt with the donor stripped off — reported as a success, which marked the Salesforce record posted and stopped it being retried. An unresolved `CustomerRef` now fails validation, the response echoes the `customerId`/`customerName` the document was posted against, and a placeholder customer name is returned as a warning.

### Changed

- **Code Formatting**: All source files formatted with Prettier for consistency
- **Documentation**: Updated inline code comments and JSDoc where appropriate
- **QuickBooks Integration**: Automatically refresh and persist QuickBooks OAuth tokens so manual environment updates are not typically required

### Quality Assurance

- ✅ All tests passing (104 passed, 7 skipped)
- ✅ TypeScript compilation successful with no errors
- ✅ Type checking passes with `tsc --noEmit`
- ✅ Code formatting verified with Prettier
- ✅ CI pipeline (`npm run ci`) executes successfully

### Project Structure

```
payment-processor/
├── __tests__/              # 20 comprehensive test files
├── src/
│   ├── handlers/           # Azure Function handlers (6 endpoints)
│   ├── services/           # Business logic & integrations
│   ├── lib/                # Utility libraries
│   ├── config/             # Configuration management
│   └── domain/             # Domain models
├── docs/                   # Extensive feature documentation
├── .github/workflows/      # CI/CD pipelines
├── README.md               # Project documentation
├── .gitattributes          # Git line ending configuration
├── .prettierrc.json        # Code formatting rules
├── .prettierignore         # Prettier exclusions
└── package.json            # Dependencies & scripts
```

### Testing Improvements

- Added utility function tests to increase code coverage
- All existing tests maintained and passing
- Integration tests verify complete payment flows
- Idempotency tests ensure duplicate prevention

### Code Quality

- Consistent code style enforced via Prettier
- TypeScript strict mode enabled
- No linting errors
- No compilation errors
- Clean git repository structure

### Production Readiness Checklist

- [x] All tests passing
- [x] Build process successful
- [x] TypeScript compilation with no errors
- [x] Code formatted consistently
- [x] Comprehensive documentation
- [x] Environment variable templates
- [x] Health check endpoint
- [x] Error handling in place
- [x] Logging configured
- [x] Idempotency implemented
- [x] Security: Secret redaction
- [x] Azure Functions v4 compatible

### Next Steps for Deployment

1. Review and update `local.settings.json` with production values
2. Configure Azure Function App settings
3. Set up Stripe webhooks for production
4. Configure QuickBooks OAuth credentials
5. Set up Salesforce integration credentials
6. Configure Application Insights monitoring
7. Deploy using `func azure functionapp publish <APP_NAME>`
