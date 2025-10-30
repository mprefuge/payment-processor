import { logger } from '../../lib/logger';
import tokenManager from './qboTokenManager';

type CreateDepositParams = {
  realmId: string;
  operatingBankId: string; // e.g., "214"
  salesReceiptId: string;  // e.g., "1822"
  amountDollars: number;   // e.g., 150.00 (NOT 15000)
  txnDateISO: string;      // e.g., "2025-10-30"
};

export async function createQboDeposit(params: CreateDepositParams) {
  const {
    realmId,
    operatingBankId,
    salesReceiptId,
    amountDollars,
    txnDateISO,
  } = params;

  // Get a valid access token (will refresh if needed)
  const accessToken = await tokenManager.getValidAccessToken(fetch);

  // MINIMAL, known-good payload
  const payload = {
    TxnDate: txnDateISO,
    DepositToAccountRef: { value: String(operatingBankId) },
    Line: [
      {
        Amount: Number(amountDollars.toFixed(2)), // dollars, not cents
        DetailType: "DepositLineDetail",
        DepositLineDetail: {
          LinkedTxn: [
            { TxnId: String(salesReceiptId), TxnType: "SalesReceipt" }
          ]
        }
      }
    ]
  };

  // IMPORTANT: call JSON.stringify(payload) exactly once with fetch
  const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/deposit?minorversion=75`;

  logger.info('[createQboDeposit] Sending deposit to QuickBooks', {
    url,
    payload: JSON.stringify(payload, null, 2)
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload) // stringify exactly once
  });

  const responseText = await res.text();
  let responseData;
  
  try {
    responseData = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseData = responseText;
  }

  if (res.status >= 400) {
    // Bubble up the raw QBO fault to see the exact reason
    const errorMessage = typeof responseData === "string" ? responseData : JSON.stringify(responseData);
    logger.error('[createQboDeposit] QBO deposit failed', {
      status: res.status,
      response: errorMessage
    });
    throw new Error(`QBO deposit failed ${res.status}: ${errorMessage}`);
  }

  logger.info('[createQboDeposit] Deposit created successfully', {
    depositId: responseData?.Deposit?.Id,
    status: res.status
  });

  return responseData; // QBO Deposit object
}
