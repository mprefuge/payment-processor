import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// createRequire so we can use Node's native CJS require and require.cache directly.
const require = createRequire(import.meta.url);

// Load the real @sendgrid/mail once.  Node caches CJS modules in require.cache, so
// emailService.js (which also calls require('@sendgrid/mail')) gets the *same* object
// reference.  We spy on that shared object in beforeEach instead of trying to
// intercept via vi.mock (which doesn't reliably intercept nested CJS require() calls).
const sgMail = require('@sendgrid/mail');

function reloadEmailService() {
  // Delete the emailService cache entry so it re-runs module-level code (e.g. reading
  // process.env.SENDGRID_API_KEY and setting isSendGridEnabled) on next require().
  const emailServicePath = require.resolve('../dist/services/payoutRecon/emailService.js');
  delete require.cache[emailServicePath];
  return require('../dist/services/payoutRecon/emailService.js');
}

// ── emailService – SendGrid disabled ─────────────────────────────────────────

describe('emailService – SendGrid disabled (no API key)', () => {
  let sendPaymentSuccessEmail;

  beforeEach(() => {
    vi.spyOn(sgMail, 'setApiKey').mockImplementation(() => {});
    vi.spyOn(sgMail, 'send').mockResolvedValue([{ statusCode: 202 }]);
    delete process.env.SENDGRID_API_KEY;
    sendPaymentSuccessEmail = reloadEmailService().sendPaymentSuccessEmail;
  });

  it('returns skipped/sendgrid_disabled when SendGrid not configured', async () => {
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      {}
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('sendgrid_disabled');
  });
});

// ── emailService – SendGrid enabled ──────────────────────────────────────────

describe('emailService – SendGrid enabled', () => {
  let sendPaymentSuccessEmail;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(sgMail, 'setApiKey').mockImplementation(() => {});
    vi.spyOn(sgMail, 'send').mockResolvedValue([{ statusCode: 202 }]);

    process.env.SENDGRID_API_KEY = 'SG.testkey.abcdef';
    process.env.NOTIFICATION_EMAIL_TEST = 'admin@example.com';
    process.env.NOTIFICATION_EMAIL_LIVE = 'live-admin@example.com';
    process.env.NOTIFICATION_EMAIL_FROM = 'noreply@example.com';
    delete process.env.NOTIFICATION_POLICY;

    sendPaymentSuccessEmail = reloadEmailService().sendPaymentSuccessEmail;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  const makeStripe = (paymentIntents = []) => ({
    customers: {
      retrieve: vi.fn().mockResolvedValue({ id: 'cus_1' }),
    },
    paymentIntents: {
      list: vi.fn().mockResolvedValue({ data: paymentIntents }),
    },
  });

  it('returns skipped/missing_recipient when recipient email not configured', async () => {
    delete process.env.NOTIFICATION_EMAIL_TEST;
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('missing_recipient');
  });

  it('sends email with ALL policy (default)', async () => {
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe([{ status: 'succeeded' }])
    );
    expect(result.status).toBe('sent');
  });

  it('skips email with NONE policy', async () => {
    process.env.NOTIFICATION_POLICY = 'NONE';
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('policy_skip');
  });

  it('sends email with FIRST policy on first successful payment', async () => {
    process.env.NOTIFICATION_POLICY = 'FIRST';
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe([{ status: 'succeeded' }])
    );
    expect(result.status).toBe('sent');
  });

  it('skips email with FIRST policy on second+ successful payment', async () => {
    process.env.NOTIFICATION_POLICY = 'FIRST';
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe([{ status: 'succeeded' }, { status: 'succeeded' }])
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('policy_skip');
  });

  it('sends email with ABOVE policy when amount exceeds threshold', async () => {
    process.env.NOTIFICATION_POLICY = 'ABOVE 25';
    // 5000 cents = $50, above the $25 threshold
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(result.status).toBe('sent');
  });

  it('skips email with ABOVE policy when amount is at or below threshold', async () => {
    process.env.NOTIFICATION_POLICY = 'ABOVE 100';
    // 5000 cents = $50, not above the $100 threshold
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(result.status).toBe('skipped');
  });

  it('sends email with MINIMUM policy when amount meets threshold', async () => {
    process.env.NOTIFICATION_POLICY = 'MINIMUM 50';
    // 5000 cents = $50, exactly meets the $50 minimum
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(result.status).toBe('sent');
  });

  it('skips email with MINIMUM policy when amount is below threshold', async () => {
    process.env.NOTIFICATION_POLICY = 'MINIMUM 100';
    // 5000 cents = $50, below the $100 minimum
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(result.status).toBe('skipped');
  });

  it('returns failed status when sgMail.send throws', async () => {
    vi.spyOn(sgMail, 'send').mockRejectedValueOnce(new Error('Network error'));
    const result = await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(result.status).toBe('failed');
  });

  it('uses live recipient email in live mode', async () => {
    await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: true,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: true, amount: 5000 },
      makeStripe()
    );
    expect(sgMail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['live-admin@example.com'] })
    );
  });

  it('sends to multiple recipients when comma-separated emails are configured', async () => {
    process.env.NOTIFICATION_EMAIL_TEST = 'alice@example.com, bob@example.com';
    sendPaymentSuccessEmail = reloadEmailService().sendPaymentSuccessEmail;
    await sendPaymentSuccessEmail(
      {
        firstname: 'Jane',
        lastname: 'Doe',
        email: 'jane@example.com',
        amount: 5000,
        frequency: 'one-time',
        livemode: false,
      },
      { id: 'pi_1', customer: 'cus_1', livemode: false, amount: 5000 },
      makeStripe()
    );
    expect(sgMail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['alice@example.com', 'bob@example.com'] })
    );
  });
});

