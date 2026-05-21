let _counter = 0;
export function createId(prefix = 'id') {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Auto-distribute widths: 1→12, 2→6, 3→4, 4→3, 5+→floor */
export function recalculateColumnWidths(columns) {
  const n = columns.length;
  if (n === 0) return [];
  const base = n <= 4 ? [12, 6, 4, 3][n - 1] : Math.floor(12 / n);
  const remainder = 12 - base * n;
  return columns.map((col, i) => ({
    ...col,
    width: base + (i < remainder ? 1 : 0),
  }));
}

export function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

export function formatMoney(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    const n = Number(amount);
    return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  }
}

export function calculateFee(amount, pct, fixed) {
  return amount * (pct / 100) + fixed;
}

/** Deep clone via JSON */
export function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}
