import Stripe from 'stripe';

export const normalizeStripeId = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    const idValue = (value as { id?: unknown }).id;
    return typeof idValue === 'string' ? idValue : null;
  }

  return null;
};

export const centsToMajorUnits = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }

  return value / 100;
};

export const centsToPositiveMajorUnits = (value: number | null | undefined): number | null => {
  const converted = centsToMajorUnits(value);
  if (converted === null) {
    return null;
  }

  return Math.abs(converted);
};

export const timestampToDate = (timestamp: number | null | undefined): Date => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000);
  }

  return new Date();
};

export const timestampToIsoString = (timestamp: number | null | undefined): string | null => {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
};

export const extractBalanceTransactionId = (source: unknown): string | null =>
  normalizeStripeId(source);

export const resolveCharge = async (
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent
): Promise<Stripe.Charge | null> => {
  const piWithCharges = paymentIntent as Stripe.PaymentIntent & {
    charges?: { data?: Stripe.Charge[] };
  };

  const charges = Array.isArray(piWithCharges.charges?.data) ? piWithCharges.charges!.data! : [];
  if (charges.length > 0) {
    const succeededCharge = charges.find((charge: Stripe.Charge) => charge.status === 'succeeded');
    return succeededCharge || charges[0];
  }

  const latestChargeId = normalizeStripeId(paymentIntent.latest_charge);
  if (latestChargeId) {
    try {
      const response = await stripe.charges.retrieve(latestChargeId);
      return response as Stripe.Charge;
    } catch (error) {
      return null;
    }
  }

  return null;
};

export const resolveBalanceTransaction = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  fallback: Stripe.PaymentIntent | Stripe.Refund | Stripe.Dispute | Stripe.Payout | null
): Promise<Stripe.BalanceTransaction | null> => {
  const fallbackId = fallback
    ? extractBalanceTransactionId(
        (fallback as { balance_transaction?: unknown }).balance_transaction
      )
    : null;

  if (fallbackId) {
    try {
      return await stripe.balanceTransactions.retrieve(fallbackId);
    } catch (error) {
      // Ignore fallback retrieval errors and continue to the charge lookup.
    }
  }

  const id = extractBalanceTransactionId(charge?.balance_transaction);
  if (id) {
    try {
      return await stripe.balanceTransactions.retrieve(id);
    } catch (error) {
      return null;
    }
  }

  return null;
};

