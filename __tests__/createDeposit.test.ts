import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const axiosPost = vi.mocked(axios.post);

// Import after mocking
import { createQboDeposit } from '../src/services/qbo/createDeposit';

describe('createQboDeposit', () => {
  const baseParams = {
    realmId: 'realm_123',
    accessToken: 'Bearer tok_abc',
    bankId: '214',
    salesReceiptId: '1822',
    amountDollars: 150.0,
    txnDateISO: '2025-10-30',
  };

  beforeEach(() => {
    axiosPost.mockResolvedValue({ status: 200, data: { Deposit: { Id: 'dep_1' } } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('payload construction', () => {
    it('sends the amount as-is (dollars), not divided by 100', async () => {
      await createQboDeposit(baseParams);

      const [, body] = axiosPost.mock.calls[0];
      expect((body as any).Line[0].Amount).toBe('150.00');
    });

    it('formats amount with 2 decimal places', async () => {
      await createQboDeposit({ ...baseParams, amountDollars: 25 });

      const [, body] = axiosPost.mock.calls[0];
      expect((body as any).Line[0].Amount).toBe('25.00');
    });

    it('sends the correct TxnDate', async () => {
      await createQboDeposit(baseParams);

      const [, body] = axiosPost.mock.calls[0];
      expect((body as any).TxnDate).toBe('2025-10-30');
    });

    it('links to the correct salesReceiptId', async () => {
      await createQboDeposit(baseParams);

      const [, body] = axiosPost.mock.calls[0];
      expect((body as any).Line[0].DepositLineDetail.LinkedTxn[0].TxnId).toBe('1822');
      expect((body as any).Line[0].DepositLineDetail.LinkedTxn[0].TxnType).toBe('SalesReceipt');
    });

    it('sets DepositToAccountRef.value to bankId', async () => {
      await createQboDeposit(baseParams);

      const [, body] = axiosPost.mock.calls[0];
      expect((body as any).DepositToAccountRef.value).toBe('214');
    });
  });

  describe('URL selection', () => {
    it('uses sandbox URL by default', async () => {
      await createQboDeposit(baseParams);

      const [url] = axiosPost.mock.calls[0];
      expect(url).toContain('sandbox-quickbooks.api.intuit.com');
    });

    it('uses production URL when env="prod"', async () => {
      await createQboDeposit({ ...baseParams, env: 'prod' });

      const [url] = axiosPost.mock.calls[0];
      expect(url).toContain('quickbooks.api.intuit.com');
      expect(url).not.toContain('sandbox');
    });

    it('includes the company realmId in the URL', async () => {
      await createQboDeposit(baseParams);

      const [url] = axiosPost.mock.calls[0];
      expect(url).toContain('/realm_123/');
    });
  });

  describe('headers', () => {
    it('sends Authorization header with accessToken', async () => {
      await createQboDeposit(baseParams);

      const [, , config] = axiosPost.mock.calls[0];
      expect((config as any).headers.Authorization).toContain('tok_abc');
    });

    it('sends Content-Type: application/json', async () => {
      await createQboDeposit(baseParams);

      const [, , config] = axiosPost.mock.calls[0];
      expect((config as any).headers['Content-Type']).toBe('application/json');
    });
  });

  describe('error handling', () => {
    it('throws on HTTP 400 response', async () => {
      axiosPost.mockResolvedValue({ status: 400, data: 'Bad request' });

      await expect(createQboDeposit(baseParams)).rejects.toThrow('400');
    });

    it('throws on HTTP 500 response', async () => {
      axiosPost.mockResolvedValue({
        status: 500,
        data: { Fault: { Error: [{ Message: 'Server error' }] } },
      });

      await expect(createQboDeposit(baseParams)).rejects.toThrow('500');
    });

    it('returns data on HTTP 200', async () => {
      const mockData = { Deposit: { Id: 'dep_999', TxnDate: '2025-10-30' } };
      axiosPost.mockResolvedValue({ status: 200, data: mockData });

      const result = await createQboDeposit(baseParams);
      expect(result.Deposit.Id).toBe('dep_999');
    });
  });
});
