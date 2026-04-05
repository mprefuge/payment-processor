/**
 * Event Management Service
 * Handles event registration, check-in, and Salesforce integration
 */

import type { Connection } from 'jsforce/lib/connection';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { buildFullName, filterCustomersByExactName } from '../stripe/customerIdentity';
import {
  Event,
  EventRegistration,
  EventRegistrationRequest,
  EventRegistrationResponse,
  EventCheckInRequest,
  EventCheckInResponse,
  RegistrantContact,
  ContactUpsertDTO,
  CampaignMemberDTO,
  EventType,
  RegistrationStatus,
  CheckInStatus,
  PaymentStatus,
} from '../types/events';

export interface EventSvcOptions {
  salesforceConnection: Connection;
  stripeClient: Stripe;
}

export interface EventSvc {
  registerForEvent: (
    request: EventRegistrationRequest,
    event: Event
  ) => Promise<EventRegistrationResponse>;
  checkInRegistrant: (request: EventCheckInRequest) => Promise<EventCheckInResponse>;
  findOrCreateContact: (contact: RegistrantContact) => Promise<string>;
  addCampaignMember: (contactId: string, campaignId: string, status?: string) => Promise<string>;
  getActiveEvents: () => Promise<Event[]>;
}

type SalesforceCreateResult =
  | { success: boolean; id: string; errors: string[] }
  | Array<{ success: boolean; id: string; errors: string[] }>;

type PaymentResult = {
  paymentStatus: PaymentStatus;
  stripePaymentIntentId?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  checkoutUrl?: string;
};

type EventCampaignRecord = {
  Id: string;
  Name: string;
  Description?: string;
  StartDate?: string;
  EndDate?: string;
  IsActive: boolean;
  Event_Type__c?: string;
  Price__c?: number;
  Currency__c?: string;
  Capacity__c?: number;
  Recurring_Interval__c?: string;
  Recurring_Count__c?: number;
  Location__c?: string;
  Requires_Approval__c?: boolean;
};

const registrations: Map<string, EventRegistration> = new Map();

