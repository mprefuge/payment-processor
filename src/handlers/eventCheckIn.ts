/**
 * Event Check-In HTTP Handler
 * Handles event check-in requests
 */

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { EventCheckInRequest } from '../types/events';
import { createEventHandlerService, createErrorResponse } from './eventHandlerCommon';

const validateCheckInRequest = (requestBody: EventCheckInRequest | null): string | null => {
  if (!requestBody) {
    return 'Request body is required';
  }

  if (!requestBody.registrationId && !(requestBody.email && requestBody.eventId)) {
    return 'Either registrationId or (email and eventId) must be provided';
  }

  return null;
};

export default async function eventCheckIn(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Event check-in request received');

  try {
    // Parse request body
    const requestBody = (await request.json()) as EventCheckInRequest;
    const validationError = validateCheckInRequest(requestBody);
    if (validationError) {
      return createErrorResponse(400, validationError);
    }

    const eventSvc = await createEventHandlerService();

    // Check in registrant
    const result = await eventSvc.checkInRegistrant(requestBody);

    if (!result.success) {
      return { status: 404, jsonBody: result };
    }

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    context.error('Event check-in error:', error);

    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Internal server error'
    );
  }
}
