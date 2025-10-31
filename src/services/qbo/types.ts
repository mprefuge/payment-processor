export const QBO_BASE_URL: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
  production: 'https://quickbooks.api.intuit.com/v3/company',
};

export const DOC_NUMBER_MAX_LENGTH = 21;

export type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

export type Fetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

export interface QuickBooksReference {
  value: string;
  name?: string;
}

export type AccountRefLookupMetadata = {
  original: string;
  lookupName: string;
  resolved: boolean;
};

export const ACCOUNT_LOOKUP_METADATA: unique symbol = Symbol('QuickBooksAccountLookup');

export type AccountRefWithMetadata = QuickBooksReference & {
  [ACCOUNT_LOOKUP_METADATA]?: AccountRefLookupMetadata;
};

export type ItemRefLookupMetadata = {
  original: string;
  lookupName: string;
  resolved: boolean;
};

export const ITEM_LOOKUP_METADATA: unique symbol = Symbol('QuickBooksItemLookup');

export type ItemRefWithMetadata = QuickBooksReference & {
  [ITEM_LOOKUP_METADATA]?: ItemRefLookupMetadata;
};

export interface QuickBooksEmailAddress {
  Address: string;
}

export interface QuickBooksPhysicalAddress {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

export interface QuickBooksSalesItemLineDetail {
  ItemRef: QuickBooksReference;
  ItemAccountRef?: QuickBooksReference;
  TaxCodeRef?: QuickBooksReference;
}

export interface QuickBooksSalesReceiptLine {
  Amount: number;
  DetailType: 'SalesItemLineDetail';
  Description?: string;
  SalesItemLineDetail: QuickBooksSalesItemLineDetail;
}

export interface QuickBooksSalesReceipt {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  DepositToAccountRef: QuickBooksReference;
  CustomerRef?: QuickBooksReference;
  BillEmail?: QuickBooksEmailAddress;
  BillAddr?: QuickBooksPhysicalAddress;
  ShipAddr?: QuickBooksPhysicalAddress;
  Line: QuickBooksSalesReceiptLine[];
}

export interface QuickBooksJournalEntryLineDetail {
  PostingType: 'Debit' | 'Credit';
  AccountRef: QuickBooksReference;
}

export interface QuickBooksJournalEntryLine {
  Amount: number;
  DetailType: 'JournalEntryLineDetail';
  Description?: string;
  JournalEntryLineDetail: QuickBooksJournalEntryLineDetail;
}

export interface QuickBooksJournalEntry {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  Line: QuickBooksJournalEntryLine[];
}

export interface QuickBooksBankDepositLine {
  Amount: number;
  DetailType: 'DepositLineDetail';
  Description?: string;
  DepositLineDetail: {
    AccountRef: QuickBooksReference;
    ClassRef?: QuickBooksReference;
    TaxCodeRef?: QuickBooksReference;
  };
  LinkedTxn?: Array<{
    TxnId: string;
    TxnType:
      | 'SalesReceipt'
      | 'Invoice'
      | 'Payment'
      | 'JournalEntry'
      | 'Transfer'
      | 'Deposit'
      | 'Check'
      | 'Expense'
      | 'CreditCardCharge'
      | 'Charge';
  }>;
}

export interface QuickBooksBankDeposit {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  DepositToAccountRef: QuickBooksReference;
  Line: QuickBooksBankDepositLine[];
}

export interface PostOptions {
  idempotencyKey?: string;
  requestId?: string;
}

export interface PostResult {
  id: string;
  type: QuickBooksDocType;
}

export interface PostChargeToQboInput {
  gross: number;
  fee: number;
  memo?: string;
  date: Date;
  stripe?: {
    checkoutSession?: {
      metadata?: Record<string, string | undefined>;
    };
    customer?: {
      email?: string;
      name?: string;
      address?: {
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postal_code?: string;
        country?: string;
      };
    };
    payment_method_details?: {
      card?: {
        brand?: string;
        last4?: string;
      };
    };
  };
  options?: PostOptions;
}

export type PostChargeToQboResult = PostResult;

export interface PostRefundToQboInput {
  amount: number;
  memo?: string;
  date: Date;
  options?: PostOptions;
}

export interface PostDisputeToQboInput {
  lossAmount: number;
  feeAmount: number;
  memo?: string;
  date: Date;
  options?: PostOptions;
}

export interface PostPayoutToQboInput {
  amount: number;
  memo?: string;
  date: Date;
  options?: PostOptions;
}
