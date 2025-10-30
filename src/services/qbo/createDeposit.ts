import { logger } from '../../lib/logger';
import tokenManager from './qboTokenManager';
import axios from 'axios';

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
  const environment = process.env.QBO_ENVIRONMENT || 'sandbox';
  const baseUrl =
    environment === 'production'
      ? 'https://quickbooks.api.intuit.com/v3/company'
      : 'https://sandbox-quickbooks.api.intuit.com/v3/company';
  
  const url = `${baseUrl}/${realmId}/deposit?minorversion=75`;

  logger.info("[createQboDeposit] Payload preview:", { preview: JSON.stringify(payload) });

  // Add a guard to catch accidental strings before send
  let bodyToSend: any = payload;
  if (typeof bodyToSend === "string") {
    try { bodyToSend = JSON.parse(bodyToSend); } catch { /* leave as-is */ }
  }

  try {
    const response = await axios.post(
      url,
      bodyToSend, // <-- OBJECT, not a string
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    logger.info('[createQboDeposit] Deposit created successfully', {
      depositId: response.data?.Deposit?.Id,
      status: response.status
    });

    return response.data; // QBO Deposit object
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status || 500;
      const responseData = error.response?.data || error.message;
      const errorMessage = typeof responseData === "string" ? responseData : JSON.stringify(responseData);
      logger.error('[createQboDeposit] QBO deposit failed', {
        status,
        response: errorMessage
      });
      throw new Error(`QBO deposit failed ${status}: ${errorMessage}`);
    } else {
      throw error;
    }
  }
}
