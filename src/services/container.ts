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

  setTestDependencies(deps?: import('../stripe/types').StripeWebhookDependencies): void {
    this.testDependencies = deps;
    // Reset cached instances so they use new dependencies
    this.stripeWebhookProcessor = undefined;
  }

  getStripeWebhookProcessor(): import('../handlers/webhook/StripeWebhookProcessor').StripeWebhookProcessor {
    if (!this.stripeWebhookProcessor) {
      const dependencies = this.getStripeWebhookDependencies();
      const { StripeWebhookProcessor } = require('../handlers/webhook/StripeWebhookProcessor');
      this.stripeWebhookProcessor = new StripeWebhookProcessor(dependencies);
    }
    return this.stripeWebhookProcessor!;
  }

  getEventRouter(): import('../handlers/webhook/StripeEventRouter').StripeEventRouter {
    if (!this.eventRouter) {
      const { StripeEventRouter } = require('../handlers/webhook/StripeEventRouter');
      this.eventRouter = new StripeEventRouter();
    }
    return this.eventRouter!;
  }

  getResponseFormatter(): import('../handlers/webhook/WebhookResponseFormatter').DefaultWebhookResponseFormatter {
    if (!this.responseFormatter) {
      const {
        DefaultWebhookResponseFormatter,
      } = require('../handlers/webhook/WebhookResponseFormatter');
      this.responseFormatter = new DefaultWebhookResponseFormatter();
    }
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
