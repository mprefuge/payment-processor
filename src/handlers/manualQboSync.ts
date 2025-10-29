import type { InvocationContext, HttpRequest, HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import {
  postSalesReceipt,
  postJournalEntry,
  postBankDeposit,
  ensureItem,
  ensureCustomer,
  ensureAccount,
  query,
  type QuickBooksSalesReceipt,
  type QuickBooksJournalEntry,
  type QuickBooksBankDeposit,
} from '../services/qboSvc';
import { logger } from '../lib/logger';

type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

const ManualSyncRequestSchema = z.object({
  type: z.enum(['sales-receipt', 'journal-entry', 'bank-deposit']),
  data: z.record(z.any()), // Allow any object structure
});

type ManualSyncRequest = z.infer<typeof ManualSyncRequestSchema>;

interface ManualSyncResponse {
  success: boolean;
  id?: string;
  type?: QuickBooksDocType;
  error?: string;
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

// Generate DocNumber in format "MAN-YYYYMMDD-TOTAL"
const generateDocNumber = (total: number): string => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const totalStr = Math.abs(total).toFixed(2).replace('.', ''); // Remove decimal point for integer representation
  return `MAN-${dateStr}-${totalStr}`;
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
    const responseKey = type === 'sales-receipt' ? 'SalesReceipt' :
                       type === 'journal-entry' ? 'JournalEntry' : 'Deposit';

    return !!(result.QueryResponse?.[responseKey]?.length > 0);
  } catch (error) {
    logger.warn(`Failed to check for duplicate ${type} with DocNumber ${docNumber}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    // If we can't check for duplicates, assume it's not a duplicate to avoid blocking
    return false;
  }
};

// Recursively resolve ItemRef, CustomerRef, and AccountRef references in the document data
const resolveItemReferences = async (data: any, context: InvocationContext): Promise<any> => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return Promise.all(data.map(item => resolveItemReferences(item, context)));
  }

  const resolved = { ...data };

  // Handle ItemRef
  if (resolved.ItemRef && typeof resolved.ItemRef === 'object') {
    const itemRef = resolved.ItemRef;
    if (itemRef.name && typeof itemRef.name === 'string') {
      try {
        const ensuredItem = await ensureItem(itemRef.name);
        resolved.ItemRef = {
          value: ensuredItem.value,
          name: ensuredItem.name,
        };
        logger.info(`Resolved ItemRef for "${itemRef.name}" to ID: ${ensuredItem.value}`, {
          originalName: itemRef.name,
          resolvedId: ensuredItem.value,
          invocationId: context.invocationId,
        });
      } catch (error) {
        logger.warn(`Failed to resolve item reference: ${itemRef.name}`, {
          error: error instanceof Error ? error.message : String(error),
          invocationId: context.invocationId,
        });
        // Keep the original reference if resolution fails
      }
    }
  }

  // Handle CustomerRef
  if (resolved.CustomerRef && typeof resolved.CustomerRef === 'object') {
    const customerRef = resolved.CustomerRef;
    if (customerRef.name && typeof customerRef.name === 'string') {
      try {
        // Extract email from BillEmail if available
        let email: string | undefined;
        if (resolved.BillEmail?.Address) {
          email = resolved.BillEmail.Address;
        }

        const ensuredCustomer = await ensureCustomer(customerRef.name, email);
        resolved.CustomerRef = {
          value: ensuredCustomer.value,
          name: ensuredCustomer.name,
        };
        logger.info(`Resolved CustomerRef for "${customerRef.name}" to ID: ${ensuredCustomer.value}`, {
          originalName: customerRef.name,
          resolvedId: ensuredCustomer.value,
          invocationId: context.invocationId,
        });
      } catch (error) {
        logger.warn(`Failed to resolve customer reference: ${customerRef.name}`, {
          error: error instanceof Error ? error.message : String(error),
          invocationId: context.invocationId,
        });
        // Keep the original reference if resolution fails
      }
    }
  }

  // Handle AccountRef
  if (resolved.AccountRef && typeof resolved.AccountRef === 'object') {
    const accountRef = resolved.AccountRef;
    if (accountRef.name && typeof accountRef.name === 'string') {
      try {
        // For accounts, we don't auto-create them unless we have a type
        // This is more conservative since account creation requires specific types
        const queryResult = await query<{ QueryResponse: { Account?: any[] } }>(
          `SELECT Id, Name FROM Account WHERE Name = '${accountRef.name.replace(/'/g, "\\'")}'`
        );

        if (queryResult.QueryResponse?.Account && queryResult.QueryResponse.Account.length > 0) {
          const account = queryResult.QueryResponse.Account[0];
          resolved.AccountRef = {
            value: account.Id,
            name: account.Name,
          };
          logger.info(`Resolved AccountRef for "${accountRef.name}" to ID: ${account.Id}`, {
            originalName: accountRef.name,
            resolvedId: account.Id,
            invocationId: context.invocationId,
          });
        } else {
          logger.warn(`Account "${accountRef.name}" not found and will not be auto-created`, {
            accountName: accountRef.name,
            invocationId: context.invocationId,
          });
          // Keep the original reference - let it fail later if the account doesn't exist
        }
      } catch (error) {
        logger.warn(`Failed to resolve account reference: ${accountRef.name}`, {
          error: error instanceof Error ? error.message : String(error),
          invocationId: context.invocationId,
        });
        // Keep the original reference if resolution fails
      }
    }
  }

  // Recursively process all other properties
  for (const [key, value] of Object.entries(resolved)) {
    if (key !== 'ItemRef' && key !== 'CustomerRef' && key !== 'AccountRef') {
      resolved[key] = await resolveItemReferences(value, context);
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
    // Resolve item references before posting
    const resolvedData = await resolveItemReferences(data, context);

    // Calculate total and generate DocNumber
    const total = calculateTotal(resolvedData);
    const docNumber = generateDocNumber(total);

    // Check for duplicates
    const isDuplicate = await checkDuplicate(docNumber, type);
    if (isDuplicate) {
      logger.warn(`Duplicate ${type} detected with DocNumber: ${docNumber}`, {
        type,
        docNumber,
        invocationId: context.invocationId,
      });
      return {
        success: false,
        error: `Document with DocNumber ${docNumber} already exists`,
      };
    }

    // Add DocNumber to the document
    const dataWithDocNumber = {
      ...resolvedData,
      DocNumber: docNumber,
    };

    logger.info(`Generated DocNumber: ${docNumber} for ${type} with total: ${total}`, {
      type,
      docNumber,
      total,
      invocationId: context.invocationId,
    });

    let result;

    switch (type) {
      case 'sales-receipt':
        result = await postSalesReceipt(dataWithDocNumber as QuickBooksSalesReceipt);
        break;
      case 'journal-entry':
        result = await postJournalEntry(dataWithDocNumber as QuickBooksJournalEntry);
        break;
      case 'bank-deposit':
        result = await postBankDeposit(dataWithDocNumber as QuickBooksBankDeposit);
        break;
      default:
        throw new Error(`Unsupported QuickBooks document type: ${type}`);
    }

    logger.info(`Successfully synced ${type} with ID: ${result.id}`, {
      type,
      id: result.id,
      docNumber,
      invocationId: context.invocationId,
    });

    return {
      success: true,
      id: result.id,
      type: result.type,
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
    logger.error('Unexpected error in manual QBO sync handler', {
      error: error instanceof Error ? error.message : String(error),
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
}