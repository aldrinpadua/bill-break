// Bill Break — reminder email sender (Supabase Edge Function, Deno).
//
// What it does, each time it runs (see ../schedule.sql for the cron that runs it):
//   1. Loads every ledger with reminder.enabled = true.
//   2. Skips ledgers not yet "due" based on their frequency + reminder.lastSentAt.
//   3. Computes balances + smart settle-up for each due ledger.
//   4. Emails every member who OWES money and has an email on file.
//   5. Stamps reminder.lastSentAt so it isn't sent again until the next cycle.
//
// Secrets it needs (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (provided automatically)
//   RESEND_API_KEY   — from resend.com
//   FROM_EMAIL       — a verified sender, e.g. "Bill Break <reminders@yourdomain.com>"
//                      (or "onboarding@resend.dev" while testing)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FREQ_DAYS: Record<string, number> = { daily: 1, every3: 3, weekly: 7, biweekly: 14, monthly: 30 };

const CUR_DIGITS: Record<string, number> = { JPY: 0, KRW: 0 };
const digits = (c: string) => (c in CUR_DIGITS ? CUR_DIGITS[c] : 2);
const factor = (c: string) => Math.pow(10, digits(c));
const toMajor = (m: number, c: string) => m / factor(c);
function fmt(minor: number, c: string) {
  const v = minor / factor(c);
  return `${v < 0 ? "-" : ""}${c} ${Math.abs(v).toFixed(digits(c))}`;
}

// ---- split math (compact port of js/split.js) ------------------------------
function splitEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.trunc(total / n);
  let rem = total - base * n;
  const out = new Array(n).fill(base);
  const step = rem >= 0 ? 1 : -1;
  rem = Math.abs(rem);
  for (let i = 0; i < rem; i++) out[i] += step;
  return out;
}
function splitByWeights(total: number, weights: number[]): number[] {
  const tw = weights.reduce((a, b) => a + b, 0);
  if (tw === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / tw);
  const floors = raw.map((x) => Math.floor(x));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f);
  const out = floors.slice();
  let k = 0;
  while (left-- > 0) { out[order[k % order.length].i]++; k++; }
  return out;
}
function computeOwed(e: any): Map<string, number> {
  const owed = new Map<string, number>();
  const add = (id: string, a: number) => owed.set(id, (owed.get(id) || 0) + a);
  const s = e.split || {};
  if (s.type === "items") {
    const appeared = new Set<string>();
    for (const it of s.items || []) {
      const parts = it.participants || [];
      splitEvenly(it.amountMinor, parts.length).forEach((v: number, i: number) => { add(parts[i], v); appeared.add(parts[i]); });
    }
    if (s.sharedMinor) {
      const pool = (s.sharedParticipants?.length ? s.sharedParticipants : [...appeared]);
      splitEvenly(s.sharedMinor, pool.length).forEach((v: number, i: number) => add(pool[i], v));
    }
    return owed;
  }
  const parts = s.participants || [];
  if (!parts.length) return owed;
  if (s.type === "exact") parts.forEach((id: string, i: number) => add(id, (s.amounts || [])[i] || 0));
  else if (s.type === "percent" || s.type === "shares") splitByWeights(e.amountMinor, parts.map((_: any, i: number) => (s.weights || [])[i] || 0)).forEach((v, i) => add(parts[i], v));
  else splitEvenly(e.amountMinor, parts.length).forEach((v, i) => add(parts[i], v));
  return owed;
}
function computePaid(e: any): Map<string, number> {
  const paid = new Map<string, number>();
  for (const p of e.paidBy || []) paid.set(p.memberId, (paid.get(p.memberId) || 0) + p.amountMinor);
  return paid;
}
function computeBalances(expenses: any[], base: string): Map<string, number> {
  const major = new Map<string, number>();
  for (const e of expenses) {
    if (e.settlement) continue;
    const cur = e.currency || base, fx = typeof e.fxToBase === "number" ? e.fxToBase : 1;
    const owed = computeOwed(e), paid = computePaid(e);
    for (const id of new Set([...owed.keys(), ...paid.keys()])) {
      const net = (paid.get(id) || 0) - (owed.get(id) || 0);
      major.set(id, (major.get(id) || 0) + toMajor(net, cur) * fx);
    }
  }
  for (const e of expenses) {
    if (!e.settlement) continue;
    const cur = e.currency || base, fx = typeof e.fxToBase === "number" ? e.fxToBase : 1;
    const amt = toMajor(e.amountMinor, cur) * fx;
    major.set(e.from, (major.get(e.from) || 0) + amt);
    major.set(e.to, (major.get(e.to) || 0) - amt);
  }
  const out = new Map<string, number>();
  for (const [id, v] of major) out.set(id, Math.round(v * factor(base)));
  return out;
}
function settleUp(net: Map<string, number>) {
  const cred: any[] = [], deb: any[] = [];
  for (const [id, n] of net) { if (n > 0) cred.push({ id, amt: n }); else if (n < 0) deb.push({ id, amt: -n }); }
  cred.sort((a, b) => b.amt - a.amt); deb.sort((a, b) => b.amt - a.amt);
  const tx: any[] = []; let ci = 0, di = 0;
  while (ci < cred.length && di < deb.length) {
    const c = cred[ci], d = deb[di], pay = Math.min(c.amt, d.amt);
    if (pay > 0) tx.push({ from: d.id, to: c.id, amountMinor: pay });
    c.amt -= pay; d.amt -= pay;
    if (!c.amt) ci++; if (!d.amt) di++;
  }
  return tx;
}

