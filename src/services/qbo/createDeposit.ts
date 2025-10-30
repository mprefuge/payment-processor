import { logger } from '../../lib/logger';
import axios from 'axios';

type DepositBody = {
  TxnDate: string;
  DepositToAccountRef: { value: string };
  Line: Array<{
    Amount: string;
    DetailType: "DepositLineDetail";
    DepositLineDetail: {
      AccountRef?: { value: string }; // Optional - only for non-linked deposits
    };
    LinkedTxn?: Array<{ TxnId: string; TxnType: "SalesReceipt" }>;
    Description?: string;
  }>;
};

type CreateDepositParams = {
  realmId: string;
  accessToken: string;
  bankId: string;          // "214" - The bank account to deposit TO
  salesReceiptId: string;  // "1822"
  amountDollars: number;   // e.g., 15000.00 for $15,000
  txnDateISO: string;      // "2025-10-30"
  env?: "prod" | "sandbox";
};

export async function createQboDeposit({
  realmId,
  accessToken,
  bankId,
  salesReceiptId,
  amountDollars,
  txnDateISO,
  env = "sandbox", // "prod" or "sandbox"
}: CreateDepositParams) {

  const base =
    env === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

  const url = `${base}/v3/company/${realmId}/deposit?minorversion=75`;

  // Build OBJECT
  // When linking to a sales receipt, we should NOT include AccountRef in DepositLineDetail
  // The account information comes from the linked transaction itself
  const payload: DepositBody = {
    TxnDate: txnDateISO,
    DepositToAccountRef: { value: String(bankId) },
    Line: [
      {
        Amount: amountDollars.toFixed(2),
        DetailType: "DepositLineDetail",
        DepositLineDetail: {},  // Empty object when using LinkedTxn
        LinkedTxn: [{ TxnId: String(salesReceiptId), TxnType: "SalesReceipt" }],
      },
    ],
  };

  // 🔒 HARD GUARD: if someone passed a string earlier, convert it back to object once
  const bodyToSend: DepositBody =
    typeof (payload as any) === "string"
      ? JSON.parse(payload as unknown as string)
      : payload;

  // LOGGING: preview safely, but DO NOT send the preview string
  logger.info("[createQboDeposit] Payload preview:", {
    preview: JSON.stringify(bodyToSend),
    typeofBody: typeof bodyToSend, // should be "object"
  });

  // 3) Add a runtime assertion to fail fast if it's still a string
  if (typeof (bodyToSend as any) === "string" && (bodyToSend as unknown as string).trim().startsWith("{")) {
    throw new Error("BUG: payload is a JSON string. Pass an object to axios.post, not a pre-stringified string.");
  }

  const res = await axios.post(url, bodyToSend, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // Ensure no custom transformRequest re-stringifies strings
    transformRequest: [
      (data, headers) => {
        if (typeof data === "string") {
          // If someone upstream handed us a string, try to parse once
          try { data = JSON.parse(data); } catch { /* leave as-is */ }
        }
        return JSON.stringify(data);
      },
    ],
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(`QBO deposit failed ${res.status}: ${typeof res.data === "string" ? res.data : JSON.stringify(res.data)}`);
  }

  return res.data;
}
