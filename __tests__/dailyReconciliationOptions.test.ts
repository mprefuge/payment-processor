import { describe, it, expect, afterEach } from 'vitest';

import { __internals } from '../src/handlers/dailyReconciliation';

const { parseOptions } = __internals;

/**
 * `dailyReconciliation` issues live DML against Salesforce and the QuickBooks general
 * ledger — postPayoutToQbo, postChargeToQbo, postManualEntryAsSalesReceipt and
 * upsertTransactionByExternalId — for every row it classifies as a discrepancy, with no
 * idempotency guard. Whether a run writes or only reports is decided entirely by
 * `dryRun`, so that default is the safety boundary for the whole handler.
 *
 * The timer path used to default it to `false`, meaning a deployment that never set
 * DAILY_RECONCILIATION_DRY_RUN inherited write mode.
 */
const asRequest = (params: Record<string, string> = {}) =>
  ({
    query: new URLSearchParams(params),
  }) as unknown as Parameters<typeof parseOptions>[0];

const expectOptions = <T>(result: T | { error: string }): T => {
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`parseOptions returned an error: ${(result as { error: string }).error}`);
  }
  return result as T;
};

describe('dailyReconciliation parseOptions — dryRun safety boundary', () => {
  afterEach(() => {
    delete process.env.DAILY_RECONCILIATION_DRY_RUN;
  });

  it('defaults the timer path to dry run when the variable is unset', () => {
    delete process.env.DAILY_RECONCILIATION_DRY_RUN;
    const options = expectOptions(parseOptions(null));
    expect(options.dryRun).toBe(true);
  });

  it('keeps the timer path in dry run for an unrecognized variable value', () => {
    process.env.DAILY_RECONCILIATION_DRY_RUN = 'maybe';
    const options = expectOptions(parseOptions(null));
    expect(options.dryRun).toBe(true);
  });

  it('lets the timer path write only on an explicit opt-in', () => {
    process.env.DAILY_RECONCILIATION_DRY_RUN = 'false';
    const options = expectOptions(parseOptions(null));
    expect(options.dryRun).toBe(false);
  });

  it('defaults the HTTP path to dry run', () => {
    const options = expectOptions(parseOptions(asRequest()));
    expect(options.dryRun).toBe(true);
  });

  it('honours an explicit dryRun=false query parameter on the HTTP path', () => {
    const options = expectOptions(parseOptions(asRequest({ dryRun: 'false' })));
    expect(options.dryRun).toBe(false);
  });

  it('ignores DAILY_RECONCILIATION_DRY_RUN on the HTTP path', () => {
    // The env var configures the scheduled run; an HTTP caller states its own intent.
    process.env.DAILY_RECONCILIATION_DRY_RUN = 'false';
    const options = expectOptions(parseOptions(asRequest()));
    expect(options.dryRun).toBe(true);
  });
});
