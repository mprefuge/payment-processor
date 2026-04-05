import type { InvocationContext, HttpRequest, HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import {
  postSalesReceipt,
  postJournalEntry,
  postBankDeposit,
  ensureItem,
  ensureCustomer,
  ensureAccount,
  queryReference,
  ensureReference,
  query,
  type QuickBooksSalesReceipt,
  type QuickBooksJournalEntry,
  type QuickBooksBankDeposit,
} from '../services/qboSvc';
import { createQboDeposit } from '../services/qbo/createDeposit';
import tokenManager from '../services/qbo/qboTokenManager';
import { logger } from '../lib/logger';

type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

// Comprehensive schemas for all QuickBooks document types

// Reference schema - can be just a name or a name + value
const QuickBooksReferenceSchema = z
  .object({
    name: z.string().optional(),
    value: z.string().optional(),
  })
  .refine((data) => data.name || data.value, {
    message: 'Either name or value must be provided for a reference',
  });

// Email address schema
const QuickBooksEmailAddressSchema = z.object({
  Address: z.string().email(),
});

// Physical address schema
const QuickBooksPhysicalAddressSchema = z.object({
  Line1: z.string().optional(),
  Line2: z.string().optional(),
  Line3: z.string().optional(),
  Line4: z.string().optional(),
  City: z.string().optional(),
  CountrySubDivisionCode: z.string().optional(), // State/Province
  PostalCode: z.string().optional(),
  Country: z.string().optional(),
});

// Sales Receipt Line Schema
const SalesItemLineDetailSchema = z.object({
  ItemRef: QuickBooksReferenceSchema,
  ItemAccountRef: QuickBooksReferenceSchema.optional(),
  TaxCodeRef: QuickBooksReferenceSchema.optional(),
  Qty: z.number().optional(),
  UnitPrice: z.number().optional(),
  ServiceDate: z.string().optional(),
  ClassRef: QuickBooksReferenceSchema.optional(),
  TaxInclusiveAmt: z.number().optional(),
  DiscountRate: z.number().optional(),
  DiscountAmt: z.number().optional(),
});

const SalesReceiptLineSchema = z.object({
  Id: z.string().optional(),
  LineNum: z.number().optional(),
  Amount: z.number(),
  DetailType: z.literal('SalesItemLineDetail'),
  Description: z.string().optional(),
  SalesItemLineDetail: SalesItemLineDetailSchema,
});

// Sales Receipt Schema - comprehensive fields
const SalesReceiptDataSchema = z.object({
  DocNumber: z.string().optional(),
  TxnDate: z.string().optional(),
  PrivateNote: z.string().optional(),
  CustomerMemo: z
    .object({
      value: z.string(),
    })
    .optional(),
  DepositToAccountRef: QuickBooksReferenceSchema.optional(),
  CustomerRef: QuickBooksReferenceSchema.optional(),
  BillEmail: QuickBooksEmailAddressSchema.optional(),
  BillAddr: QuickBooksPhysicalAddressSchema.optional(),
  ShipAddr: QuickBooksPhysicalAddressSchema.optional(),
  ShipDate: z.string().optional(),
  ShipMethodRef: QuickBooksReferenceSchema.optional(),
  ClassRef: QuickBooksReferenceSchema.optional(),
  SalesTermRef: QuickBooksReferenceSchema.optional(),
  DepartmentRef: QuickBooksReferenceSchema.optional(),
  PaymentMethodRef: QuickBooksReferenceSchema.optional(),
  PaymentRefNum: z.string().optional(),
  CurrencyRef: QuickBooksReferenceSchema.optional(),
  ExchangeRate: z.number().optional(),
  GlobalTaxCalculation: z.enum(['TaxExcluded', 'TaxInclusive', 'NotApplicable']).optional(),
  Line: z.array(SalesReceiptLineSchema),
  TxnTaxDetail: z
    .object({
      TxnTaxCodeRef: QuickBooksReferenceSchema.optional(),
      TotalTax: z.number().optional(),
      TaxLine: z.array(z.any()).optional(),
    })
    .optional(),
  CustomField: z
    .array(
      z.object({
        DefinitionId: z.string(),
        Name: z.string().optional(),
        Type: z.string().optional(),
        StringValue: z.string().optional(),
      })
    )
    .optional(),
});

// Journal Entry Line Schema
const JournalEntryLineDetailSchema = z.object({
  PostingType: z.enum(['Debit', 'Credit']),
  AccountRef: QuickBooksReferenceSchema,
  Entity: z
    .object({
      EntityRef: QuickBooksReferenceSchema,
      Type: z.enum(['Customer', 'Vendor', 'Employee', 'Other']).optional(),
    })
    .optional(),
  ClassRef: QuickBooksReferenceSchema.optional(),
  DepartmentRef: QuickBooksReferenceSchema.optional(),
  TaxCodeRef: QuickBooksReferenceSchema.optional(),
  TaxApplicableOn: z.enum(['Sales', 'Purchase']).optional(),
  TaxAmount: z.number().optional(),
  BillableStatus: z.enum(['Billable', 'NotBillable', 'HasBeenBilled']).optional(),
});

const JournalEntryLineSchema = z.object({
  Id: z.string().optional(),
  LineNum: z.number().optional(),
  Amount: z.number(),
  DetailType: z.literal('JournalEntryLineDetail'),
  Description: z.string().optional(),
  JournalEntryLineDetail: JournalEntryLineDetailSchema,
});

// Journal Entry Schema - comprehensive fields
const JournalEntryDataSchema = z.object({
  DocNumber: z.string().optional(),
  TxnDate: z.string().optional(),
  PrivateNote: z.string().optional(),
  Adjustment: z.boolean().optional(),
  CurrencyRef: QuickBooksReferenceSchema.optional(),
  ExchangeRate: z.number().optional(),
  Line: z.array(JournalEntryLineSchema),
  TxnTaxDetail: z
    .object({
      TxnTaxCodeRef: QuickBooksReferenceSchema.optional(),
      TotalTax: z.number().optional(),
      TaxLine: z.array(z.any()).optional(),
    })
    .optional(),
});

// Bank Deposit Line Schema
const DepositLineDetailSchema = z
  .object({
    AccountRef: QuickBooksReferenceSchema.optional(),
    Entity: z
      .object({
        EntityRef: QuickBooksReferenceSchema,
        Type: z.enum(['Customer', 'Vendor', 'Employee', 'Other']).optional(),
      })
      .optional(),
    ClassRef: QuickBooksReferenceSchema.optional(),
    CheckNum: z.string().optional(),
    PaymentMethodRef: QuickBooksReferenceSchema.optional(),
    TaxCodeRef: QuickBooksReferenceSchema.optional(),
    TaxApplicableOn: z.enum(['Sales', 'Purchase']).optional(),
    LinkedTxn: z
      .array(
        z.object({
          TxnId: z.string(),
          TxnType: z.string(),
          TxnLineId: z.string().optional(),
        })
      )
      .optional(),
  })
  .refine(
    (data) => {
      // CheckNum is required only when PaymentMethodRef.name is "Check" (case insensitive)
      const paymentMethodName = data.PaymentMethodRef?.name?.toLowerCase();
      if (paymentMethodName === 'check') {
        return data.CheckNum && data.CheckNum.trim().length > 0;
      }
      return true;
    },
    {
      message: "CheckNum is required when PaymentMethodRef.name is 'Check'",
    }
  );

const BankDepositLineSchema = z.object({
  Id: z.string().optional(),
  LineNum: z.number().optional(),
  Amount: z.number(),
  DetailType: z.literal('DepositLineDetail'),
  Description: z.string().optional(),
  DepositLineDetail: DepositLineDetailSchema,
  LinkedTxn: z
    .array(
      z.object({
        TxnId: z.string(),
        TxnType: z.string(),
      })
    )
    .optional(), // Allow at top level for backward compatibility
});

// Bank Deposit Schema - comprehensive fields
const BankDepositDataSchema = z.object({
  DocNumber: z.string().optional(),
  TxnDate: z.string().optional(),
  PrivateNote: z.string().optional(),
  DepositToAccountRef: QuickBooksReferenceSchema,
  CashBack: z
    .object({
      AccountRef: QuickBooksReferenceSchema,
      Amount: z.number(),
      Memo: z.string().optional(),
    })
    .optional(),
  CurrencyRef: QuickBooksReferenceSchema.optional(),
  ExchangeRate: z.number().optional(),
  DepartmentRef: QuickBooksReferenceSchema.optional(),
  Line: z.array(BankDepositLineSchema).optional(),
  TxnTaxDetail: z
    .object({
      TxnTaxCodeRef: QuickBooksReferenceSchema.optional(),
      TotalTax: z.number().optional(),
      TaxLine: z.array(z.any()).optional(),
    })
    .optional(),
  // Special field for simplified deposit creation from sales receipts
  SalesReceiptIds: z.array(z.string()).optional(),
});

// Union type for all data schemas
const ManualSyncDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sales-receipt'),
    data: SalesReceiptDataSchema,
  }),
  z.object({
    type: z.literal('journal-entry'),
    data: JournalEntryDataSchema,
  }),
  z.object({
    type: z.literal('bank-deposit'),
    data: BankDepositDataSchema,
  }),
]);

