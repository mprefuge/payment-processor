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
const QuickBooksReferenceSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
}).refine(data => data.name || data.value, {
  message: "Either name or value must be provided for a reference"
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
  CustomerMemo: z.object({
    value: z.string(),
  }).optional(),
  DepositToAccountRef: QuickBooksReferenceSchema,
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
  TxnTaxDetail: z.object({
    TxnTaxCodeRef: QuickBooksReferenceSchema.optional(),
    TotalTax: z.number().optional(),
    TaxLine: z.array(z.any()).optional(),
  }).optional(),
  CustomField: z.array(z.object({
    DefinitionId: z.string(),
    Name: z.string().optional(),
    Type: z.string().optional(),
    StringValue: z.string().optional(),
  })).optional(),
});

// Journal Entry Line Schema
const JournalEntryLineDetailSchema = z.object({
  PostingType: z.enum(['Debit', 'Credit']),
  AccountRef: QuickBooksReferenceSchema,
  Entity: z.object({
    EntityRef: QuickBooksReferenceSchema,
    Type: z.enum(['Customer', 'Vendor', 'Employee', 'Other']).optional(),
  }).optional(),
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
  TxnTaxDetail: z.object({
    TxnTaxCodeRef: QuickBooksReferenceSchema.optional(),
    TotalTax: z.number().optional(),
    TaxLine: z.array(z.any()).optional(),
  }).optional(),
});

// Bank Deposit Line Schema
const DepositLineDetailSchema = z.object({
  AccountRef: QuickBooksReferenceSchema.optional(),
  Entity: z.object({
    EntityRef: QuickBooksReferenceSchema,
    Type: z.enum(['Customer', 'Vendor', 'Employee', 'Other']).optional(),
  }).optional(),
  ClassRef: QuickBooksReferenceSchema.optional(),
  CheckNum: z.string().optional(),
  PaymentMethodRef: QuickBooksReferenceSchema.optional(),
  TaxCodeRef: QuickBooksReferenceSchema.optional(),
  TaxApplicableOn: z.enum(['Sales', 'Purchase']).optional(),
  LinkedTxn: z.array(z.object({
    TxnId: z.string(),
    TxnType: z.string(),
    TxnLineId: z.string().optional(),
  })).optional(),
});

const BankDepositLineSchema = z.object({
  Id: z.string().optional(),
  LineNum: z.number().optional(),
  Amount: z.number(),
  DetailType: z.literal('DepositLineDetail'),
  Description: z.string().optional(),
  DepositLineDetail: DepositLineDetailSchema,
  LinkedTxn: z.array(z.object({
    TxnId: z.string(),
    TxnType: z.string(),
  })).optional(), // Allow at top level for backward compatibility
});

