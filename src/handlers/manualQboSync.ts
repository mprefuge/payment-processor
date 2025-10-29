import type { InvocationContext, HttpRequest, HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import {
  postSalesReceipt,
  postJournalEntry,
  postBankDeposit,
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

const validateAndPost = async (
  type: QuickBooksDocType,
  data: any,
  context: InvocationContext
): Promise<ManualSyncResponse> => {
  try {
    let result;

    switch (type) {
      case 'sales-receipt':
        result = await postSalesReceipt(data as QuickBooksSalesReceipt);
        break;
      case 'journal-entry':
        result = await postJournalEntry(data as QuickBooksJournalEntry);
        break;
      case 'bank-deposit':
        result = await postBankDeposit(data as QuickBooksBankDeposit);
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