const ManualSyncRequestSchema = z.object({
  type: z.enum(['sales-receipt', 'journal-entry', 'bank-deposit']),
  data: z.union([SalesReceiptDataSchema, JournalEntryDataSchema, BankDepositDataSchema]),
});

type ManualSyncRequest = z.infer<typeof ManualSyncRequestSchema>;

// Extended data type for bank deposits with SalesReceiptIds
interface BankDepositData {
  DepositToAccountRef?: { name?: string; value?: string };
  TxnDate?: string;
  SalesReceiptIds?: string[]; // Array of sales receipt IDs to include in deposit
  Line?: any[]; // Optional manual line items (if SalesReceiptIds not provided)
  PrivateNote?: string;
}

interface ManualSyncResponse {
  success: boolean;
  id?: string;
  type?: QuickBooksDocType;
  docNumber?: string;
  error?: string;
}

interface QuickBooksAccount {
  Id: string;
  Name?: string;
  AccountType?: string;
  AccountSubType?: string;
}

const buildHttpResponse = (status: number, jsonBody: Record<string, any>): HttpResponseInit => ({
  status,
  jsonBody,
});

const buildSuccessResponse = (
  result: { id: string; type: QuickBooksDocType },
  docNumber?: string
): ManualSyncResponse => ({
  success: true,
  id: result.id,
  type: result.type,
  ...(docNumber && { docNumber }),
});