// ── sendNewTransactionNotification ───────────────────────────────────────────

describe('sendNewTransactionNotification', () => {
  let sendNewTransactionNotification;
  const originalEnv = { ...process.env };

  function reloadSendNewTransactionNotification() {
    const emailServicePath = require.resolve('../dist/services/payoutRecon/emailService.js');
    delete require.cache[emailServicePath];
    return require('../dist/services/payoutRecon/emailService.js').sendNewTransactionNotification;
  }

  beforeEach(() => {
    vi.spyOn(sgMail, 'setApiKey').mockImplementation(() => {});
    vi.spyOn(sgMail, 'send').mockResolvedValue([{ statusCode: 202 }]);

    process.env.SENDGRID_API_KEY = 'SG.testkey.abcdef';
    process.env.NOTIFICATION_EMAIL_FROM = 'noreply@example.com';
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST = 'admin@example.com';
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_LIVE = 'live-admin@example.com';
    delete process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST;

    sendNewTransactionNotification = reloadSendNewTransactionNotification();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  const makePaymentData = (overrides = {}) => ({
    billingName: 'Jane Doe',
    billingEmail: 'jane@example.com',
    amountCents: 5000,
    currency: 'usd',
    paymentIntentId: 'pi_test_1',
    customerId: 'cus_test_1',
    subscriptionId: null,
    isLiveMode: false,
    ...overrides,
  });

  it('returns skipped/sendgrid_disabled when SendGrid not configured', async () => {
    delete process.env.SENDGRID_API_KEY;
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    const result = await sendNewTransactionNotification(makePaymentData(), 'first_time');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('sendgrid_disabled');
  });

  it('returns skipped/no_recipients_configured when env var is not set', async () => {
    delete process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST;
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    const result = await sendNewTransactionNotification(makePaymentData(), 'first_time');
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_recipients_configured');
  });

  it('sends to a single recipient', async () => {
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST = 'admin@example.com';
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    const result = await sendNewTransactionNotification(makePaymentData(), 'first_time');
    expect(result.status).toBe('sent');
    expect(result.recipients).toBe(1);
    expect(sgMail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['admin@example.com'] })
    );
  });

  it('sends to multiple comma-separated recipients', async () => {
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST =
      'alice@example.com, bob@example.com, carol@example.com';
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    const result = await sendNewTransactionNotification(makePaymentData(), 'new_recurring');
    expect(result.status).toBe('sent');
    expect(result.recipients).toBe(3);
    expect(sgMail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['alice@example.com', 'bob@example.com', 'carol@example.com'] })
    );
  });

  it('uses live recipients in live mode', async () => {
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_LIVE = 'live@example.com';
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    await sendNewTransactionNotification(makePaymentData({ isLiveMode: true }), 'first_time');
    expect(sgMail.send).toHaveBeenCalledWith(expect.objectContaining({ to: ['live@example.com'] }));
  });

  it('uses test recipients in test mode', async () => {
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST = 'test@example.com';
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    await sendNewTransactionNotification(makePaymentData({ isLiveMode: false }), 'first_time');
    expect(sgMail.send).toHaveBeenCalledWith(expect.objectContaining({ to: ['test@example.com'] }));
  });

  it('includes subscription ID in email for recurring type', async () => {
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST = 'admin@example.com';
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    await sendNewTransactionNotification(
      makePaymentData({ subscriptionId: 'sub_abc123' }),
      'new_recurring'
    );
    const callArg = sgMail.send.mock.calls[0][0];
    expect(callArg.html).toContain('sub_abc123');
  });

  it('returns failed status when sgMail.send throws', async () => {
    process.env.NEW_TRANSACTION_NOTIFICATION_EMAILS_TEST = 'admin@example.com';
    sendNewTransactionNotification = reloadSendNewTransactionNotification();
    vi.spyOn(sgMail, 'send').mockRejectedValueOnce(new Error('Network error'));
    const result = await sendNewTransactionNotification(makePaymentData(), 'first_time');
    expect(result.status).toBe('failed');
  });
});
