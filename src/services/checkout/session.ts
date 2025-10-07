import Stripe from "stripe";
import { z } from "zod";

type BuildSessionParamsOptions = {
  successUrl: string;
  cancelUrl: string;
};

const AddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postal_code: z.string().min(1),
  country: z
    .string()
    .min(2)
    .max(2)
    .transform((value) => value.toUpperCase()),
});

export const CheckoutRequestSchema = z
  .object({
    transactionType: z.string().min(1),
    email: z.string().email(),
    firstname: z.string().min(1),
    lastname: z.string().min(1),
    phone: z.string().min(1).optional(),
    amount: z.number().int().positive(),
    frequency: z.string().min(1).default("onetime"),
    category: z.string().min(1).optional(),
    coverFee: z.boolean().optional().default(false),
    address: AddressSchema.optional(),
    currency: z
      .string()
      .min(1)
      .default("usd")
      .transform((value) => value.toLowerCase()),
  })
  .passthrough();

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

const buildMetadata = (input: CheckoutRequest): Record<string, string> => {
  const metadata: Record<string, string> = {
    transactionType: input.transactionType,
    firstname: input.firstname,
    lastname: input.lastname,
    frequency: input.frequency,
    coverFee: String(Boolean(input.coverFee)),
    amount: String(input.amount),
    currency: input.currency,
  };

  if (input.category) {
    metadata.category = input.category;
  }

  if (input.phone) {
    metadata.phone = input.phone;
  }

  if (input.address) {
    metadata.address_line1 = input.address.line1;
    if (input.address.line2) {
      metadata.address_line2 = input.address.line2;
    }
    metadata.address_city = input.address.city;
    metadata.address_state = input.address.state;
    metadata.address_postal_code = input.address.postal_code;
    metadata.address_country = input.address.country;
  }

  return metadata;
};

const buildProductName = (input: CheckoutRequest): string => {
  const base = input.transactionType;
  if (input.category) {
    return `${base} - ${input.category}`;
  }
  return base;
};

export const buildCheckoutSessionParams = (
  input: CheckoutRequest,
  options: BuildSessionParamsOptions,
): Stripe.Checkout.SessionCreateParams => {
  const metadata = buildMetadata(input);

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    customer_email: input.email,
    customer_creation: "if_required",
    billing_address_collection: input.address ? "required" : "auto",
    phone_number_collection: { enabled: !input.phone },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency,
          unit_amount: input.amount,
          product_data: {
            name: buildProductName(input),
            metadata,
          },
        },
      },
    ],
    metadata,
    payment_intent_data: {
      metadata,
      receipt_email: input.email,
    },
  };

  if (input.phone) {
    sessionParams.payment_intent_data = {
      ...sessionParams.payment_intent_data,
      metadata: {
        ...sessionParams.payment_intent_data?.metadata,
        phone: input.phone,
      },
    };
  }

  return sessionParams;
};

export type StripeCheckoutSessionsClient = Pick<
  Stripe.Checkout.SessionsResource,
  "create"
>;

export const createCheckoutSession = async (
  input: CheckoutRequest,
  options: BuildSessionParamsOptions,
  stripe: StripeCheckoutSessionsClient,
) => {
  const params = buildCheckoutSessionParams(input, options);
  return stripe.create(params);
};