const buildFailureResponse = (error: unknown): ManualSyncResponse => ({
  success: false,
  error: error instanceof Error ? error.message : 'Unknown error occurred',
});

const defaultSalesReceiptDepositAccount = (
  type: QuickBooksDocType,
  data: any,
  context: InvocationContext
): any => {
  if (type === 'sales-receipt' && !data.DepositToAccountRef) {
    data.DepositToAccountRef = { name: 'Undeposited Funds' };
    logger.info('Defaulting DepositToAccountRef to Undeposited Funds for sales-receipt', {
      invocationId: context.invocationId,
    });
  }

  return data;
};

const normalizeBankDepositLines = (lines: any[]): any[] =>
  lines.map((line: any) => {
    if (line?.DetailType !== 'DepositLineDetail') {
      return line;
    }

    return {
      Amount: line.Amount,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        LinkedTxn: line.DepositLineDetail?.LinkedTxn || line.LinkedTxn || [],
      },
    };
  });

const createMinimalBankDepositPayload = (resolvedData: any): any => ({
  DepositToAccountRef: { value: resolvedData.DepositToAccountRef?.value },
  TxnDate: resolvedData.TxnDate || new Date().toISOString().slice(0, 10),
  Line: resolvedData.Line,
});

const postQuickBooksDocument = async (
  type: QuickBooksDocType,
  data: QuickBooksSalesReceipt | QuickBooksJournalEntry | QuickBooksBankDeposit
): Promise<{ id: string; type: QuickBooksDocType }> => {
  switch (type) {
    case 'sales-receipt':
      return postSalesReceipt(data as QuickBooksSalesReceipt);
    case 'journal-entry':
      return postJournalEntry(data as QuickBooksJournalEntry);
    case 'bank-deposit':
      return postBankDeposit(data as QuickBooksBankDeposit);
    default:
      throw new Error(`Unsupported QuickBooks document type: ${type}`);
  }
};

const processBankDepositSalesReceiptIds = async (
  data: BankDepositData,
  context: InvocationContext
): Promise<ManualSyncResponse> => {
  logger.info('Processing bank deposit with SalesReceiptIds using minimal schema', {
    salesReceiptIds: data.SalesReceiptIds,
    count: data.SalesReceiptIds?.length,
    invocationId: context.invocationId,
  });

  if (!data.SalesReceiptIds || data.SalesReceiptIds.length === 0) {
    throw new Error('SalesReceiptIds array cannot be empty for bank deposits');
  }

  const salesReceiptId = data.SalesReceiptIds[0];
  const salesReceipt = await getSalesReceiptById(salesReceiptId);
  if (!salesReceipt) {
    throw new Error(`Sales receipt with ID ${salesReceiptId} not found in QuickBooks`);
  }

  const depositToAccount = salesReceipt.DepositToAccountRef?.name;
  if (depositToAccount && depositToAccount.toLowerCase() !== 'undeposited funds') {
    logger.warn(`Sales receipt ${salesReceiptId} is not in Undeposited Funds account`, {
      salesReceiptId,
      currentAccount: depositToAccount,
      invocationId: context.invocationId,
    });
  }

  const operatingBankId = await getAccountIdByName('Operating Bank', context);
  if (!operatingBankId) {
    throw new Error('Operating Bank account not found');
  }

  const realmId = process.env.QBO_COMPANY_ID || '';
  if (!realmId) {
    throw new Error('QBO_COMPANY_ID not configured');
  }

  const accessToken = await tokenManager.getValidAccessToken(fetch);
  const depositResult = await createQboDeposit({
    realmId,
    accessToken,
    bankId: operatingBankId,
    salesReceiptId: salesReceipt.Id,
    amountDollars: salesReceipt.TotalAmt || 0,
    txnDateISO: data.TxnDate || new Date().toISOString().slice(0, 10),
    env: process.env.QBO_ENVIRONMENT === 'production' ? 'prod' : 'sandbox',
  });

  logger.info('Bank deposit created successfully with minimal schema', {
    depositId: depositResult.Deposit?.Id,
    salesReceiptId,
    invocationId: context.invocationId,
  });

  return {
    success: true,
    id: depositResult.Deposit?.Id,
    type: 'bank-deposit',
  };
};

