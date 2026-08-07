// money.js — currency helpers and cent-accurate math.
// All internal amounts are stored as integer minor units (e.g. cents) to avoid
// floating-point drift. Display converts back to major units.

export const CURRENCIES = {
  USD: { symbol: "$", digits: 2, name: "US Dollar" },
  EUR: { symbol: "€", digits: 2, name: "Euro" },
  GBP: { symbol: "£", digits: 2, name: "British Pound" },
  JPY: { symbol: "¥", digits: 0, name: "Japanese Yen" },
  CAD: { symbol: "C$", digits: 2, name: "Canadian Dollar" },
  AUD: { symbol: "A$", digits: 2, name: "Australian Dollar" },
  INR: { symbol: "₹", digits: 2, name: "Indian Rupee" },
  MXN: { symbol: "MX$", digits: 2, name: "Mexican Peso" },
  BRL: { symbol: "R$", digits: 2, name: "Brazilian Real" },
  CHF: { symbol: "CHF ", digits: 2, name: "Swiss Franc" },
  CNY: { symbol: "¥", digits: 2, name: "Chinese Yuan" },
  KRW: { symbol: "₩", digits: 0, name: "South Korean Won" },
  THB: { symbol: "฿", digits: 2, name: "Thai Baht" },
  SGD: { symbol: "S$", digits: 2, name: "Singapore Dollar" },
  PHP: { symbol: "₱", digits: 2, name: "Philippine Peso" },
};

export function currencyDigits(code) {
  return (CURRENCIES[code] || CURRENCIES.USD).digits;
}

export function currencyFactor(code) {
  return Math.pow(10, currencyDigits(code));
}

// Parse a user-typed major-unit amount ("12.34") into integer minor units.
export function toMinor(amountMajor, code) {
  const factor = currencyFactor(code);
  const n = typeof amountMajor === "number" ? amountMajor : parseFloat(String(amountMajor).replace(/[^0-9.\-]/g, ""));
  if (!isFinite(n)) return 0;
  return Math.round(n * factor);
}

// Convert integer minor units back to a major-unit number.
export function toMajor(amountMinor, code) {
  return amountMinor / currencyFactor(code);
}

// Format integer minor units for display, e.g. 1234 USD -> "$12.34".
export function formatMoney(amountMinor, code = "USD") {
  const c = CURRENCIES[code] || CURRENCIES.USD;
  const value = amountMinor / Math.pow(10, c.digits);
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: c.digits,
    maximumFractionDigits: c.digits,
  });
  const sign = amountMinor < 0 ? "-" : "";
  return `${sign}${c.symbol}${abs}`;
}

// Split an integer total into n parts as evenly as possible, distributing the
// leftover minor units (the remainder) one-per-part to the first recipients so
// the parts always sum EXACTLY back to the total. Returns an array of ints.
export function splitEvenly(totalMinor, n) {
  if (n <= 0) return [];
  const base = Math.trunc(totalMinor / n);
  let remainder = totalMinor - base * n; // can be negative if total is negative
  const out = new Array(n).fill(base);
  const step = remainder >= 0 ? 1 : -1;
  remainder = Math.abs(remainder);
  for (let i = 0; i < remainder; i++) out[i] += step;
  return out;
}

// Split by weights (shares or percentages). weights is an array of numbers.
// Uses largest-remainder method so the parts sum exactly to totalMinor.
export function splitByWeights(totalMinor, weights) {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalMinor * w) / totalWeight);
  const floors = raw.map((x) => Math.floor(x));
  let allocated = floors.reduce((a, b) => a + b, 0);
  let leftover = totalMinor - allocated;
  // distribute leftover to the largest fractional remainders
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  const out = floors.slice();
  let k = 0;
  while (leftover > 0 && order.length) {
    out[order[k % order.length].i] += 1;
    leftover -= 1;
    k += 1;
  }
  return out;
}