const escapeSoqlLiteral = (value: string): string => value.replace(/'/g, "\\'");

const toRecords = <T>(result: { records?: T[] } | null | undefined): T[] =>
  Array.isArray(result?.records) ? result.records : [];

const getRegistrantName = (contact: RegistrantContact): string =>
  buildFullName(contact.firstName, contact.lastName) || '';

const createRegistrationFailure = (eventId: string, error: string): EventRegistrationResponse => ({
  success: false,
  registrationId: '',
  eventId,
  registrationStatus: RegistrationStatus.FAILED,
  paymentStatus: PaymentStatus.FAILED,
  error,
});

const createCheckInFailure = (error: string): EventCheckInResponse => ({
  success: false,
  registrationId: '',
  checkInStatus: CheckInStatus.NOT_CHECKED_IN,
  registrantName: '',
  error,
});

const unwrapCreateResult = (result: SalesforceCreateResult, entityName: string): string => {
  const normalized = Array.isArray(result) ? result[0] : result;

  if (!normalized?.success) {
    throw new Error(`Failed to create ${entityName}: ${normalized?.errors.join(', ')}`);
  }

  return normalized.id;
};

const mapCampaignRecordToEvent = (record: EventCampaignRecord): Event => ({
  id: record.Id,
  name: record.Name,
  description: record.Description || '',
  type: (record.Event_Type__c as EventType) || EventType.FREE,
  campaignId: record.Id,
  startDate: record.StartDate || new Date().toISOString(),
  endDate: record.EndDate || new Date().toISOString(),
  location: record.Location__c,
  capacity: record.Capacity__c,
  price: record.Price__c,
  currency: record.Currency__c || 'USD',
  recurringInterval: record.Recurring_Interval__c as 'month' | 'year',
  recurringCount: record.Recurring_Count__c,
  requiresApproval: record.Requires_Approval__c || false,
  isActive: record.IsActive,
});

export const createEventSvc = ({
  salesforceConnection,
  stripeClient,
}: EventSvcOptions): EventSvc => {
  let cachedContactRecordTypeId: string | undefined;

  const queryRecords = async <T>(soql: string): Promise<T[]> =>
    toRecords(await salesforceConnection.query<any>(soql)) as T[];

  const findSingleId = async (soql: string): Promise<string | null> => {
    const records = await queryRecords<{ Id: string }>(soql);
    return records[0]?.Id ?? null;
  };

  const getContactRecordTypeId = async (): Promise<string | undefined> => {
    if (cachedContactRecordTypeId) {
      return cachedContactRecordTypeId;
    }

    cachedContactRecordTypeId =
      (await findSingleId(
        "SELECT Id FROM RecordType WHERE SObjectType = 'Contact' AND Name = 'Contact' LIMIT 1"
      )) ?? undefined;

    return cachedContactRecordTypeId;
  };

  const findOrCreateContact = async (contact: RegistrantContact): Promise<string> => {
    const {
      email,
      firstName,
      lastName,
      phone,
      company,
      mailingStreet,
      mailingCity,
      mailingState,
      mailingPostalCode,
      mailingCountry,
    } = contact;

    if (!email || !email.trim()) {
      throw new Error('Email is required for contact creation');
    }

    const existingContactId = await findSingleId(
      `SELECT Id FROM Contact WHERE Email = '${escapeSoqlLiteral(email)}' LIMIT 1`
    );

    if (existingContactId) {
      return existingContactId;
    }

    const recordTypeId = await getContactRecordTypeId();

    const contactData: ContactUpsertDTO = {
      Email: email,
      FirstName: firstName || undefined,
      LastName: lastName || 'Unknown',
      Phone: phone || undefined,
      Company: company || undefined,
      MailingStreet: mailingStreet || undefined,
      MailingCity: mailingCity || undefined,
      MailingState: mailingState || undefined,
      MailingPostalCode: mailingPostalCode || undefined,
      MailingCountry: mailingCountry || undefined,
      ...(recordTypeId ? { RecordTypeId: recordTypeId } : {}),
    };

    const createResult = await salesforceConnection.sobject('Contact').create(contactData);
    return unwrapCreateResult(createResult as SalesforceCreateResult, 'contact');
  };

  const addCampaignMember = async (
    contactId: string,
    campaignId: string,
    status: string = 'Registered'
  ): Promise<string> => {
    if (!contactId || !campaignId) {
      throw new Error('ContactId and CampaignId are required');
    }

    const existingCampaignMemberId = await findSingleId(
      `SELECT Id FROM CampaignMember WHERE ContactId = '${escapeSoqlLiteral(contactId)}' ` +
        `AND CampaignId = '${escapeSoqlLiteral(campaignId)}' LIMIT 1`
    );

    if (existingCampaignMemberId) {
      return existingCampaignMemberId;
    }

    const campaignMemberData: CampaignMemberDTO = {
      CampaignId: campaignId,
      ContactId: contactId,
      Status: status,
    };

    const createResult = await salesforceConnection
      .sobject('CampaignMember')
      .create(campaignMemberData);
    return unwrapCreateResult(createResult as SalesforceCreateResult, 'campaign member');
  };

  const getOrCreateStripeCustomer = async (
    event: Event,
    contact: RegistrantContact
  ): Promise<Stripe.Customer> => {
    const existingCustomers = await stripeClient.customers.list({
      email: contact.email,
      limit: 20,
    });

    const customers = Array.isArray(existingCustomers.data) ? existingCustomers.data : [];
    const namedMatches = filterCustomersByExactName(
      customers,
      buildFullName(contact.firstName, contact.lastName)
    );

    if (namedMatches.length > 0) {
      return namedMatches[0];
    }

    if (customers.length > 0) {
      return customers[0];
    }

    return await stripeClient.customers.create({
      email: contact.email,
      name: getRegistrantName(contact),
      phone: contact.phone,
      metadata: {
        eventId: event.id,
        eventName: event.name,
      },
    });
  };

  const createRecurringPayment = async (
    event: Event,
    customer: Stripe.Customer
  ): Promise<PaymentResult> => {
    if (!event.recurringInterval) {
      throw new Error('Recurring interval is required for recurring events');
    }

    const price = await stripeClient.prices.create({
      unit_amount: event.price,
      currency: event.currency || 'usd',
      recurring: {
        interval: event.recurringInterval,
        interval_count: 1,
      },
      product_data: {
        name: event.name,
      },
    });

    const subscription = await stripeClient.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        eventId: event.id,
        eventName: event.name,
      },
    });

    const invoice = subscription.latest_invoice as Stripe.Invoice;
    const paymentIntent = invoice?.payment_intent as Stripe.PaymentIntent;

    return {
      paymentStatus: PaymentStatus.PENDING,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customer.id,
      stripePaymentIntentId: paymentIntent?.id,
    };
  };

  const createOneTimePayment = async (
    event: Event,
    contact: RegistrantContact,
    customer: Stripe.Customer,
    paymentMethodId?: string
  ): Promise<PaymentResult> => {
    if (event.price === undefined) {
      throw new Error('Price is required for paid events');
    }

    const paymentIntent = await stripeClient.paymentIntents.create({
      amount: event.price,
      currency: event.currency || 'usd',
      customer: customer.id,
      payment_method: paymentMethodId,
      confirm: !!paymentMethodId,
      metadata: {
        eventId: event.id,
        eventName: event.name,
        contactEmail: contact.email,
      },
      description: `Registration for ${event.name}`,
    });

    return {
      paymentStatus:
        paymentIntent.status === 'succeeded' ? PaymentStatus.COMPLETED : PaymentStatus.PENDING,
      stripePaymentIntentId: paymentIntent.id,
      stripeCustomerId: customer.id,
    };
  };

  const processPayment = async (
    event: Event,
    contact: RegistrantContact,
    paymentMethodId?: string
  ): Promise<PaymentResult> => {
    if (event.type === 'free') {
      return { paymentStatus: PaymentStatus.NOT_REQUIRED };
    }

    if (!event.price || event.price <= 0) {
      throw new Error('Price is required for paid events');
    }

    const customer = await getOrCreateStripeCustomer(event, contact);

    if (event.type === 'paid_recurring') {
      return await createRecurringPayment(event, customer);
    }

    return await createOneTimePayment(event, contact, customer, paymentMethodId);
  };

  const createRegistrationRecord = (
    request: EventRegistrationRequest,
    event: Event,
    contactId: string,
    campaignMemberId: string,
    paymentResult: PaymentResult
  ): EventRegistration => ({
    id: randomUUID(),
    eventId: event.id,
    contact: request.contact,
    salesforceContactId: contactId,
    salesforceCampaignMemberId: campaignMemberId,
    registrationStatus: event.requiresApproval
      ? RegistrationStatus.PENDING
      : RegistrationStatus.CONFIRMED,
    checkInStatus: CheckInStatus.NOT_CHECKED_IN,
    paymentStatus: paymentResult.paymentStatus,
    stripeCustomerId: paymentResult.stripeCustomerId,
    stripePaymentIntentId: paymentResult.stripePaymentIntentId,
    stripeSubscriptionId: paymentResult.stripeSubscriptionId,
    amountPaid: event.price,
    currency: event.currency,
    registeredAt: new Date().toISOString(),
    notes: request.notes,
    customFields: request.customFields,
  });

  const getConfirmedRegistrationCount = (eventId: string): number =>
    Array.from(registrations.values()).filter(
      (registration) =>
        registration.eventId === eventId &&
        registration.registrationStatus === RegistrationStatus.CONFIRMED
    ).length;

  const registerForEvent = async (
    request: EventRegistrationRequest,
    event: Event
  ): Promise<EventRegistrationResponse> => {
    try {
      if (!event.isActive) {
        return createRegistrationFailure(event.id, 'Event is not currently active');
      }

      if (event.capacity && getConfirmedRegistrationCount(event.id) >= event.capacity) {
        return createRegistrationFailure(event.id, 'Event is at full capacity');
      }

      const contactId = await findOrCreateContact(request.contact);
      const campaignMemberId = await addCampaignMember(contactId, event.campaignId);
      const paymentResult = await processPayment(event, request.contact, request.paymentMethodId);
      const registration = createRegistrationRecord(
        request,
        event,
        contactId,
        campaignMemberId,
        paymentResult
      );

      registrations.set(registration.id, registration);

      return {
        success: true,
        registrationId: registration.id,
        eventId: event.id,
        registrationStatus: registration.registrationStatus,
        paymentStatus: registration.paymentStatus,
        salesforceContactId: contactId,
        salesforceCampaignMemberId: campaignMemberId,
        stripeCheckoutSessionId: paymentResult.checkoutUrl,
        message: event.requiresApproval
          ? 'Registration submitted and pending approval'
          : 'Registration confirmed successfully',
      };
    } catch (error) {
      console.error('Event registration error:', error);
      return createRegistrationFailure(
        event.id,
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  };

  const findRegistration = (request: EventCheckInRequest): EventRegistration | undefined => {
    if (request.registrationId) {
      return registrations.get(request.registrationId);
    }

    if (request.email && request.eventId) {
      return Array.from(registrations.values()).find(
        (registration) =>
          registration.contact.email.toLowerCase() === request.email!.toLowerCase() &&
          registration.eventId === request.eventId
      );
    }

    return undefined;
  };

  const createCheckInResponse = (
    registration: EventRegistration,
    message: string
  ): EventCheckInResponse => ({
    success: true,
    registrationId: registration.id,
    checkInStatus: CheckInStatus.CHECKED_IN,
    checkedInAt: registration.checkedInAt,
    registrantName: getRegistrantName(registration.contact),
    message,
  });

  const checkInRegistrant = async (request: EventCheckInRequest): Promise<EventCheckInResponse> => {
    try {
      const registration = findRegistration(request);

      if (!registration) {
        return createCheckInFailure('Registration not found');
      }

      if (registration.registrationStatus !== RegistrationStatus.CONFIRMED) {
        return {
          success: false,
          registrationId: registration.id,
          checkInStatus: CheckInStatus.NOT_CHECKED_IN,
          registrantName: getRegistrantName(registration.contact),
          error: 'Registration is not confirmed',
        };
      }

      if (registration.checkInStatus === CheckInStatus.CHECKED_IN) {
        return createCheckInResponse(registration, 'Already checked in');
      }

      registration.checkInStatus = CheckInStatus.CHECKED_IN;
      registration.checkedInAt = new Date().toISOString();
      registrations.set(registration.id, registration);

      return createCheckInResponse(registration, 'Check-in successful');
    } catch (error) {
      console.error('Event check-in error:', error);
      return createCheckInFailure(
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  };

  const getActiveEvents = async (): Promise<Event[]> => {
    try {
      const soql = `
        SELECT Id, Name, Description, StartDate, EndDate, IsActive,
               Event_Type__c, Price__c, Currency__c, Capacity__c,
               Recurring_Interval__c, Recurring_Count__c, Location__c,
               Requires_Approval__c
        FROM Campaign
        WHERE IsActive = true
        AND RecordType.Name = 'Event'
        ORDER BY StartDate ASC NULLS LAST
      `;

      const records = await queryRecords<EventCampaignRecord>(soql);
      return records.map(mapCampaignRecordToEvent);
    } catch (error) {
      console.error('Error querying active events from Salesforce:', error);
      throw new Error('Failed to load events from Salesforce');
    }
  };

  return {
    registerForEvent,
    checkInRegistrant,
    findOrCreateContact,
    addCampaignMember,
    getActiveEvents,
  };
};