const parseManualSyncRequest = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<
  | { success: true; type: QuickBooksDocType; data: ManualSyncRequest['data'] }
  | { success: false; response: HttpResponseInit }
> => {
  const body = await request.json();
  const validationResult = ManualSyncRequestSchema.safeParse(body);

  if (!validationResult.success) {
    logger.warn('Invalid request body for manual QBO sync', {
      errors: validationResult.error.errors,
      invocationId: context.invocationId,
    });

    return {
      success: false,
      response: buildHttpResponse(400, {
        success: false,
        error: 'Invalid request body',
        details: validationResult.error.errors,
      }),
    };
  }

  return {
    success: true,
    type: validationResult.data.type,
    data: validationResult.data.data,
  };
};

// Generate DocNumber in format "MAN-YYYY-MMDDHHMMSS"
const generateDocNumber = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const dateTimeStr = `${month}${day}${hours}${minutes}${seconds}`;
  return `MAN-${year}-${dateTimeStr}`;
};

// Retrieve sales receipt from QBO by ID
const getSalesReceiptById = async (salesReceiptId: string): Promise<any | null> => {
  try {
    const queryStr = `SELECT * FROM SalesReceipt WHERE Id = '${salesReceiptId.replace(/'/g, "\\'")}'`;
    logger.info('Querying QuickBooks for sales receipt', {
      salesReceiptId,
      query: queryStr,
    });

    const result = await query<any>(queryStr);

    logger.info('QuickBooks query response', {
      salesReceiptId,
      isArray: Array.isArray(result),
      resultLength: Array.isArray(result) ? result.length : 0,
      hasQueryResponse: !!(result as any)?.QueryResponse,
    });

    // Handle array response (query function returns array directly)
    if (Array.isArray(result) && result.length > 0) {
      const salesReceipt = result[0];
      logger.info('Found sales receipt in QuickBooks', {
        salesReceiptId,
        docNumber: salesReceipt.DocNumber,
        totalAmt: salesReceipt.TotalAmt,
        depositToAccount: salesReceipt.DepositToAccountRef?.name,
      });
      return salesReceipt;
    }

    // Handle QueryResponse wrapper (fallback for different query implementations)
    if ((result as any)?.QueryResponse?.SalesReceipt) {
      const salesReceipts = (result as any).QueryResponse.SalesReceipt;
      if (salesReceipts.length > 0) {
        logger.info('Found sales receipt in QuickBooks (QueryResponse format)', {
          salesReceiptId,
          docNumber: salesReceipts[0].DocNumber,
          totalAmt: salesReceipts[0].TotalAmt,
        });
        return salesReceipts[0];
      }
    }

    logger.warn('Sales receipt not found in QuickBooks', {
      salesReceiptId,
    });
    return null;
  } catch (error) {
    logger.error(`Failed to retrieve sales receipt with ID ${salesReceiptId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Could not retrieve sales receipt ${salesReceiptId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const getAccountIdByName = async (
  accountName: string,
  context: InvocationContext
): Promise<string | null> => {
  try {
    const queryStr = `SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE Name = '${accountName.replace(/'/g, "\\'")}'`;
    logger.info('Querying QuickBooks for account', {
      accountName,
      query: queryStr,
      invocationId: context.invocationId,
    });

    const result = await query<any>(queryStr);

    if (Array.isArray(result) && result.length > 0) {
      const account = result[0] as QuickBooksAccount;
      logger.info('Found account by name', {
        accountName,
        accountId: account.Id,
        accountType: account.AccountType,
        accountSubType: account.AccountSubType,
        invocationId: context.invocationId,
      });
      return account.Id;
    }

    const accounts = (result as { QueryResponse?: { Account?: QuickBooksAccount[] } })
      ?.QueryResponse?.Account;
    if (accounts && accounts.length > 0) {
      const account = accounts[0];
      logger.info('Found account by name (QueryResponse format)', {
        accountName,
        accountId: account.Id,
        accountType: account.AccountType,
        accountSubType: account.AccountSubType,
        invocationId: context.invocationId,
      });
      return account.Id;
    }

    logger.warn('Account not found by name', {
      accountName,
      invocationId: context.invocationId,
    });
    return null;
  } catch (error) {
    logger.error('Failed to query account by name', {
      accountName,
      error: error instanceof Error ? error.message : String(error),
      invocationId: context.invocationId,
    });
    return null;
  }
};

