// split.js — the core money engine: how a single expense is divided, how
// balances accumulate across many expenses/currencies, and how to settle up
// with the fewest possible payments.
import { splitEvenly, splitByWeights, toMajor, toMinor, currencyFactor } from "./money.js";

// ---- Per-expense: how much each participant OWES for one expense --------------
// Returns a Map<memberId, owedMinor> in the expense's own currency.
// Handles split types: equal, exact, percent, shares, items.
export function computeOwed(expense) {
  const owed = new Map();
  const add = (id, amt) => owed.set(id, (owed.get(id) || 0) + amt);
  const s = expense.split || { type: "equal", participants: [] };

  if (s.type === "items") {
    // Each item is split equally among its own participants. A shared pool
    // (tax, tip, fees) is split among everyone who appears on any item, or an
    // explicit sharedParticipants list.
    const appeared = new Set();
    for (const item of s.items || []) {
      const parts = item.participants || [];
      const shares = splitEvenly(item.amountMinor, parts.length);
      parts.forEach((id, i) => { add(id, shares[i]); appeared.add(id); });
    }
    const sharedTotal = s.sharedMinor || 0;
    if (sharedTotal) {
      const pool = (s.sharedParticipants && s.sharedParticipants.length)
        ? s.sharedParticipants
        : [...appeared];
      const shares = splitEvenly(sharedTotal, pool.length);
      pool.forEach((id, i) => add(id, shares[i]));
    }
    return owed;
  }

  const parts = s.participants || [];
  if (parts.length === 0) return owed;

  if (s.type === "exact") {
    // s.amounts: array of minor amounts aligned to participants
    parts.forEach((id, i) => add(id, (s.amounts || [])[i] || 0));
  } else if (s.type === "percent" || s.type === "shares") {
    const weights = parts.map((_, i) => (s.weights || [])[i] || 0);
    const shares = splitByWeights(expense.amountMinor, weights);
    parts.forEach((id, i) => add(id, shares[i]));
  } else {
    // equal
    const shares = splitEvenly(expense.amountMinor, parts.length);
    parts.forEach((id, i) => add(id, shares[i]));
  }
  return owed;
}

// Who PAID the expense. Supports one or multiple payers.
// Returns Map<memberId, paidMinor> in the expense's own currency.
export function computePaid(expense) {
  const paid = new Map();
  if (Array.isArray(expense.paidBy)) {
    for (const p of expense.paidBy) paid.set(p.memberId, (paid.get(p.memberId) || 0) + p.amountMinor);
  } else if (expense.paidBy) {
    paid.set(expense.paidBy, expense.amountMinor);
  }
  return paid;
}

// Sanity check that an expense's parts sum to its total.
export function validateExpense(expense) {
  const errors = [];
  const owed = computeOwed(expense);
  const owedTotal = [...owed.values()].reduce((a, b) => a + b, 0);
  const paid = computePaid(expense);
  const paidTotal = [...paid.values()].reduce((a, b) => a + b, 0);
  if (expense.split?.type === "items") {
    const itemsTotal = (expense.split.items || []).reduce((a, it) => a + it.amountMinor, 0) + (expense.split.sharedMinor || 0);
    if (itemsTotal !== expense.amountMinor) errors.push(`Items + shared (${itemsTotal}) ≠ total (${expense.amountMinor}).`);
  } else if (owedTotal !== expense.amountMinor) {
    errors.push(`Split shares (${owedTotal}) ≠ total (${expense.amountMinor}).`);
  }
  if (paidTotal !== expense.amountMinor) errors.push(`Paid amounts (${paidTotal}) ≠ total (${expense.amountMinor}).`);
  return errors;
}

// ---- Across many expenses: net balance per member ----------------------------
// Each expense may be in its own currency with an fx multiplier (major-unit)
// to the group's base currency. Net is accumulated in base currency.
// Returns { base: Map<memberId, netMinorBase>, perCurrency: {cur: Map<id,netMinor>} }
// A positive net means the member is owed money; negative means they owe.
export function computeBalances(expenses, baseCurrency = "USD") {
  const perCurrency = {};
  const baseMajor = new Map(); // accumulate as float in base major units
  const baseFactor = currencyFactor(baseCurrency);

  for (const e of expenses) {
    if (e.settlement) continue; // settlements handled below
    const cur = e.currency || baseCurrency;
    const fx = typeof e.fxToBase === "number" ? e.fxToBase : 1;
    const owed = computeOwed(e);
    const paid = computePaid(e);
    perCurrency[cur] = perCurrency[cur] || new Map();
    const ids = new Set([...owed.keys(), ...paid.keys()]);
    for (const id of ids) {
      const netMinor = (paid.get(id) || 0) - (owed.get(id) || 0);
      perCurrency[cur].set(id, (perCurrency[cur].get(id) || 0) + netMinor);
      const netMajorBase = toMajor(netMinor, cur) * fx;
      baseMajor.set(id, (baseMajor.get(id) || 0) + netMajorBase);
    }
  }

  // Apply recorded settlements (payments) directly in base currency.
  for (const e of expenses) {
    if (!e.settlement) continue;
    const cur = e.currency || baseCurrency;
    const fx = typeof e.fxToBase === "number" ? e.fxToBase : 1;
    const amtBase = toMajor(e.amountMinor, cur) * fx;
    // payer paid the receiver: payer's balance goes up, receiver's down
    baseMajor.set(e.from, (baseMajor.get(e.from) || 0) + amtBase);
    baseMajor.set(e.to, (baseMajor.get(e.to) || 0) - amtBase);
  }

  const base = new Map();
  for (const [id, major] of baseMajor) base.set(id, Math.round(major * baseFactor));
  return { base, perCurrency };
}

// ---- Settle up: minimize the number of payments -----------------------------
// Input: Map<memberId, netMinor> (positive = is owed, negative = owes).
// Greedy min-cash-flow: repeatedly match the biggest creditor with the biggest
// debtor. Produces a near-minimal set of transfers that clears all balances.
export function settleUp(netByMember) {
  const creditors = []; // {id, amt>0}
  const debtors = [];   // {id, amt>0} (amount they owe)
  for (const [id, net] of netByMember) {
    if (net > 0) creditors.push({ id, amt: net });
    else if (net < 0) debtors.push({ id, amt: -net });
  }
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci], d = debtors[di];
    const pay = Math.min(c.amt, d.amt);
    if (pay > 0) transfers.push({ from: d.id, to: c.id, amountMinor: pay });
    c.amt -= pay;
    d.amt -= pay;
    if (c.amt === 0) ci++;
    if (d.amt === 0) di++;
  }
  return transfers;
}
