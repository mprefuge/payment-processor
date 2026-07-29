# Changelog

## [Unreleased] - Production Readiness Improvements

### Added

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

- **Organization gifts no longer sync to QuickBooks as "Anonymous Donor"**: the Salesforce `QBO_Customer_Name__c` formula read only `Contact__r.Name`, so any `Transaction__c` linked to an `Account__c` instead of a `Contact__c` fell through to the anonymous default and posted against a single shared QuickBooks customer. The formula (and the five `QBO_Bill_Addr_*` formulas) now fall back to the Account's name and billing address, and `QBOManualSyncService` skips contact matching for Account-linked transactions so it no longer invents a Contact named after the organization. Applies to `scripts/deploy-salesforce-qbo-sync.ps1` and `docs/SALESFORCE_MANUAL_QBO_SYNC_SETUP.md`; existing orgs need the formula updated in Setup (or a redeploy) for the fix to take effect.

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