// Validate that required references are resolved
const validateRequiredReferences = (data: any, type: QuickBooksDocType): void => {
  if (type === 'sales-receipt') {
    if (!data.DepositToAccountRef?.value) {
      throw new Error('DepositToAccountRef is required and must be resolved to a valid account ID');
    }
    if (!data.Line || !Array.isArray(data.Line)) {
      throw new Error('Line array is required');
    }
    for (let i = 0; i < data.Line.length; i++) {
      const line = data.Line[i];
      if (line.DetailType === 'SalesItemLineDetail') {
        if (!line.SalesItemLineDetail?.ItemRef?.value) {
          throw new Error(
            `Line ${i + 1}: ItemRef is required and must be resolved to a valid item ID`
          );
        }
        if (line.Amount == null || typeof line.Amount !== 'number' || line.Amount <= 0) {
          throw new Error(`Line ${i + 1}: Amount must be a positive number`);
        }
      }
    }
  } else if (type === 'journal-entry') {
    if (!data.Line || !Array.isArray(data.Line)) {
      throw new Error('Line array is required');
    }
    for (let i = 0; i < data.Line.length; i++) {
      const line = data.Line[i];
      if (line.DetailType === 'JournalEntryLineDetail') {
        if (!line.JournalEntryLineDetail?.AccountRef?.value) {
          throw new Error(
            `Line ${i + 1}: AccountRef is required and must be resolved to a valid account ID`
          );
        }
        if (line.Amount == null || typeof line.Amount !== 'number' || line.Amount <= 0) {
          throw new Error(`Line ${i + 1}: Amount must be a positive number`);
        }
      }
    }
  } else if (type === 'bank-deposit') {
    if (!data.DepositToAccountRef?.value) {
      throw new Error('DepositToAccountRef is required and must be resolved to a valid account ID');
    }
    if (!data.Line || !Array.isArray(data.Line)) {
      throw new Error('Line array is required');
    }
    for (let i = 0; i < data.Line.length; i++) {
      const line = data.Line[i];
      if (line.DetailType === 'DepositLineDetail') {
        const detail = line.DepositLineDetail;
        if (detail?.AccountRef && !detail.AccountRef.value) {
          throw new Error(
            `Line ${i + 1}: AccountRef must include a valid account ID when provided`
          );
        }
        if (
          !line.DepositLineDetail?.LinkedTxn ||
          !Array.isArray(line.DepositLineDetail.LinkedTxn) ||
          line.DepositLineDetail.LinkedTxn.length === 0
        ) {
          throw new Error(`Line ${i + 1}: LinkedTxn array is required for deposit lines`);
        }
        if (line.Amount == null || typeof line.Amount !== 'number' || line.Amount <= 0) {
          throw new Error(`Line ${i + 1}: Amount must be a positive number`);
        }
      }
    }
  }
};

// Helper function to check if a value is considered "empty"
const isEmpty = (value: any): boolean => {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return true;
  }
  if (Array.isArray(value) && value.length === 0) {
    return true;
  }
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return true;
  }
  return false;
};

// Remove null/undefined and empty values from the object to avoid QuickBooks errors
const cleanPayload = (obj: any): any => {
  if (isEmpty(obj)) {
    return undefined;
  }

  if (Array.isArray(obj)) {
    return obj.map(cleanPayload).filter((item) => !isEmpty(item));
  }

  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = cleanPayload(value);
      if (!isEmpty(cleanedValue)) {
        cleaned[key] = cleanedValue;
      }
    }
    return cleaned;
  }

  return obj;
};

