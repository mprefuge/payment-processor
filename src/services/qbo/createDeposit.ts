import { logger } from '../../lib/logger';
import axios from 'axios';

type DepositBody = {
  TxnDate: string;
  DepositToAccountRef: { value: string };
  Line: Array<{
    Amount: string;
    DetailType: 'DepositLineDetail';
    DepositLineDetail: {
      LinkedTxn: Array<{ TxnId: string; TxnType?: 'SalesReceipt'; TxnLineId?: string }>;
    };
    Description?: string;
  }>;
};

type CreateDepositParams = {
  realmId: string;
  accessToken: string;
  bankId: string; // "214"
  salesReceiptId: string; // "1822"
  amountDollars: number; // e.g., 150.00 (NOT 15000 for $150)
  txnDateISO: string; // "2025-10-30"
  env?: 'prod' | 'sandbox';
};

/**
 * Look for a bank deposit that already links the given sales receipt, so we
 * never create a second deposit for a receipt that has already been deposited.
 *
 * QBO SQL cannot filter on LinkedTxn, so we scope the query by the deposit's
 * TxnDate (as checkForPayoutMovement does) and match the linked SalesReceipt in
 * memory. A same-request retry reuses the same TxnDate, so an accidental
 * double-post is caught. (A retry that supplies a different TxnDate is not
 * covered by this date-scoped check.)
 */
async function findExistingDepositForSalesReceipt(params: {
  base: string;
  realmId: string;
  accessToken: string;
  salesReceiptId: string;
  txnDateISO: string;
}): Promise<Record<string, any> | null> {
  const { base, realmId, accessToken, salesReceiptId, txnDateISO } = params;

  const queryString = `SELECT * FROM Deposit WHERE TxnDate = '${txnDateISO}'`;
  const url = `${base}/v3/company/${realmId}/query?query=${encodeURIComponent(queryString)}&minorversion=75`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    // Fail closed: if we cannot verify, abort rather than risk a duplicate deposit.
    throw new Error(
      `QBO deposit duplicate check failed ${res.status}: ${
        typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      }`
    );
  }

  const deposits: Array<Record<string, any>> = res.data?.QueryResponse?.Deposit ?? [];
  const match = deposits.find((deposit) =>
    (deposit.Line ?? []).some((line: any) =>
      (line?.DepositLineDetail?.LinkedTxn ?? []).some(
        (txn: any) => String(txn?.TxnId) === String(salesReceiptId)
      )
    )
  );

  return match ?? null;
}

export async function createQboDeposit({
  realmId,
  accessToken,
  bankId,
  salesReceiptId,
  amountDollars,
  txnDateISO,
  env = 'sandbox', // "prod" or "sandbox"
}: CreateDepositParams) {
  const base =
    env === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

  const url = `${base}/v3/company/${realmId}/deposit?minorversion=75`;

  // Build OBJECT
  const payload: DepositBody = {
    TxnDate: txnDateISO,
    DepositToAccountRef: { value: String(bankId) },
    Line: [
      {
        Amount: amountDollars.toFixed(2),
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {
          LinkedTxn: [{ TxnId: String(salesReceiptId), TxnType: 'SalesReceipt', TxnLineId: '0' }],
        },
      },
    ],
  };

  // 🔒 HARD GUARD: if someone passed a string earlier, convert it back to object once
  const bodyToSend: DepositBody =
    typeof (payload as any) === 'string' ? JSON.parse(payload as unknown as string) : payload;

  // LOGGING: preview safely, but DO NOT send the preview string
  logger.info('[createQboDeposit] Payload preview:', {
    preview: JSON.stringify(bodyToSend),
    typeofBody: typeof bodyToSend, // should be "object"
  });

  // 3) Add a runtime assertion to fail fast if it's still a string
  if (
    typeof (bodyToSend as any) === 'string' &&
    (bodyToSend as unknown as string).trim().startsWith('{')
  ) {
    throw new Error(
      'BUG: payload is a JSON string. Pass an object to axios.post, not a pre-stringified string.'
    );
  }

  // Duplicate guard: the manual-sync endpoint can be invoked more than once for
  // the same sales receipt. Never create a second deposit for one that has
  // already been deposited.
  const existingDeposit = await findExistingDepositForSalesReceipt({
    base,
    realmId,
    accessToken,
    salesReceiptId: String(salesReceiptId),
    txnDateISO,
  });
  if (existingDeposit) {
    logger.info('[createQboDeposit] Deposit already exists for sales receipt; skipping duplicate', {
      salesReceiptId,
      existingDepositId: existingDeposit.Id,
    });
    return { Deposit: existingDeposit };
  }

  const res = await axios.post(url, bodyToSend, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    // Ensure no custom transformRequest re-stringifies strings
    transformRequest: [
      (data, headers) => {
        if (typeof data === 'string') {
          // If someone upstream handed us a string, try to parse once
          try {
            data = JSON.parse(data);
          } catch {
            /* leave as-is */
          }
        }
        return JSON.stringify(data);
      },
    ],
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(
      `QBO deposit failed ${res.status}: ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`
    );
  }

  return res.data;
}