export const resolveStripeCustomer = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  paymentIntent: Stripe.PaymentIntent | null,
  logger: (...args: unknown[]) => void
): Promise<(Stripe.Customer | Stripe.DeletedCustomer) | null> => {
  const customerId =
    normalizeStripeId(charge?.customer) || normalizeStripeId(paymentIntent?.customer);

  if (!customerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer as Stripe.Customer | Stripe.DeletedCustomer;
  } catch (error) {
    logger('[StripeWebhook] Failed to retrieve Stripe customer', {
      customerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

/**
 * Ensure a Stripe customer record contains a salesforce_id metadata field.
 * When a contact is looked up or created in Salesforce we want to reflect
 * that ID back on the customer so future transactions can be mapped
 * directly without an additional search.
 *
 * This is intentionally tolerant: failures are logged but not thrown so they
 * don't block the primary payment flow.
 */
export const ensureSalesforceIdOnCustomer = async (
  stripe: Stripe,
  customerId: string,
  salesforceId: string,
  logger: (...args: unknown[]) => void = () => {}
): Promise<void> => {
  if (!customerId || !salesforceId) {
    return;
  }

  try {
    const cust = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
    const current = cust.metadata?.salesforce_id;
    if (current === salesforceId) {
      return; // nothing to do
    }

    const newMetadata = { ...(cust.metadata || {}), salesforce_id: salesforceId };
    await stripe.customers.update(customerId, { metadata: newMetadata });
    logger('[Stripe] Added salesforce_id to customer metadata', {
      customerId,
      salesforceId,
    });
  } catch (err) {
    logger('[Stripe] Failed to update customer metadata with salesforce_id', {
      customerId,
      salesforceId,
      error: err instanceof Error ? err.message : String(err),
    });
    // swallow error
  }
};

export const findCheckoutSessionForPaymentIntent = async (
  stripe: Stripe,
  paymentIntentId: string | null | undefined
): Promise<Stripe.Checkout.Session | null> => {
  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    return null;
  }

  const trimmed = paymentIntentId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // First try the direct lookup
  const sessions = await stripe.checkout.sessions.list({
    payment_intent: trimmed,
    limit: 1,
  });

  if (sessions && Array.isArray(sessions.data) && sessions.data.length > 0) {
    return sessions.data[0] ?? null;
  }

  // If direct lookup fails, check the payment intent's metadata for checkout_session_id
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(trimmed);
    const checkoutSessionId = paymentIntent.metadata?.checkout_session_id;

    if (checkoutSessionId && typeof checkoutSessionId === 'string') {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId.trim());
      return session;
    }
  } catch (error) {
    // Ignore errors when trying to retrieve payment intent or session
  }

  return null;
};

export const getProductNameFromCharge = async (
  stripe: Stripe,
  charge: Stripe.Charge,
  logger: (...args: unknown[]) => void
): Promise<string | null> => {
  try {
    // Check if charge has an invoice ID
    if (charge.invoice && typeof charge.invoice === 'string' && charge.invoice.startsWith('in_')) {
      try {
        const invoice = await stripe.invoices.retrieve(charge.invoice);
        if (invoice.lines?.data && invoice.lines.data.length > 0) {
          const firstLine = invoice.lines.data[0];
          if (firstLine.price?.product) {
            const productId =
              typeof firstLine.price.product === 'string'
                ? firstLine.price.product
                : firstLine.price.product.id;
            if (productId) {
              const product = await stripe.products.retrieve(productId);
              if (product?.name) {
                logger('[getProductNameFromCharge] Found product name from charge invoice', {
                  chargeId: charge.id,
                  invoiceId: charge.invoice,
                  productId: product.id,
                  productName: product.name,
                });
                return product.name;
              }
            }
          }
        }
      } catch (error) {
        logger('[getProductNameFromCharge] Failed to retrieve product from charge invoice', {
          chargeId: charge.id,
          invoiceId: charge.invoice,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // If we have a payment intent, try to get product from there
    const paymentIntentRef = charge.payment_intent;
    if (paymentIntentRef) {
      let pi: any;
      if (typeof paymentIntentRef === 'string') {
        try {
          pi = await stripe.paymentIntents.retrieve(paymentIntentRef);
        } catch (error) {
          logger('[getProductNameFromCharge] Failed to retrieve payment intent', {
            chargeId: charge.id,
            paymentIntentId: paymentIntentRef,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      } else {
        // Payment intent is already expanded
        pi = paymentIntentRef;
      }

      logger('[getProductNameFromCharge] Analyzing payment intent for product name', {
        paymentIntentId: pi?.id,
        hasPaymentDetails: !!pi?.payment_details,
        paymentDetailsKeys: pi?.payment_details ? Object.keys(pi.payment_details) : [],
        orderReference: pi?.payment_details?.order_reference,
        hasMetadata: !!pi?.metadata,
        metadataKeys: pi?.metadata ? Object.keys(pi.metadata) : [],
      });

      // Check payment_details.order_reference (primary location per schema)
      const paymentDetails = pi?.payment_details;
      if (paymentDetails?.order_reference) {
        const orderRef = paymentDetails.order_reference;
        logger('[getProductNameFromCharge] Found order_reference in payment_details', {
          paymentIntentId: pi.id,
          orderRef,
        });

        if (typeof orderRef === 'string' && orderRef.startsWith('prod_')) {
          try {
            const product = await stripe.products.retrieve(orderRef);
            if (product?.name) {
              logger(
                '[getProductNameFromCharge] Found product name from payment_details.order_reference',
                {
                  paymentIntentId: pi.id,
                  productId: product.id,
                  productName: product.name,
                }
              );
              return product.name;
            }
          } catch (error) {
            logger(
              '[getProductNameFromCharge] Failed to retrieve product from payment_details.order_reference',
              {
                paymentIntentId: pi.id,
                orderRef,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }
      }

      // Check payment intent metadata for order_reference (fallback)
      if (pi?.metadata) {
        const orderRef = pi.metadata.order_reference;
        const productRef = pi.metadata.product;

        // Try order_reference
        if (orderRef && typeof orderRef === 'string' && orderRef.startsWith('prod_')) {
          try {
            const product = await stripe.products.retrieve(orderRef);
            if (product?.name) {
              logger(
                '[getProductNameFromCharge] Found product name from payment intent metadata.order_reference',
                {
                  paymentIntentId: pi.id,
                  productId: product.id,
                  productName: product.name,
                }
              );
              return product.name;
            }
          } catch (error) {
            logger(
              '[getProductNameFromCharge] Failed to retrieve product from PI metadata.order_reference',
              {
                paymentIntentId: pi.id,
                orderRef,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

        // Try product
        if (productRef && typeof productRef === 'string' && productRef.startsWith('prod_')) {
          try {
            const product = await stripe.products.retrieve(productRef);
            if (product?.name) {
              logger(
                '[getProductNameFromCharge] Found product name from payment intent metadata.product',
                {
                  paymentIntentId: pi.id,
                  productId: product.id,
                  productName: product.name,
                }
              );
              return product.name;
            }
          } catch (error) {
            logger(
              '[getProductNameFromCharge] Failed to retrieve product from PI metadata.product',
              {
                paymentIntentId: pi.id,
                productRef,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }
      }

      // Check if we have line items in the invoice
      const latestCharge = pi?.latest_charge;
      if (latestCharge && typeof latestCharge === 'object') {
        const invoice = (latestCharge as any).invoice;
        if (invoice && typeof invoice === 'object') {
          const lines = (invoice as any).lines;
          if (lines?.data && Array.isArray(lines.data) && lines.data.length > 0) {
            const firstLine = lines.data[0];
            if (firstLine?.price?.product) {
              const product = firstLine.price.product;
              if (typeof product === 'object' && product.name) {
                logger(
                  '[getProductNameFromCharge] Found product name from payment intent invoice',
                  {
                    paymentIntentId: pi.id,
                    productId: product.id,
                    productName: product.name,
                  }
                );
                return product.name;
              }
            }
          }
        }
      }
    }

    // Check charge metadata for order_reference or product (fallback if no payment intent)
    if (charge.metadata) {
      const orderRef = charge.metadata.order_reference;
      const productRef = charge.metadata.product;

      logger('[getProductNameFromCharge] Checking charge metadata for product', {
        chargeId: charge.id,
        orderRef,
        productRef,
      });

      // Try order_reference first
      if (orderRef && typeof orderRef === 'string' && orderRef.startsWith('prod_')) {
        try {
          const product = await stripe.products.retrieve(orderRef);
          if (product?.name) {
            logger(
              '[getProductNameFromCharge] Found product name from charge metadata.order_reference',
              {
                chargeId: charge.id,
                productId: product.id,
                productName: product.name,
              }
            );
            return product.name;
          }
        } catch (error) {
          logger(
            '[getProductNameFromCharge] Failed to retrieve product from charge metadata.order_reference',
            {
              chargeId: charge.id,
              orderRef,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }

      // Try product metadata
      if (productRef && typeof productRef === 'string' && productRef.startsWith('prod_')) {
        try {
          const product = await stripe.products.retrieve(productRef);
          if (product?.name) {
            logger('[getProductNameFromCharge] Found product name from charge metadata.product', {
              chargeId: charge.id,
              productId: product.id,
              productName: product.name,
            });
            return product.name;
          }
        } catch (error) {
          logger(
            '[getProductNameFromCharge] Failed to retrieve product from charge metadata.product',
            {
              chargeId: charge.id,
              productRef,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }
    }

    logger('[getProductNameFromCharge] No product name found', {
      chargeId: charge.id,
      hasPaymentIntent: !!charge.payment_intent,
      hasChargeMetadata: !!charge.metadata,
    });

    return null;
  } catch (error) {
    logger('[getProductNameFromCharge] Failed to get product name from charge', {
      chargeId: charge.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
};

export const getFrequencyFromSubscription = async (
  stripe: Stripe,
  subscriptionId: string,
  logger: (...args: unknown[]) => void
): Promise<string | null> => {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    if (subscription.items?.data && subscription.items.data.length > 0) {
      const firstItem = subscription.items.data[0];
      if (firstItem.price?.recurring?.interval) {
        const interval = firstItem.price.recurring.interval;
        logger('[getFrequencyFromSubscription] Found frequency from subscription', {
          subscriptionId,
          interval,
        });
        return interval;
      }
    }

    logger('[getFrequencyFromSubscription] No frequency found in subscription', {
      subscriptionId,
      hasItems: !!subscription.items?.data?.length,
    });
    return null;
  } catch (error) {
    logger('[getFrequencyFromSubscription] Failed to retrieve subscription for frequency', {
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};
