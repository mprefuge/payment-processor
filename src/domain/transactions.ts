export interface TransactionMetadata {
  payoutId?: string | null;
  customerId?: string | null;
  description?: string | null;
  category?: string | null;
  livemode?: boolean;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface TransactionRecord {
  id: string;
  amount: number;
  currency: string;
  status: string;
  metadata: TransactionMetadata;
}

export interface PayoutSummary {
  payoutId: string;
  gross: number;
  net: number;
  feeTotal: number;
  currency: string;
  transactionCount: number;
}