// Bank Deposit Schema - comprehensive fields
const BankDepositDataSchema = z.object({
  DocNumber: z.string().optional(),
  TxnDate: z.string().optional(),
  PrivateNote: z.string().optional(),
  DepositToAccountRef: QuickBooksReferenceSchema,
  CashBack: z.object({
    AccountRef: QuickBooksReferenceSchema,
    Amount: z.number(),
    Memo: z.string().optional(),
  }).optional(),
  CurrencyRef: QuickBooksReferenceSchema.optional(),
  ExchangeRate: z.number().optional(),
  DepartmentRef: QuickBooksReferenceSchema.optional(),
  Line: z.array(BankDepositLineSchema).optional(),
  TxnTaxDetail: z.object({
    TxnTaxCodeRef: QuickBooksReferenceSchema.optional(),
    TotalTax: z.number().optional(),
    TaxLine: z.array(z.any()).optional(),
  }).optional(),
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

// Calculate total amount from document lines
const calculateTotal = (data: any): number => {
  if (!data.Line || !Array.isArray(data.Line)) {
    return 0;
  }

  return data.Line.reduce((total: number, line: any) => {
    return total + (line.Amount || 0);
  }, 0);
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

// Check for duplicate documents by DocNumber
const checkDuplicate = async (docNumber: string, type: QuickBooksDocType): Promise<boolean> => {
  try {
    let queryStr: string;

    switch (type) {
      case 'sales-receipt':
        queryStr = `SELECT Id FROM SalesReceipt WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
        break;
      case 'journal-entry':
        queryStr = `SELECT Id FROM JournalEntry WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
        break;
      case 'bank-deposit':
        queryStr = `SELECT Id FROM Deposit WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
        break;
      default:
        return false;
    }

    const result = await query<{ QueryResponse: any }>(queryStr);
    const responseKey =
      type === 'sales-receipt'
        ? 'SalesReceipt'
        : type === 'journal-entry'
          ? 'JournalEntry'
          : 'Deposit';

    return !!(result.QueryResponse?.[responseKey]?.length > 0);
  } catch (error) {
    logger.warn(`Failed to check for duplicate ${type} with DocNumber ${docNumber}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    // If we can't check for duplicates, assume it's not a duplicate to avoid blocking
    return false;
  }
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

// Build bank deposit lines from sales receipt IDs
const buildBankDepositFromSalesReceipts = async (
  salesReceiptIds: string[],
  context: InvocationContext
): Promise<{ lines: any[]; totalAmount: number }> => {
  const lines: any[] = [];
  let totalAmount = 0;

  logger.info('Building bank deposit from sales receipts', {
    salesReceiptIds,
    count: salesReceiptIds.length,
    invocationId: context.invocationId,
  });

  for (const salesReceiptId of salesReceiptIds) {
    const salesReceipt = await getSalesReceiptById(salesReceiptId);

    if (!salesReceipt) {
      throw new Error(`Sales receipt with ID ${salesReceiptId} not found in QuickBooks`);
    }

    // Verify that the sales receipt is deposited to Undeposited Funds
    const depositToAccount = salesReceipt.DepositToAccountRef?.name;
    if (depositToAccount && depositToAccount.toLowerCase() !== 'undeposited funds') {
      logger.warn(`Sales receipt ${salesReceiptId} is not in Undeposited Funds account`, {
        salesReceiptId,
        currentAccount: depositToAccount,
        invocationId: context.invocationId,
      });
    }

    // Get the total amount from the sales receipt
    const amount = salesReceipt.TotalAmt || 0;
    totalAmount += amount;

    // Create a deposit line referencing the sales receipt
    const depositLine: any = {
      Amount: amount,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        LinkedTxn: [
          {
            TxnId: salesReceipt.Id,
            TxnType: 'SalesReceipt',
          },
        ],
      },
    };

    lines.push(depositLine);

    logger.info(`Added sales receipt to deposit`, {
      salesReceiptId,
      amount,
      invocationId: context.invocationId,
    });
  }

  logger.info('Bank deposit lines built successfully', {
    lineCount: lines.length,
    totalAmount,
    invocationId: context.invocationId,
  });

  return { lines, totalAmount };
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

// Remove null/undefined values from the object to avoid QuickBooks errors
const cleanPayload = (obj: any): any => {
  if (obj === null || obj === undefined) {
    return undefined;
  }

  if (Array.isArray(obj)) {
    return obj.map(cleanPayload).filter((item) => item !== undefined);
  }

  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = cleanPayload(value);
      if (cleanedValue !== undefined && cleanedValue !== null) {
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
              accountType = 'Bank'; // Bank accounts for deposits
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
            const classResult = await ensureReference('Class', refValue.name, { Name: refValue.name });
            resolvedRef = { value: classResult.value, name: classResult.name || refValue.name };
          } else if (key === 'DepartmentRef') {
            const deptResult = await ensureReference('Department', refValue.name, { Name: refValue.name });
            resolvedRef = { value: deptResult.value, name: deptResult.name || refValue.name };
          } else if (key === 'PaymentMethodRef') {
            const pmResult = await ensureReference('PaymentMethod', refValue.name, { Name: refValue.name, Type: 'CREDIT_CARD' });
            resolvedRef = { value: pmResult.value, name: pmResult.name || refValue.name };
          } else if (key === 'SalesTermRef') {
            const termResult = await ensureReference('Term', refValue.name, { Name: refValue.name, Type: 'STANDARD', DueDays: 30 });
            resolvedRef = { value: termResult.value, name: termResult.name || refValue.name };
          } else if (key === 'ShipMethodRef') {
            // QuickBooks doesn't support creating ShipMethod entities via API
            // Try to query for existing ones, but don't attempt to create
            const shipResult = await queryReference('ShipMethod', refValue.name);
            if (shipResult) {
              resolvedRef = { value: shipResult.value, name: shipResult.name || refValue.name };
            } else {
              // ShipMethod doesn't exist and can't be created, remove the reference
              logger.warn(`ShipMethod "${refValue.name}" not found and cannot be created via API, removing reference`, {
                refType: key,
                refName: refValue.name,
                invocationId: context.invocationId,
              });
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
              resolvedRef = { value: currencyResult.value, name: currencyResult.name || refValue.name };
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
                  Vendor1099: false
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
                  FamilyName: refValue.name.split(' ').slice(1).join(' ') || refValue.name
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
  if (resolved.ClassRef && resolved.Line && Array.isArray(resolved.Line) && resolved.Line.some((line: any) => line.SalesItemLineDetail)) {
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
      if (line.SalesItemLineDetail && line.SalesItemLineDetail.DiscountAmt && line.SalesItemLineDetail.UnitPrice && line.SalesItemLineDetail.Qty) {
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

    let resolvedData = data;

    // Special handling for bank-deposit with SalesReceiptIds
    if (type === 'bank-deposit' && data.SalesReceiptIds && Array.isArray(data.SalesReceiptIds)) {
      logger.info('Processing bank deposit with SalesReceiptIds using minimal schema', {
        salesReceiptIds: data.SalesReceiptIds,
        count: data.SalesReceiptIds.length,
        invocationId: context.invocationId,
      });

      // Validate SalesReceiptIds array is not empty
      if (data.SalesReceiptIds.length === 0) {
        throw new Error('SalesReceiptIds array cannot be empty for bank deposits');
      }

      // Get the first sales receipt ID (process one at a time)
      const salesReceiptId = data.SalesReceiptIds[0];

      // Get the sales receipt details
      const salesReceipt = await getSalesReceiptById(salesReceiptId);
      if (!salesReceipt) {
        throw new Error(`Sales receipt with ID ${salesReceiptId} not found in QuickBooks`);
      }

      // Verify that the sales receipt is deposited to Undeposited Funds
      const depositToAccount = salesReceipt.DepositToAccountRef?.name;
      if (depositToAccount && depositToAccount.toLowerCase() !== 'undeposited funds') {
        logger.warn(`Sales receipt ${salesReceiptId} is not in Undeposited Funds account`, {
          salesReceiptId,
          currentAccount: depositToAccount,
          invocationId: context.invocationId,
        });
      }

      // Get the operating bank account ID
      const operatingBankId = await getAccountIdByName('Operating Bank', context);
      if (!operatingBankId) {
        throw new Error('Operating Bank account not found');
      }

      // Get QBO realm ID
      const realmId = process.env.QBO_COMPANY_ID || '';
      if (!realmId) {
        throw new Error('QBO_COMPANY_ID not configured');
      }

      // Get a valid access token
      const accessToken = await tokenManager.getValidAccessToken(fetch);

      // Create deposit using the minimal schema
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

      // Return success immediately
      return {
        success: true,
        id: depositResult.Deposit?.Id,
        type: 'bank-deposit',
      };
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
      resolvedData.Line = resolvedData.Line.map((line: any) => {
        if (line?.DetailType !== 'DepositLineDetail') {
          return line;
        }

        // Ensure minimal schema structure for DepositLineDetail
        const depositLineDetail: any = {
          LinkedTxn: line.DepositLineDetail?.LinkedTxn || line.LinkedTxn || [],
        };

        // Create clean line object with only required fields
        line = {
          Amount: line.Amount,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: depositLineDetail,
        };

        return line;
      });
    }

    // Resolve item references before posting
    resolvedData = await resolveItemReferences(resolvedData, context);

    // For bank deposits, ensure minimal schema structure
    if (type === 'bank-deposit') {
      // Ensure TxnDate is set
      if (!resolvedData.TxnDate) {
        resolvedData.TxnDate = new Date().toISOString().slice(0, 10);
      }

      // Create clean bank deposit object with only required fields
      resolvedData = {
        DepositToAccountRef: { value: resolvedData.DepositToAccountRef?.value },
        TxnDate: resolvedData.TxnDate,
        Line: resolvedData.Line,
      };
    }

    logger.info(`References resolved for ${type}`, {
      type,
      customerRefValue: resolvedData.CustomerRef?.value,
      customerRefName: resolvedData.CustomerRef?.name,
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

    let result;

    switch (type) {
      case 'sales-receipt':
        result = await postSalesReceipt(cleanedData as QuickBooksSalesReceipt);
        break;
      case 'journal-entry':
        result = await postJournalEntry(cleanedData as QuickBooksJournalEntry);
        break;
      case 'bank-deposit':
        result = await postBankDeposit(cleanedData as QuickBooksBankDeposit);
        break;
      default:
        throw new Error(`Unsupported QuickBooks document type: ${type}`);
    }

    logger.info(`Successfully synced ${type} with ID: ${result.id}`, {
      type,
      id: result.id,
      invocationId: context.invocationId,
    });

    return {
      success: true,
      id: result.id,
      type: result.type,
      ...(generatedDocNumber && { docNumber: generatedDocNumber }),
    };
  } catch (error) {
    logger.error(`Failed to sync ${type} to QuickBooks`, {
      type,
      error: error instanceof Error ? error.message : String(error),
      invocationId: context.invocationId,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
};

export default async function manualQboSync(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const body = await request.json();

    const validationResult = ManualSyncRequestSchema.safeParse(body);
    if (!validationResult.success) {
      logger.warn('Invalid request body for manual QBO sync', {
        errors: validationResult.error.errors,
        invocationId: context.invocationId,
      });

      return {
        status: 400,
        jsonBody: {
          success: false,
          error: 'Invalid request body',
          details: validationResult.error.errors,
        },
      };
    }

    const { type, data } = validationResult.data;

    logger.info(`Processing manual QBO sync request`, {
      type,
      invocationId: context.invocationId,
    });

    const result = await validateAndPost(type, data, context);

    if (result.success) {
      return {
        status: 200,
        jsonBody: result,
      };
    } else {
      return {
        status: 500,
        jsonBody: result,
      };
    }
  } catch (error) {
    logger.error('Unexpected error in manual QBO sync', {
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      invocationId: context.invocationId,
    });

    return {
      status: 500,
      jsonBody: {
        success: false,
        error: 'Internal server error',
      },
    };
  }
};
