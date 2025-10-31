/**
 * Centralized Service Initialization
 *
 * Single responsibility: Initialize and provide access to all external service connections
 * Ensures consistent configuration and reduces duplication across handlers
 */

import { Client as SendGridClient } from '@sendgrid/client';
import { stripeClientFactory } from './stripeClientFactory';
import AccountingSyncConfig from './payoutRecon/accountingSyncConfig';
import AccountingProviderFactory from './qbo/accountingProviderFactory';
import CrmFactory from './salesforce/crmFactory';
import { createPersistentStorageClients } from './idempotency/storage/persistentStoreFactory';

interface ServiceDependencies {
  stripe: typeof stripeClientFactory;
  sendGrid: () => SendGridClient;
  accountingSyncConfig: () => AccountingSyncConfig;
  accountingProviderFactory: typeof AccountingProviderFactory;
  crmFactory: typeof CrmFactory;
  persistentStorage: typeof createPersistentStorageClients;
}

class ServiceInitializer {
  private dependencies: ServiceDependencies;

  constructor() {
    this.dependencies = this.createDefaultDependencies();
  }

  private createDefaultDependencies(): ServiceDependencies {
    return {
      stripe: stripeClientFactory,
      sendGrid: () => new SendGridClient(),
      accountingSyncConfig: () => new AccountingSyncConfig(),
      accountingProviderFactory: AccountingProviderFactory,
      crmFactory: CrmFactory,
      persistentStorage: createPersistentStorageClients,
    };
  }

  /**
   * Get the current service dependencies
   */
  getDependencies(): ServiceDependencies {
    return this.dependencies;
  }

  /**
   * Override dependencies (useful for testing)
   */
  setDependencies(overrides: Partial<ServiceDependencies>): void {
    this.dependencies = {
      ...this.dependencies,
      ...overrides,
    };
  }

  /**
   * Reset dependencies to defaults
   */
  resetDependencies(): void {
    this.dependencies = this.createDefaultDependencies();
  }

  /**
   * Get Stripe client factory
   */
  getStripeFactory() {
    return this.dependencies.stripe;
  }

  /**
   * Get SendGrid client
   */
  getSendGridClient() {
    return this.dependencies.sendGrid();
  }

  /**
   * Get accounting sync configuration
   */
  getAccountingSyncConfig() {
    return this.dependencies.accountingSyncConfig();
  }

  /**
   * Get accounting provider factory
   */
  getAccountingProviderFactory() {
    return this.dependencies.accountingProviderFactory;
  }

  /**
   * Get CRM factory
   */
  getCrmFactory() {
    return this.dependencies.crmFactory;
  }

  /**
   * Get persistent storage clients
   */
  getPersistentStorage(namespace?: string) {
    return this.dependencies.persistentStorage(namespace);
  }
}

// Singleton instance
export const serviceInitializer = new ServiceInitializer();

// Export for testing
export { ServiceInitializer };
export type { ServiceDependencies };
