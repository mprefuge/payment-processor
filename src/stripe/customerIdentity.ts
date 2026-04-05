export const trimToNull = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const normalizeName = (value: string | null | undefined): string | null => {
  const trimmed = trimToNull(value);
  return trimmed ? trimmed.toLowerCase() : null;
};

export const buildFullName = (
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string | null => {
  const trimmedFirstName = trimToNull(firstName);
  const trimmedLastName = trimToNull(lastName);

  if (trimmedFirstName && trimmedLastName) {
    return `${trimmedFirstName} ${trimmedLastName}`;
  }

  return trimmedFirstName || trimmedLastName || null;
};

export const filterCustomersByExactName = <T extends { name?: string | null }>(
  customers: T[],
  fullName: string | null | undefined
): T[] => {
  const normalizedSearchName = normalizeName(fullName);
  if (!normalizedSearchName) {
    return [];
  }

  return customers.filter(
    (customer) => normalizeName(customer?.name ?? null) === normalizedSearchName
  );
};
