export interface IServiceContainer {
  getStripeWebhookProcessor(): import('../handlers/webhook/StripeWebhookProcessor').StripeWebhookProcessor;
  getEventRouter(): import('../handlers/webhook/StripeEventRouter').StripeEventRouter;
  getResponseFormatter(): import('../handlers/webhook/WebhookResponseFormatter').DefaultWebhookResponseFormatter;
  setTestDependencies(deps?: import('../stripe/types').StripeWebhookDependencies): void;
}

class ServiceContainer implements IServiceContainer {
  private stripeWebhookProcessor?: import('../handlers/webhook/StripeWebhookProcessor').StripeWebhookProcessor;
  private eventRouter?: import('../handlers/webhook/StripeEventRouter').StripeEventRouter;
  private responseFormatter?: import('../handlers/webhook/WebhookResponseFormatter').DefaultWebhookResponseFormatter;
  private testDependencies?: import('../stripe/types').StripeWebhookDependencies;

  private getOrCreate<T>(current: T | undefined, create: () => T): T {
    return current ?? create();
  }

  private createStripeWebhookProcessor(): import('../handlers/webhook/StripeWebhookProcessor').StripeWebhookProcessor {
    const dependencies = this.getStripeWebhookDependencies();
    const { StripeWebhookProcessor } = require('../handlers/webhook/StripeWebhookProcessor');
    return new StripeWebhookProcessor(dependencies);
  }

  private createEventRouter(): import('../handlers/webhook/StripeEventRouter').StripeEventRouter {
    const { StripeEventRouter } = require('../handlers/webhook/StripeEventRouter');
    return new StripeEventRouter();
  }

  private createResponseFormatter(): import('../handlers/webhook/WebhookResponseFormatter').DefaultWebhookResponseFormatter {
    const {
      DefaultWebhookResponseFormatter,
    } = require('../handlers/webhook/WebhookResponseFormatter');
    return new DefaultWebhookResponseFormatter();
  }

  setTestDependencies(deps?: import('../stripe/types').StripeWebhookDependencies): void {
    this.testDependencies = deps;
    // Reset cached instances so they use new dependencies
    this.stripeWebhookProcessor = undefined;
  }

  getStripeWebhookProcessor(): import('../handlers/webhook/StripeWebhookProcessor').StripeWebhookProcessor {
    this.stripeWebhookProcessor = this.getOrCreate(this.stripeWebhookProcessor, () =>
      this.createStripeWebhookProcessor()
    );
    return this.stripeWebhookProcessor!;
  }

  getEventRouter(): import('../handlers/webhook/StripeEventRouter').StripeEventRouter {
    this.eventRouter = this.getOrCreate(this.eventRouter, () => this.createEventRouter());
    return this.eventRouter!;
  }

  getResponseFormatter(): import('../handlers/webhook/WebhookResponseFormatter').DefaultWebhookResponseFormatter {
    this.responseFormatter = this.getOrCreate(this.responseFormatter, () =>
      this.createResponseFormatter()
    );
    return this.responseFormatter!;
  }

  private getStripeWebhookDependencies() {
    if (this.testDependencies) {
      return this.testDependencies;
    }
    // Use getDependencies() which caches the dependencies including the in-memory store
    const { getDependencies } = require('../handlers/stripeWebhook');
    return getDependencies();
  }
}

export const serviceContainer = new ServiceContainer();
