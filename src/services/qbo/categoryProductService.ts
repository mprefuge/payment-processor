/**
 * Maps the donation form's **Category** onto the QuickBooks **Product/Service** that the
 * sales-receipt revenue line should carry.
 *
 * Why this exists: the donor picks a Category on the donation form
 * (mprefuge/site-assets `scripts/new-popup-don.js`, `categoryConfig`), the form posts it as
 * `metadata.category` on the Checkout Session, and until now nothing downstream read it when
 * choosing the item. Every receipt therefore landed on the configured default
 * (`QBO_DEFAULT_SALES_ITEM`, "Stripe Transaction"), which is not how the books are kept: a
 * TNND camp payment belongs on "TNND Mission Experience", a corporate sponsorship on
 * "Corporate Sponsor", and so on.
 *
 * ## The table is an allowlist, deliberately
 *
 * A tempting shortcut is to pass the Category through as the item name. Do not: the item
 * resolver (`ensureSalesReceiptItem`) CREATES a missing Product/Service pointed at the generic
 * revenue account, and the form's "Other (specify)" branch puts donor-typed free text into
 * `metadata.category`. Passing that through would let any donor write into the company file's
 * item list, one junk item per typo. Only the exact names below ever reach QuickBooks.
 *
 * ## Editing this table
 *
 * Keys are Categories exactly as the form offers them; values are Product/Service names
 * exactly as they read in QuickBooks. Lookup is case- and whitespace-insensitive, so the key's
 * casing only has to match the form for readability. A Category with no entry here is not an
 * error — it falls through to `QBO_DEFAULT_SALES_ITEM`, which is the pre-existing behaviour.
 */

/** A donation-form Category, normalised for lookup: trimmed, collapsed whitespace, lowercased. */
const normalizeCategory = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Category → QuickBooks Product/Service.
 *
 * Left column: the Category strings in `categoryConfig` in site-assets `new-popup-don.js`
 * (both the `onetime` and `recurring` lists, plus the static `<select>` that seeds the field).
 *
 * Intentionally absent, so they keep falling back to `QBO_DEFAULT_SALES_ITEM` rather than
 * guessing at an item that may not exist in the company file:
 *   - "Ministry Support Dinner"
 *   - "Volunteer Application Payment"
 *   - "Other (specify)" and the donor-typed text it becomes
 * Add them here once the matching QuickBooks item names are confirmed.
 */
export const CATEGORY_PRODUCT_SERVICE_MAP: ReadonlyMap<string, string> = new Map(
  (
    [
      ['General Giving', 'General Giving'],
      ['Immigrant Legal Services Center', 'Immigrant Legal Services'],
      ['TNND Camp Payment', 'TNND Mission Experience'],
      // Cooking and Culture is not tracked separately in QuickBooks; it books to General Giving.
      ['Cooking and Culture Payment', 'General Giving'],
      // The form offers the one-time gift as "Corporate Sponsorship" and the recurring gift as
      // "Corporate Sponsor"; both are the same line of income.
      ['Corporate Sponsorship', 'Corporate Sponsor'],
      ['Corporate Sponsor', 'Corporate Sponsor'],
    ] as const
  ).map(([category, item]) => [normalizeCategory(category), item])
);

/**
 * The Product/Service for `category`, or `null` when the Category is absent, blank, or not in
 * the table. `null` means "no opinion" — the caller keeps whatever it would have used.
 */
export const resolveCategoryProductService = (
  category: string | null | undefined
): string | null => {
  if (typeof category !== 'string') {
    return null;
  }

  const normalized = normalizeCategory(category);
  if (!normalized) {
    return null;
  }

  return CATEGORY_PRODUCT_SERVICE_MAP.get(normalized) ?? null;
};