// Recursively resolve ItemRef, CustomerRef, AccountRef, and other reference types in the document data
const resolveItemReferences = async (
  data: any,
  context: InvocationContext,
  rootData?: any // Root document for accessing BillEmail, etc.
): Promise<any> => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return Promise.all(data.map((item) => resolveItemReferences(item, context, rootData || data)));
  }

  const resolved = { ...data };
  const root = rootData || data; // Use root data if provided, otherwise current data is root

  // Handle any Ref field that has a name but no value
  for (const [key, value] of Object.entries(resolved)) {
    if (key.endsWith('Ref') && value && typeof value === 'object' && 'name' in value) {
      const refValue = value as { name: string; value?: string };
      if (refValue.name && !refValue.value) {
        try {
          let resolvedRef: { value: string; name: string } | null = null;

          if (key === 'ItemRef') {
            const itemResult = await ensureItem(refValue.name);
            resolvedRef = { value: itemResult.value, name: itemResult.name || refValue.name };
          } else if (key === 'CustomerRef') {
            // For customer refs, check for email at root document level
            let email: string | undefined;
            if (root.BillEmail?.Address) {
              email = root.BillEmail.Address;
            }

            context.log(`Resolving CustomerRef`, {
              name: refValue.name,
              email,
              hasRootBillEmail: !!root.BillEmail,
              rootBillEmailAddress: root.BillEmail?.Address,
            });

            const customerResult = await ensureCustomer(refValue.name, email);
            resolvedRef = {
              value: customerResult.value,
              name: customerResult.name || refValue.name,
            };

            context.log(`CustomerRef resolved`, {
              name: refValue.name,
              resolvedValue: customerResult.value,
              resolvedName: customerResult.name,
            });
          } else if (key === 'AccountRef' || key.endsWith('AccountRef')) {
            // For accounts, use ensureAccount which will create if it doesn't exist
            // We need to determine the account type based on context
            let accountType: string | undefined;

            // Infer account type from the reference key or parent context
            if (key === 'DepositToAccountRef') {
              // Check if the name suggests it's Undeposited Funds
              if (refValue.name.toLowerCase().includes('undeposited')) {
                accountType = 'Other Current Asset';
              } else {
                accountType = 'Bank'; // Bank accounts for deposits
              }
            } else if (resolved.TxnType === 'SalesReceipt' || root?.TxnType === 'SalesReceipt') {
              accountType = 'Other Current Asset'; // Linked sales receipts come from Undeposited Funds
            } else if (key === 'ItemAccountRef') {
              accountType = 'Income'; // Income accounts for items
            } else if (resolved.PostingType === 'Debit' || resolved.PostingType === 'Credit') {
              // For journal entries, default to Other Current Assets (can be customized)
              accountType = 'Other Current Asset';
            }

            const accountResult = await ensureAccount(refValue.name, accountType);
            resolvedRef = { value: accountResult.value, name: accountResult.name || refValue.name };
          } else if (key === 'ClassRef') {
            // Handle hierarchical class names like "Parent:Child"
            const classNameParts = refValue.name.split(':');
            let classCreateData: any = { Name: refValue.name };

            if (classNameParts.length > 1) {
              // Hierarchical class: find or create parent first
              const parentName = classNameParts[0].trim();
              const childName = classNameParts.slice(1).join(':').trim();

              // First ensure the parent class exists
              const parentClass = await ensureReference('Class', parentName, { Name: parentName });

              // Then create child class with ParentRef
              classCreateData = {
                Name: childName,
                ParentRef: { value: parentClass.value },
              };

              // Query for existing child class under this parent
              const existingChild = await queryReference('Class', childName);
              if (existingChild) {
                resolvedRef = { value: existingChild.value, name: existingChild.name || childName };
              } else {
                // Create the child class
                const childResult = await ensureReference('Class', childName, classCreateData);
                resolvedRef = { value: childResult.value, name: childResult.name || childName };
              }
            } else {
              // Simple class name
              const classResult = await ensureReference('Class', refValue.name, classCreateData);
              resolvedRef = { value: classResult.value, name: classResult.name || refValue.name };
            }
          } else if (key === 'DepartmentRef') {
            const deptResult = await ensureReference('Department', refValue.name, {
              Name: refValue.name,
            });
            resolvedRef = { value: deptResult.value, name: deptResult.name || refValue.name };
          } else if (key === 'PaymentMethodRef') {
            const pmResult = await ensureReference('PaymentMethod', refValue.name, {
              Name: refValue.name,
              Type: 'CREDIT_CARD',
            });
            resolvedRef = { value: pmResult.value, name: pmResult.name || refValue.name };
          } else if (key === 'SalesTermRef') {
            const termResult = await ensureReference('Term', refValue.name, {
              Name: refValue.name,
              Type: 'STANDARD',
              DueDays: 30,
            });
            resolvedRef = { value: termResult.value, name: termResult.name || refValue.name };
          } else if (key === 'ShipMethodRef') {
            // QuickBooks doesn't support creating ShipMethod entities via API
            // Try to query for existing ones, but don't attempt to create
            const shipResult = await queryReference('ShipMethod', refValue.name);
            if (shipResult) {
              resolvedRef = { value: shipResult.value, name: shipResult.name || refValue.name };
            } else {
              // ShipMethod doesn't exist and can't be created, remove the reference
              logger.warn(
                `ShipMethod "${refValue.name}" not found and cannot be created via API, removing reference`,
                {
                  refType: key,
                  refName: refValue.name,
                  invocationId: context.invocationId,
                }
              );
              delete resolved[key];
            }
          } else if (key === 'TaxCodeRef') {
            // For tax codes, just query since creating them is complex
            const taxResult = await queryReference('TaxCode', refValue.name);
            if (taxResult) {
              resolvedRef = { value: taxResult.value, name: taxResult.name || refValue.name };
            }
          } else if (key === 'CurrencyRef') {
            // For currencies, just query
            const currencyResult = await queryReference('Currency', refValue.name);
            if (currencyResult) {
              resolvedRef = {
                value: currencyResult.value,
                name: currencyResult.name || refValue.name,
              };
            }
          } else if (key === 'EntityRef') {
            // EntityRef can be Customer, Vendor, Employee, etc.
            // Check the Type field in the parent Entity object
            const entityType = resolved.Type || 'Customer'; // Default to Customer
            let entityResult;

            if (entityType === 'Customer') {
              entityResult = await ensureCustomer(refValue.name);
            } else if (entityType === 'Vendor') {
              // For vendors, query first, create if not found
              entityResult = await queryReference('Vendor', refValue.name);
              if (!entityResult) {
                // Create vendor
                entityResult = await ensureReference('Vendor', refValue.name, {
                  Name: refValue.name,
                  Vendor1099: false,
                });
              }
            } else if (entityType === 'Employee') {
              // For employees, query first, create if not found
              entityResult = await queryReference('Employee', refValue.name);
              if (!entityResult) {
                // Create employee
                entityResult = await ensureReference('Employee', refValue.name, {
                  Name: refValue.name,
                  GivenName: refValue.name.split(' ')[0],
                  FamilyName: refValue.name.split(' ').slice(1).join(' ') || refValue.name,
                });
              }
            } else {
              // For other types, just query
              entityResult = await queryReference(entityType, refValue.name);
            }

            if (entityResult) {
              resolvedRef = { value: entityResult.value, name: entityResult.name || refValue.name };
            }
          }

          if (resolvedRef) {
            resolved[key] = resolvedRef;
            logger.info(`Resolved ${key} for "${refValue.name}" to ID: ${resolvedRef.value}`, {
              refType: key,
              originalName: refValue.name,
              resolvedId: resolvedRef.value,
              invocationId: context.invocationId,
            });
          } else {
            // Leave unresolved references as-is for validation
            if (key === 'EntityRef') {
              delete resolved.Entity;
            }
            logger.warn(`Could not resolve ${key} for "${refValue.name}"`, {
              refType: key,
              refName: refValue.name,
              invocationId: context.invocationId,
            });
          }
        } catch (error) {
          if (key === 'EntityRef') {
            delete resolved.Entity;
          }
          logger.warn(`Failed to resolve ${key}: ${refValue.name}`, {
            refType: key,
            refName: refValue.name,
            error: error instanceof Error ? error.message : String(error),
            invocationId: context.invocationId,
          });
          // Leave failed references as-is for validation
        }
      }
    }
  }

  // Recursively process all other properties
  for (const [key, value] of Object.entries(resolved)) {
    if (!key.endsWith('Ref')) {
      resolved[key] = await resolveItemReferences(value, context, root);
    }
  }

  // Special handling for sales receipts: inherit ClassRef from header to lines if needed
  if (
    resolved.ClassRef &&
    resolved.Line &&
    Array.isArray(resolved.Line) &&
    resolved.Line.some((line: any) => line.SalesItemLineDetail)
  ) {
    const headerClassRef = resolved.ClassRef;
    for (const line of resolved.Line) {
      if (line.SalesItemLineDetail && !line.SalesItemLineDetail.ClassRef) {
        line.SalesItemLineDetail.ClassRef = { ...headerClassRef };
        logger.info(`Inherited ClassRef from header to line item`, {
          headerClassRef: headerClassRef.name || headerClassRef.value,
          lineDescription: line.Description,
          invocationId: context.invocationId,
        });
      }
    }
  }

  // Fix amount calculation when discounts are present for all line items
  if (resolved.Line && Array.isArray(resolved.Line)) {
    for (const line of resolved.Line) {
      if (
        line.SalesItemLineDetail &&
        line.SalesItemLineDetail.DiscountAmt &&
        line.SalesItemLineDetail.UnitPrice &&
        line.SalesItemLineDetail.Qty
      ) {
        const unitPrice = line.SalesItemLineDetail.UnitPrice;
        const qty = line.SalesItemLineDetail.Qty;
        const discountAmt = line.SalesItemLineDetail.DiscountAmt;
        const calculatedAmount = unitPrice * qty;

        // If Amount is currently set to discounted amount, correct it
        if (line.Amount == calculatedAmount - discountAmt) {
          line.Amount = calculatedAmount;
          logger.info(`Corrected line amount for discount`, {
            originalAmount: calculatedAmount - discountAmt,
            correctedAmount: calculatedAmount,
            discountAmt,
            lineDescription: line.Description,
            invocationId: context.invocationId,
          });
        }
      }
    }
  }

  return resolved;
};

