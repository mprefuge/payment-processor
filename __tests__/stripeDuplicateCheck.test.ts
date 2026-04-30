import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext, createHttpRequest } = require('./testUtils');

// Helper that creates an HttpRequest with URLSearchParams populated from the given object
const createRequest = (queryParams: Record<string, string> = {}): any => {
  const req = createHttpRequest({ method: 'GET', params: {} });
  for (const [key, value] of Object.entries(queryParams)) {
    req.query.set(key, value);
  }
  return req;
};

const makeQboDoc = (
  id: string,
  syncToken: string,
  docNumber: string,
  txnDate: string,
  createTime: string,
  privateNote?: string
) => ({
  Id: id,
  SyncToken: syncToken,
  DocNumber: docNumber,
  TxnDate: txnDate,
  MetaData: { CreateTime: createTime },
  PrivateNote: privateNote,
});

const makeQueryResponse = (_entityName: string, docs: unknown[]) => docs;

describe('stripeDuplicateCheck', () => {
  let handler: any;
  let mockQboQuery: any;
  let mockDeleteQboDoc: any;
  let mockSalesforceService: any;
  let mockSfConnection: any;

  beforeEach(async () => {
    vi.resetModules();

    // Mock qboSvc
    vi.doMock('../src/services/qboSvc', () => ({
      query: vi.fn(),
      deleteQuickBooksDocument: vi.fn(),
    }));

    // Build a reusable Salesforce connection mock
    mockSfConnection = {
      query: vi.fn().mockResolvedValue({ records: [] }),
      sobject: vi.fn().mockReturnValue({ destroy: vi.fn().mockResolvedValue([]) }),
    };

    // Mock salesforceService
    vi.doMock('../src/services/salesforceService', () => ({
      buildSalesforceConfig: vi.fn().mockReturnValue({}),
      SalesforceService: vi.fn().mockImplementation(() => ({
        authenticate: vi.fn().mockResolvedValue(mockSfConnection),
      })),
      parseBoolean: (value: unknown, defaultValue: boolean) => {
        if (value === null || value === undefined) return defaultValue;
        if (typeof value === 'boolean') return value;
        const s = String(value).toLowerCase().trim();
        if (['true', '1', 'yes', 'on'].includes(s)) return true;
        if (['false', '0', 'no', 'off'].includes(s)) return false;
        return defaultValue;
      },
      escapeSoqlLiteral: (v: string) => v.replace(/'/g, "\\'"),
      toRecords: (result: any) => result?.records ?? [],
      chunkArray: (arr: unknown[], size: number) => {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
        return chunks;
      },
    }));

    const qboSvc = await import('../src/services/qboSvc');
    mockQboQuery = qboSvc.query;
    mockDeleteQboDoc = qboSvc.deleteQuickBooksDocument;

    // Default: return empty result sets for each entity query
    mockQboQuery.mockResolvedValue([]);

    const mod = await import('../src/handlers/stripeDuplicateCheck');
    handler = (mod as any).default ?? mod;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── QBO DUPLICATE DETECTION ────────────────────────────────────────────

  describe('QBO duplicate detection', () => {
    it('returns no duplicates when each Stripe key is unique', async () => {
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc('1', '0', 'CHG-20240101-abc111', '2024-01-01', '2024-01-01T10:00:00Z'),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(0);
      expect(result.jsonBody.qbo.checked).toBe(1);
    });

    it('detects duplicate SalesReceipts sharing the same Stripe charge ID', async () => {
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc(
              '1',
              '0',
              'CHG-20240101-abc123',
              '2024-01-01',
              '2024-01-01T10:00:00Z',
              'Stripe charge ch_abc123'
            ),
            makeQboDoc(
              '2',
              '1',
              'CHG-20240101-abc123',
              '2024-01-01',
              '2024-01-01T10:30:00Z',
              'Stripe charge ch_abc123'
            ),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(1);
      expect(result.jsonBody.qbo.duplicateGroups[0].key).toBe('sales-receipt:ch_abc123');
      expect(result.jsonBody.qbo.duplicateGroups[0].records).toHaveLength(2);
    });

    it('does NOT flag a SalesReceipt + JournalEntry for the same Stripe charge (expected accounting pair)', async () => {
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc(
              '1',
              '0',
              'CHG-20240101-abc123',
              '2024-01-01',
              '2024-01-01T09:00:00Z',
              'Stripe charge ch_abc123'
            ),
          ])
        )
        .mockResolvedValueOnce(
          makeQueryResponse('JournalEntry', [
            makeQboDoc(
              '2',
              '0',
              'CHGJE-20240101-abc123',
              '2024-01-01',
              '2024-01-01T09:30:00Z',
              'Stripe charge ch_abc123'
            ),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      // sales-receipt:ch_abc123 has 1 record, journal-entry:ch_abc123 has 1 record — neither is a duplicate
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(0);
    });

    it('detects when the same Stripe charge created two SalesReceipts AND two JournalEntries', async () => {
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc(
              '1',
              '0',
              'CHG-20240101-abc123',
              '2024-01-01',
              '2024-01-01T09:00:00Z',
              'Stripe charge ch_abc123'
            ),
            makeQboDoc(
              '2',
              '1',
              'CHG-20240101-abc123',
              '2024-01-01',
              '2024-01-01T09:05:00Z',
              'Stripe charge ch_abc123'
            ),
          ])
        )
        .mockResolvedValueOnce(
          makeQueryResponse('JournalEntry', [
            makeQboDoc(
              '3',
              '0',
              'CHGJE-20240101-abc123',
              '2024-01-01',
              '2024-01-01T09:01:00Z',
              'Stripe charge ch_abc123 fee JE'
            ),
            makeQboDoc(
              '4',
              '1',
              'CHGJE-20240101-abc123',
              '2024-01-01',
              '2024-01-01T09:06:00Z',
              'Stripe charge ch_abc123 fee JE'
            ),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(2);
      const keys = result.jsonBody.qbo.duplicateGroups.map((g: any) => g.key);
      expect(keys).toContain('sales-receipt:ch_abc123');
      expect(keys).toContain('journal-entry:ch_abc123');
    });

    it('detects duplicate payout deposits with Stripe payout ID in PrivateNote (different DocNumber formats)', async () => {
      // Simulates the real-world case: two bank deposits for the same payout created by
      // different code paths — one uses PO-{date}-{suffix} DocNumber, the other uses
      // legacy payout_{id} format. Both have the full payout ID in their memo.
      mockQboQuery
        .mockResolvedValueOnce(makeQueryResponse('SalesReceipt', []))
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(
          makeQueryResponse('Deposit', [
            makeQboDoc(
              'd1',
              '0',
              'PO-20260328-1TRLq7BJf9Y',
              '2026-03-28',
              '2026-03-28T14:00:00Z',
              'Stripe payout po_1TRLq7BJf9YYVP9mQUE64LZg'
            ),
            makeQboDoc(
              'd2',
              '0',
              'payout_po_1TRLq7BJf9Y',
              '2026-03-28',
              '2026-03-28T14:01:00Z',
              'Stripe PayoutID: po_1TRLq7BJf9YYVP9mQUE64LZg Initiated a payout'
            ),
          ])
        );

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(1);
      expect(result.jsonBody.qbo.duplicateGroups[0].key).toBe(
        'bank-deposit:po_1TRLq7BJf9YYVP9mQUE64LZg'
      );
      expect(result.jsonBody.qbo.duplicateGroups[0].records).toHaveLength(2);
    });

    it('detects duplicate payout deposits when legacy PrivateNote contains payout_po_ prefix', async () => {
      // payoutSyncTrigger.js stores memo as `payout_${payout.id}` (e.g. "payout_po_1TRLq7...").
      // The underscore immediately before "po_" means \b would not match — only a plain
      // prefix-agnostic regex catches it.
      mockQboQuery
        .mockResolvedValueOnce(makeQueryResponse('SalesReceipt', []))
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(
          makeQueryResponse('Deposit', [
            makeQboDoc(
              'd1',
              '0',
              'PO-20260328-1TRLq7BJf9Y',
              '2026-03-28',
              '2026-03-28T14:00:00Z',
              'Stripe payout po_1TRLq7BJf9YYVP9mB0NuhrM7'
            ),
            makeQboDoc(
              'd2',
              '0',
              'payout_po_1TRLq7BJf9Y',
              '2026-03-28',
              '2026-03-28T14:01:00Z',
              'payout_po_1TRLq7BJf9YYVP9mB0NuhrM7'
            ),
          ])
        );

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(1);
      expect(result.jsonBody.qbo.duplicateGroups[0].key).toBe(
        'bank-deposit:po_1TRLq7BJf9YYVP9mB0NuhrM7'
      );
      expect(result.jsonBody.qbo.duplicateGroups[0].records).toHaveLength(2);
    });

    it('detects duplicate bank-deposits when payout ID is only in Line[].Description (bank-feed entry)', async () => {
      // Bulk SELECT order: SalesReceipt, JournalEntry, Deposit, Transfer
      // Deposit has two records with null PrivateNote -> triggers secondary individual fetches
      mockQboQuery
        .mockResolvedValueOnce([]) // SalesReceipt page 1
        .mockResolvedValueOnce([]) // JournalEntry page 1
        .mockResolvedValueOnce([  // Deposit page 1
          { Id: 'd10', SyncToken: '0', DocNumber: null, TxnDate: '2026-03-28', MetaData: { CreateTime: '2026-03-28T10:00:00Z' }, PrivateNote: null },
          { Id: 'd11', SyncToken: '0', DocNumber: null, TxnDate: '2026-03-28', MetaData: { CreateTime: '2026-03-28T11:00:00Z' }, PrivateNote: null },
        ])
        .mockResolvedValueOnce([]) // Transfer page 1
        // Individual full fetches for d10 and d11
        .mockResolvedValueOnce([{
          Id: 'd10', SyncToken: '0', PrivateNote: null,
          Line: [{ Description: 'Stripe PayoutID: po_1TRLq7BJf9YYVP9mB0NuhrM7 Initiated automatic payout' }],
        }])
        .mockResolvedValueOnce([{
          Id: 'd11', SyncToken: '0', PrivateNote: null,
          Line: [{ Description: 'Stripe PayoutID: po_1TRLq7BJf9YYVP9mB0NuhrM7 Initiated automatic payout' }],
        }]);

      const { context } = createContext();
      const req = createRequest({ system: 'qbo', fetchLineDescriptions: 'true' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(1);
      expect(result.jsonBody.qbo.duplicateGroups[0].key).toBe(
        'bank-deposit:po_1TRLq7BJf9YYVP9mB0NuhrM7'
      );
      expect(result.jsonBody.qbo.duplicateGroups[0].records).toHaveLength(2);
    });

    it('detects duplicate payout entries when second entry is a Transfer entity (bank-feed auto-categorized)', async () => {
      mockQboQuery
        .mockResolvedValueOnce([]) // SalesReceipt
        .mockResolvedValueOnce([]) // JournalEntry
        .mockResolvedValueOnce([   // Deposit - canonical payout entry
          makeQboDoc('d1', '0', null, '2026-03-28', '2026-03-28T10:00:00Z', 'Stripe payout po_1TRLq7BJf9YYVP9mB0NuhrM7'),
        ])
        .mockResolvedValueOnce([   // Transfer - bank-feed auto-entry
          { Id: 't1', SyncToken: '0', DocNumber: null, TxnDate: '2026-04-02', MetaData: { CreateTime: '2026-04-02T10:00:00Z' }, PrivateNote: 'Stripe PayoutID: po_1TRLq7BJf9YYVP9mB0NuhrM7 Initiated automatic payout' },
        ]);

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      const group = result.jsonBody.qbo.duplicateGroups.find(
        (g: any) => g.key === 'bank-deposit:po_1TRLq7BJf9YYVP9mB0NuhrM7'
      );
      expect(group).toBeDefined();
      expect(group.records).toHaveLength(2);
    });

    it('ignores REF and DSP DocNumbers (no Stripe ID in suffix)', async () => {
      mockQboQuery
        .mockResolvedValueOnce(makeQueryResponse('SalesReceipt', []))
        .mockResolvedValueOnce(
          makeQueryResponse('JournalEntry', [
            makeQboDoc('1', '0', 'REF-20240101-12345', '2024-01-01', '2024-01-01T10:00:00Z'),
            makeQboDoc('2', '0', 'REF-20240101-12345', '2024-01-01', '2024-01-01T11:00:00Z'),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      // REF docs don't contain Stripe IDs so they are skipped in grouping
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(0);
    });

    it('does NOT flag multiple receipts sharing a subscription ID (expected recurring behaviour)', async () => {
      // A sub_ ID appears on every receipt for a recurring subscription — each is a
      // legitimate separate transaction so they must never be treated as duplicates.
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc(
              '1',
              '0',
              'CHG-20240101-abc',
              '2024-01-01',
              '2024-01-01T10:00:00Z',
              'Stripe charge ch_jan sub_recurring123'
            ),
            makeQboDoc(
              '2',
              '0',
              'CHG-20240201-abc',
              '2024-02-01',
              '2024-02-01T10:00:00Z',
              'Stripe charge ch_feb sub_recurring123'
            ),
            makeQboDoc(
              '3',
              '0',
              'CHG-20240301-abc',
              '2024-03-01',
              '2024-03-01T10:00:00Z',
              'Stripe charge ch_mar sub_recurring123'
            ),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      // Each receipt has a unique ch_ ID — no duplicates despite sharing sub_ ID
      expect(result.jsonBody.qbo.duplicateGroups).toHaveLength(0);
    });

    it('applies date range to QBO queries', async () => {
      mockQboQuery.mockResolvedValue([]);

      const { context } = createContext();
      const req = createRequest({ system: 'qbo', startDate: '2024-01-01', endDate: '2024-03-31' });

      await handler(req, context);

      // Each QBO entity query should include TxnDate constraints
      const firstCall = mockQboQuery.mock.calls[0][0] as string;
      expect(firstCall).toContain("TxnDate >= '2024-01-01'");
      expect(firstCall).toContain("TxnDate <= '2024-03-31'");
    });
  });

  // ─── QBO DELETION ───────────────────────────────────────────────────────

  describe('QBO deletion', () => {
    it('does NOT delete duplicates when dryRun=true (default)', async () => {
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc('1', '0', 'CHG-20240101-abc123', '2024-01-01', '2024-01-01T10:00:00Z'),
            makeQboDoc('2', '1', 'CHG-20240101-abc123', '2024-01-01', '2024-01-01T10:30:00Z'),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo', deleteDuplicates: 'true', dryRun: 'true' });

      await handler(req, context);
      expect(mockDeleteQboDoc).not.toHaveBeenCalled();
    });

    it('deletes all but the oldest duplicate when deleteDuplicates=true dryRun=false', async () => {
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc('1', '0', 'CHG-20240101-abc123', '2024-01-01', '2024-01-01T08:00:00Z'),
            makeQboDoc('2', '1', 'CHG-20240101-abc123', '2024-01-01', '2024-01-01T09:00:00Z'),
            makeQboDoc('3', '2', 'CHG-20240101-abc123', '2024-01-01', '2024-01-01T10:00:00Z'),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      mockDeleteQboDoc.mockResolvedValue(undefined);

      const { context } = createContext();
      const req = createRequest({ system: 'qbo', deleteDuplicates: 'true', dryRun: 'false' });

      const result = await handler(req, context);
      // Oldest (id=1) is kept; id=2 and id=3 are deleted
      expect(mockDeleteQboDoc).toHaveBeenCalledTimes(2);
      expect(result.jsonBody.qbo.deleted).toBe(2);

      const deletedIds = mockDeleteQboDoc.mock.calls.map((c: any[]) => c[0].id);
      expect(deletedIds).toContain('2');
      expect(deletedIds).toContain('3');
      expect(deletedIds).not.toContain('1');
    });

    it('reports delete errors without throwing', async () => {
      mockQboQuery
        .mockResolvedValueOnce(
          makeQueryResponse('SalesReceipt', [
            makeQboDoc('1', '0', 'CHG-20240101-abc123', '2024-01-01', '2024-01-01T08:00:00Z'),
            makeQboDoc('2', '1', 'CHG-20240101-abc123', '2024-01-01', '2024-01-01T10:00:00Z'),
          ])
        )
        .mockResolvedValueOnce(makeQueryResponse('JournalEntry', []))
        .mockResolvedValueOnce(makeQueryResponse('Deposit', []));

      mockDeleteQboDoc.mockRejectedValue(new Error('QBO delete failed'));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo', deleteDuplicates: 'true', dryRun: 'false' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      expect(result.jsonBody.qbo.errors).toHaveLength(1);
      expect(result.jsonBody.qbo.deleted).toBe(0);
    });
  });

  // ─── SALESFORCE DUPLICATE DETECTION ─────────────────────────────────────

  describe('Salesforce duplicate detection', () => {
    it('returns no duplicates when each Stripe ID is unique', async () => {
      mockSfConnection.query.mockResolvedValue({
        records: [
          { Id: 'sf1', CreatedDate: '2024-01-01T10:00:00.000Z', Stripe_Charge_Id__c: 'ch_aaa' },
          { Id: 'sf2', CreatedDate: '2024-01-02T10:00:00.000Z', Stripe_Charge_Id__c: 'ch_bbb' },
        ],
      });

      const { context } = createContext();
      const req = createRequest({ system: 'salesforce' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      expect(result.jsonBody.salesforce.duplicateGroups).toHaveLength(0);
      expect(result.jsonBody.salesforce.checked).toBe(2);
    });

    it('detects duplicate Transaction__c records sharing Stripe_Charge_Id__c', async () => {
      mockSfConnection.query.mockResolvedValue({
        records: [
          {
            Id: 'sf1',
            CreatedDate: '2024-01-01T08:00:00.000Z',
            Stripe_Charge_Id__c: 'ch_duplicate',
          },
          {
            Id: 'sf2',
            CreatedDate: '2024-01-01T09:00:00.000Z',
            Stripe_Charge_Id__c: 'ch_duplicate',
          },
        ],
      });

      const { context } = createContext();
      const req = createRequest({ system: 'salesforce' });

      const result = await handler(req, context);
      expect(result.jsonBody.salesforce.duplicateGroups).toHaveLength(1);
      expect(result.jsonBody.salesforce.duplicateGroups[0].key).toBe(
        'Stripe_Charge_Id__c:ch_duplicate'
      );
    });

    it('detects duplicates across different Stripe ID fields on different records', async () => {
      mockSfConnection.query.mockResolvedValue({
        records: [
          {
            Id: 'sf1',
            CreatedDate: '2024-01-01T08:00:00.000Z',
            Stripe_Payment_Intent_Id__c: 'pi_xyz',
          },
          {
            Id: 'sf2',
            CreatedDate: '2024-01-01T09:00:00.000Z',
            Stripe_Payment_Intent_Id__c: 'pi_xyz',
          },
        ],
      });

      const { context } = createContext();
      const req = createRequest({ system: 'salesforce' });

      const result = await handler(req, context);
      expect(result.jsonBody.salesforce.duplicateGroups).toHaveLength(1);
    });

    it('applies date range to Salesforce query', async () => {
      mockSfConnection.query.mockResolvedValue({ records: [] });

      const { context } = createContext();
      const req = createRequest({
        system: 'salesforce',
        startDate: '2024-01-01',
        endDate: '2024-03-31',
      });

      await handler(req, context);

      const soql = mockSfConnection.query.mock.calls[0][0] as string;
      expect(soql).toContain('CreatedDate >= 2024-01-01T00:00:00Z');
      expect(soql).toContain('CreatedDate <= 2024-03-31T23:59:59Z');
    });
  });

  // ─── SALESFORCE DELETION ─────────────────────────────────────────────────

  describe('Salesforce deletion', () => {
    it('does NOT delete when dryRun=true', async () => {
      mockSfConnection.query.mockResolvedValue({
        records: [
          {
            Id: 'sf1',
            CreatedDate: '2024-01-01T08:00:00.000Z',
            Stripe_Charge_Id__c: 'ch_dup',
          },
          {
            Id: 'sf2',
            CreatedDate: '2024-01-01T10:00:00.000Z',
            Stripe_Charge_Id__c: 'ch_dup',
          },
        ],
      });

      const { context } = createContext();
      const req = createRequest({ system: 'salesforce', deleteDuplicates: 'true', dryRun: 'true' });

      await handler(req, context);
      const destroyFn = mockSfConnection.sobject('Transaction__c').destroy;
      expect(destroyFn).not.toHaveBeenCalled();
    });

    it('deletes duplicate records keeping the oldest when deleteDuplicates=true dryRun=false', async () => {
      mockSfConnection.query.mockResolvedValue({
        records: [
          {
            Id: 'sf1',
            CreatedDate: '2024-01-01T08:00:00.000Z',
            Stripe_Charge_Id__c: 'ch_dup',
          },
          {
            Id: 'sf2',
            CreatedDate: '2024-01-01T10:00:00.000Z',
            Stripe_Charge_Id__c: 'ch_dup',
          },
        ],
      });

      const mockDestroy = vi.fn().mockResolvedValue([{ success: true }]);
      mockSfConnection.sobject = vi.fn().mockReturnValue({ destroy: mockDestroy });

      const { context } = createContext();
      const req = createRequest({
        system: 'salesforce',
        deleteDuplicates: 'true',
        dryRun: 'false',
      });

      const result = await handler(req, context);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
      const idsArg = mockDestroy.mock.calls[0][0] as string[];
      expect(idsArg).toContain('sf2');
      expect(idsArg).not.toContain('sf1');
      expect(result.jsonBody.salesforce.deleted).toBe(1);
    });
  });

  // ─── COMBINED MODE ───────────────────────────────────────────────────────

  describe('combined mode (system=both)', () => {
    it('returns qbo and salesforce results when system=both', async () => {
      mockQboQuery.mockResolvedValue({ QueryResponse: {} });
      mockSfConnection.query.mockResolvedValue({ records: [] });

      const { context } = createContext();
      const req = createRequest({ system: 'both' });

      const result = await handler(req, context);
      expect(result.status).toBe(200);
      expect(result.jsonBody).toHaveProperty('qbo');
      expect(result.jsonBody).toHaveProperty('salesforce');
    });

    it('defaults to system=both when system param is omitted', async () => {
      mockQboQuery.mockResolvedValue({ QueryResponse: {} });
      mockSfConnection.query.mockResolvedValue({ records: [] });

      const { context } = createContext();
      const req = createRequest();

      const result = await handler(req, context);
      expect(result.jsonBody).toHaveProperty('qbo');
      expect(result.jsonBody).toHaveProperty('salesforce');
    });

    it('returns only qbo when system=qbo', async () => {
      mockQboQuery.mockResolvedValue({ QueryResponse: {} });

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.jsonBody).toHaveProperty('qbo');
      expect(result.jsonBody).not.toHaveProperty('salesforce');
    });

    it('returns only salesforce when system=salesforce', async () => {
      mockSfConnection.query.mockResolvedValue({ records: [] });

      const { context } = createContext();
      const req = createRequest({ system: 'salesforce' });

      const result = await handler(req, context);
      expect(result.jsonBody).not.toHaveProperty('qbo');
      expect(result.jsonBody).toHaveProperty('salesforce');
    });
  });

  // ─── RESPONSE SHAPE ──────────────────────────────────────────────────────

  describe('response shape', () => {
    it('includes dateRange in the response', async () => {
      mockQboQuery.mockResolvedValue({ QueryResponse: {} });
      mockSfConnection.query.mockResolvedValue({ records: [] });

      const { context } = createContext();
      const req = createRequest({ startDate: '2024-01-01', endDate: '2024-06-30' });

      const result = await handler(req, context);
      expect(result.jsonBody.dateRange).toEqual({
        startDate: '2024-01-01',
        endDate: '2024-06-30',
      });
    });

    it('reports dryRun and deleteDuplicates flags in the response', async () => {
      mockQboQuery.mockResolvedValue({ QueryResponse: {} });

      const { context } = createContext();
      const req = createRequest({ system: 'qbo', dryRun: 'false', deleteDuplicates: 'true' });

      const result = await handler(req, context);
      expect(result.jsonBody.dryRun).toBe(false);
      expect(result.jsonBody.deleteDuplicates).toBe(true);
    });
  });

  // ─── ERROR HANDLING ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 500 when QBO query throws', async () => {
      mockQboQuery.mockRejectedValue(new Error('QBO unreachable'));

      const { context } = createContext();
      const req = createRequest({ system: 'qbo' });

      const result = await handler(req, context);
      expect(result.status).toBe(500);
      expect(result.jsonBody.error).toBe('internal_error');
    });

    it('returns 500 when Salesforce authenticate throws', async () => {
      const { SalesforceService } = await import('../src/services/salesforceService');
      (SalesforceService as any).mockImplementation(() => ({
        authenticate: vi.fn().mockRejectedValue(new Error('SF auth failed')),
      }));

      const { context } = createContext();
      const req = createRequest({ system: 'salesforce' });

      const result = await handler(req, context);
      expect(result.status).toBe(500);
    });
  });
});
