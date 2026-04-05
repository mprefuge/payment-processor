/**
 * Event Registration HTTP Handler
 * Handles event registration requests
 */

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { EventRegistrationRequest, Event } from '../types/events';
import { createEventHandlerService, createErrorResponse } from './eventHandlerCommon';

const validateRegistrationRequest = (
  requestBody: EventRegistrationRequest | null
): string | null => {
  if (!requestBody || !requestBody.eventId || !requestBody.contact) {
    return 'Missing required fields: eventId and contact are required';
  }

  const { contact } = requestBody;
  if (!contact.email || !contact.firstName || !contact.lastName) {
    return 'Contact must include email, firstName, and lastName';
  }

  return null;
};

export default async function eventRegistration(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Event registration request received');

  try {
    // Parse request body
    const requestBody = (await request.json()) as EventRegistrationRequest;
    const validationError = validateRegistrationRequest(requestBody);
    if (validationError) {
      return createErrorResponse(400, validationError);
    }

    const eventSvc = await createEventHandlerService();

    // Get all active events and find the requested one
    const activeEvents = await eventSvc.getActiveEvents();
    const event = activeEvents.find((e: Event) => e.id === requestBody.eventId);

    if (!event) {
      return createErrorResponse(404, `Event not found: ${requestBody.eventId}`);
    }

    // Register for event
    const result = await eventSvc.registerForEvent(requestBody, event);

    if (!result.success) {
      return { status: 400, jsonBody: result };
    }

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    context.error('Event registration error:', error);

    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Internal server error'
    );
  }
}