const validateAndPost = async (
  type: QuickBooksDocType,
  data: any,
  context: InvocationContext
): Promise<ManualSyncResponse> => {
  try {
    logger.info(`Starting ${type} validation and resolution`, {
      type,
      hasCustomerRef: !!data.CustomerRef,
      hasBillEmail: !!data.BillEmail,
      billEmailAddress: data.BillEmail?.Address,
      customerRefName: data.CustomerRef?.name,
      hasSalesReceiptIds: !!(data.SalesReceiptIds && Array.isArray(data.SalesReceiptIds)),
      salesReceiptIdsCount: data.SalesReceiptIds?.length,
      invocationId: context.invocationId,
    });

    let resolvedData = defaultSalesReceiptDepositAccount(type, data, context);

    // Special handling for bank-deposit with SalesReceiptIds
    if (type === 'bank-deposit' && data.SalesReceiptIds && Array.isArray(data.SalesReceiptIds)) {
      return processBankDepositSalesReceiptIds(data, context);
    }

    if (
      type === 'bank-deposit' &&
      resolvedData.DepositToAccountRef?.name &&
      !resolvedData.DepositToAccountRef.value
    ) {
      const accountId = await getAccountIdByName(resolvedData.DepositToAccountRef.name, context);
      if (accountId) {
        resolvedData.DepositToAccountRef.value = accountId;
      }
    }

    if (type === 'bank-deposit' && Array.isArray(resolvedData.Line)) {
      resolvedData.Line = normalizeBankDepositLines(resolvedData.Line);
    }

    // Resolve item references before posting
    resolvedData = await resolveItemReferences(resolvedData, context);

    // Fallback for sales receipt DepositToAccountRef if not resolved
    if (type === 'sales-receipt' && !resolvedData.DepositToAccountRef?.value) {
      logger.warn('DepositToAccountRef not resolved, falling back to Undeposited Funds', {
        providedName: resolvedData.DepositToAccountRef?.name,
        invocationId: context.invocationId,
      });
      resolvedData.DepositToAccountRef = { name: 'Undeposited Funds' };
      // Resolve again
      resolvedData = await resolveItemReferences(resolvedData, context);
    }

    // For bank deposits, ensure minimal schema structure
    if (type === 'bank-deposit') {
      resolvedData = createMinimalBankDepositPayload(resolvedData);
    }

    logger.info(`References resolved for ${type}`, {
      type,
      customerRefValue: resolvedData.CustomerRef?.value,
      customerRefName: resolvedData.CustomerRef?.name,
      classRefValue: resolvedData.ClassRef?.value,
      classRefName: resolvedData.ClassRef?.name,
      depositToAccountRefValue: resolvedData.DepositToAccountRef?.value,
      depositToAccountRefName: resolvedData.DepositToAccountRef?.name,
      invocationId: context.invocationId,
    });

    // Validate required references and amounts
    validateRequiredReferences(resolvedData, type);

    // Clean the payload to remove any null/undefined values
    const cleanedData = cleanPayload(resolvedData);

    // Generate DocNumber if not provided
    let generatedDocNumber: string | undefined;
    if (!cleanedData.DocNumber) {
      generatedDocNumber = generateDocNumber();
      cleanedData.DocNumber = generatedDocNumber;
      logger.info(`Generated DocNumber for ${type}`, {
        docNumber: generatedDocNumber,
        invocationId: context.invocationId,
      });
    }

    const result = await postQuickBooksDocument(type, cleanedData);

    logger.info(`Successfully synced ${type} with ID: ${result.id}`, {
      type,
      id: result.id,
      invocationId: context.invocationId,
    });

    return buildSuccessResponse(result, generatedDocNumber);
  } catch (error) {
    logger.error(`Failed to sync ${type} to QuickBooks`, {
      type,
      error: error instanceof Error ? error.message : String(error),
      invocationId: context.invocationId,
    });

    return buildFailureResponse(error);
  }
};

export default async function manualQboSync(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const parsedRequest = await parseManualSyncRequest(request, context);
    if (!parsedRequest.success) {
      return parsedRequest.response;
    }

    const { type, data } = parsedRequest;

    logger.info(`Processing manual QBO sync request`, {
      type,
      invocationId: context.invocationId,
    });

    const result = await validateAndPost(type, data, context);

    return buildHttpResponse(result.success ? 200 : 500, result);
  } catch (error) {
    logger.error('Unexpected error in manual QBO sync', {
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      invocationId: context.invocationId,
    });

    return buildHttpResponse(500, {
      success: false,
      error: 'Internal server error',
    });
  }
}