async function sendEmail(to: string, subject: string, text: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("FROM_EMAIL") || "onboarding@resend.dev", to, subject, text }),
  });
  if (!res.ok) console.error("Resend error", await res.text());
  return res.ok;
}

Deno.serve(async () => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = Date.now();
  let sent = 0;

  const { data: ledgers, error } = await supabase.from("ledgers").select("*").eq("reminder->>enabled", "true");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  for (const l of ledgers || []) {
    const freqDays = FREQ_DAYS[l.reminder?.frequency] ?? 7;
    const last = l.reminder?.lastSentAt ? new Date(l.reminder.lastSentAt).getTime() : 0;
    if (now - last < freqDays * 86400_000) continue; // not due yet

    const { data: members } = await supabase.from("ledger_members").select("*").eq("ledger_id", l.id);
    const { data: exps } = await supabase.from("expenses").select("data").eq("ledger_id", l.id);
    const expenses = (exps || []).map((r: any) => r.data);
    const balances = computeBalances(expenses, l.base_currency);
    const transfers = settleUp(balances);
    const nameOf = (ref: string) => members?.find((m: any) => m.member_ref === ref)?.name || "someone";

    for (const m of members || []) {
      const net = balances.get(m.member_ref) || 0;
      if (net >= 0 || !m.email) continue; // only people who owe, and have an email
      const owedList = transfers.filter((t) => t.from === m.member_ref);
      const total = owedList.reduce((a, t) => a + t.amountMinor, 0);
      const lines = owedList.map((t) => `  • Pay ${nameOf(t.to)}: ${fmt(t.amountMinor, l.base_currency)}`).join("\n");
      const custom = l.reminder?.message ? l.reminder.message + "\n\n" : "";
      const body = `Hi ${m.name},\n\n${custom}Friendly reminder about "${l.name}". You currently owe ${fmt(total, l.base_currency)}:\n\n${lines}\n\nThanks!\n— sent via Bill Break`;
      if (await sendEmail(m.email, `Reminder: you owe ${fmt(total, l.base_currency)} for "${l.name}"`, body)) sent++;
    }

    await supabase.from("ledgers").update({ reminder: { ...l.reminder, lastSentAt: new Date().toISOString() } }).eq("id", l.id);
  }

  return new Response(JSON.stringify({ ok: true, ledgers: ledgers?.length || 0, emailsSent: sent }), { headers: { "Content-Type": "application/json" } });
});
