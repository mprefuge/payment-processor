/**
 * Event Management Types
 * Supports free, paid, and recurring event registrations with Salesforce integration
 */

export enum EventType {
  FREE = 'free',
  PAID_ONETIME = 'paid_onetime',
  PAID_RECURRING = 'paid_recurring',
}

export enum RegistrationStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export enum CheckInStatus {
  NOT_CHECKED_IN = 'not_checked_in',
  CHECKED_IN = 'checked_in',
}

export enum PaymentStatus {
  NOT_REQUIRED = 'not_required',
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

/**
 * Event configuration interface
 */
export interface Event {
  id: string;
  name: string;
  description: string;
  type: EventType;
  campaignId: string; // Salesforce Campaign ID
  startDate: string; // ISO 8601 format
  endDate: string; // ISO 8601 format
  location?: string;
  capacity?: number;
  price?: number; // In smallest currency unit (e.g., cents)
  currency?: string; // ISO 4217 currency code
  recurringInterval?: 'month' | 'year'; // For recurring events
  recurringCount?: number; // Number of payments for recurring events
  requiresApproval?: boolean;
  isActive: boolean;
  customFields?: Record<string, any>;
}

/**
 * Registrant contact information
 */
export interface RegistrantContact {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  company?: string;
  mailingStreet?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingPostalCode?: string;
  mailingCountry?: string;
  customFields?: Record<string, any>;
}

/**
 * Event registration data
 */
export interface EventRegistration {
  id: string;
  eventId: string;
  contact: RegistrantContact;
  salesforceContactId?: string;
  salesforceCampaignMemberId?: string;
  registrationStatus: RegistrationStatus;
  checkInStatus: CheckInStatus;
  paymentStatus: PaymentStatus;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  stripeSubscriptionId?: string;
  stripeCheckoutSessionId?: string;
  amountPaid?: number;
  currency?: string;
  registeredAt: string; // ISO 8601 format
  checkedInAt?: string; // ISO 8601 format
  cancelledAt?: string; // ISO 8601 format
  notes?: string;
  customFields?: Record<string, any>;
}

/**
 * Request to register for an event
 */
export interface EventRegistrationRequest {
  eventId: string;
  contact: RegistrantContact;
  paymentMethodId?: string; // Stripe payment method ID (for paid events)
  customFields?: Record<string, any>;
  notes?: string;
}

/**
 * Response after successful registration
 */
export interface EventRegistrationResponse {
  success: boolean;
  registrationId: string;
  eventId: string;
  registrationStatus: RegistrationStatus;
  paymentStatus: PaymentStatus;
  salesforceContactId?: string;
  salesforceCampaignMemberId?: string;
  stripeCheckoutSessionId?: string;
  checkoutUrl?: string; // For Stripe Checkout (if applicable)
  message?: string;
  error?: string;
}

/**
 * Request to check in a registrant
 */
export interface EventCheckInRequest {
  registrationId?: string;
  email?: string; // Alternative lookup by email
  eventId?: string; // Required if using email lookup
}

/**
 * Response after check-in
 */
export interface EventCheckInResponse {
  success: boolean;
  registrationId: string;
  checkInStatus: CheckInStatus;
  checkedInAt?: string;
  registrantName: string;
  message?: string;
  error?: string;
}

/**
 * Theme configuration for event landing pages
 */
export interface EventThemeConfig {
  primaryColor: string; // Hex color code
  secondaryColor: string; // Hex color code
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  logoUrl?: string;
}

/**
 * Salesforce Campaign Member data
 */
export interface CampaignMemberDTO {
  CampaignId: string;
  ContactId: string;
  Status?: string;
  Description?: string;
}

/**
 * Salesforce Contact upsert data
 */
export interface ContactUpsertDTO {
  Email: string;
  FirstName?: string;
  LastName?: string;
  Phone?: string;
  Company?: string;
  MailingStreet?: string;
  MailingCity?: string;
  MailingState?: string;
  MailingPostalCode?: string;
  MailingCountry?: string;
  // when creating a new contact, we may specify a RecordTypeId
  RecordTypeId?: string;
}
