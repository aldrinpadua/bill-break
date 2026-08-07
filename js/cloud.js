// cloud.js — Phase 2 login + cloud sync (Supabase).
//
// Activated only when js/config.js has MODE:"cloud". It:
//   1. Shows a login screen (Google + magic-link email).
//   2. After login, hydrates a CloudStore from Supabase and swaps it in for the
//      LocalStore, so the rest of the app is unchanged.
//   3. Writes every change through to the relational tables (see supabase/schema.sql).
//
// Self-reference trick: inside the app the current user is always the id "you"
// (so none of the UI code had to change). When talking to Supabase we translate
// "you" <-> the user's real auth id, so a ledger shared between two people has a
// distinct, consistent id for each person.

import { CONFIG } from "./config.js";
import { setStore } from "./store.js";

let supabase = null;
let myId = null;   // auth user id (uuid)
let myEmail = "";

async function getClient() {
  if (supabase) return supabase;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true },
  });
  return supabase;
}

// the app's own URL (used as the invite link)
const appUrl = () => window.location.origin + window.location.pathname;

// ---------- self-reference translation ----------
const mapRef = (r, from, to) => (r === from ? to : r);
function translateExpenseData(data, from, to) {
  const d = JSON.parse(JSON.stringify(data || {}));
  if (Array.isArray(d.paidBy)) d.paidBy.forEach((p) => (p.memberId = mapRef(p.memberId, from, to)));
  if (d.split) {
    if (Array.isArray(d.split.participants)) d.split.participants = d.split.participants.map((x) => mapRef(x, from, to));
    if (Array.isArray(d.split.sharedParticipants)) d.split.sharedParticipants = d.split.sharedParticipants.map((x) => mapRef(x, from, to));
    if (Array.isArray(d.split.items)) d.split.items.forEach((it) => (it.participants = (it.participants || []).map((x) => mapRef(x, from, to))));
  }
  if (d.from) d.from = mapRef(d.from, from, to);
  if (d.to) d.to = mapRef(d.to, from, to);
  return d;
}

// ================= CloudStore =================
// Same public API as LocalStore (js/store.js), backed by Supabase.
// Reads are synchronous (from in-memory `state`, hydrated at login).
// Writes update memory immediately, then persist in the background.
class CloudStore {
  constructor(client) {
    this.sb = client;
    this.state = { version: 1, you: { id: "you", name: "You", email: "" }, people: [], ledgers: [], expenses: [] };
    this.listeners = new Set();
    // my member_ref can differ per ledger: it's my auth id in ledgers I created,
    // but a generated "pending" id in ledgers I was invited to. Track per ledger.
    this.myRefByLedger = {};
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _notify() { this.listeners.forEach((fn) => fn(this.state)); }
  async _try(label, fn) { try { await fn(); } catch (e) { console.error("[cloud] " + label + " failed:", e.message || e); } }
  _myRef(ledgerId) { return this.myRefByLedger[ledgerId] || myId; }

  // ---- initial load ----
  async hydrate() {
    const you = this.state.you;
    // ensure a profile row exists
    await this._try("profile upsert", async () => {
      await this.sb.from("profiles").upsert({ id: myId, display_name: you.name, email: myEmail }, { onConflict: "id" });
      const { data } = await this.sb.from("profiles").select("display_name,email").eq("id", myId).single();
      if (data) { you.name = data.display_name || you.name; you.email = data.email || myEmail; }
    });
    you.email = (you.email || myEmail || "").toLowerCase();

    // Claim any pending invites addressed to my email (sets user_id on rows the
    // inviter created for me before I had an account). Allowed by the
    // "claim own invite" RLS policy in supabase/invites.sql.
    await this._try("claim invites", () => this.sb.from("ledger_members").update({ user_id: myId }).is("user_id", null).ilike("email", myEmail));

    const ledRes = await this.sb.from("ledgers").select("*");
    if (ledRes.error) throw new Error("Loading your groups failed: " + ledRes.error.message);
    const ledgers = ledRes.data || [];
    const ids = ledgers.map((l) => l.id);
    let members = [], expenses = [];
    if (ids.length) {
      members = (await this.sb.from("ledger_members").select("*").in("ledger_id", ids)).data || [];
      expenses = (await this.sb.from("expenses").select("*").in("ledger_id", ids)).data || [];
    }
    // my ref in each ledger = the member row whose user_id is me
    this.myRefByLedger = {};
    for (const l of ledgers) {
      const mine = members.find((m) => m.ledger_id === l.id && m.user_id === myId);
      this.myRefByLedger[l.id] = mine ? mine.member_ref : myId;
    }
    // people = every member that isn't me, deduped by ref
    const myRefs = new Set(Object.values(this.myRefByLedger));
    const peopleMap = new Map();
    for (const m of members) {
      if (m.user_id === myId || myRefs.has(m.member_ref)) continue;
      if (!peopleMap.has(m.member_ref)) peopleMap.set(m.member_ref, { id: m.member_ref, name: m.name, email: m.email || "", userId: m.user_id || null });
    }
    this.state.people = [...peopleMap.values()];
    this.state.ledgers = ledgers.map((l) => {
      const myRef = this.myRefByLedger[l.id];
      return {
        id: l.id, kind: l.kind, name: l.name, baseCurrency: l.base_currency,
        parentId: l.parent_id,
        memberIds: members.filter((m) => m.ledger_id === l.id).map((m) => mapRef(m.member_ref, myRef, "you")),
        reminder: l.reminder || { enabled: false, frequency: "weekly", lastSentAt: null, message: "" },
        createdAt: new Date(l.created_at).getTime(),
      };
    });
    this.state.expenses = expenses.map((e) => ({ id: e.id, ledgerId: e.ledger_id, createdAt: new Date(e.created_at).getTime(), ...translateExpenseData(e.data, this.myRefByLedger[e.ledger_id] || myId, "you") }));
    this._notify();
  }

  // ---- reads (mirror LocalStore) ----
  allMembers() { return [this.state.you, ...this.state.people]; }
  memberById(id) { return this.allMembers().find((m) => m.id === id); }
  ledgers() { return this.state.ledgers; }
  ledgerById(id) { return this.state.ledgers.find((l) => l.id === id); }
  expensesFor(ledgerId) {
    return this.state.expenses.filter((e) => e.ledgerId === ledgerId).sort((a, b) => (b.date || 0) - (a.date || 0) || b.createdAt - a.createdAt);
  }

  // ---- helpers for member rows ----
  _memberRow(ledgerId, ref) {
    if (ref === "you") return { ledger_id: ledgerId, member_ref: this._myRef(ledgerId), name: this.state.you.name, email: (this.state.you.email || myEmail || "").toLowerCase() || null, user_id: myId };
    const p = this.state.people.find((x) => x.id === ref);
    return { ledger_id: ledgerId, member_ref: ref, name: p?.name || "Friend", email: (p?.email || "").toLowerCase() || null, user_id: p?.userId || null };
  }

  // Look up an existing user by email, and add them (instantly) or create a
  // pending invite (they auto-join when they sign up with that email).
  async addMemberByEmail(ledgerId, rawEmail) {
    const email = (rawEmail || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return { status: "error", message: "Enter a valid email address." };
    const l = this.ledgerById(ledgerId);
    if (!l) return { status: "error", message: "Group not found." };
    if (email === (this.state.you.email || myEmail || "").toLowerCase()) return { status: "exists", message: "That's you — you're already in this group." };
    // already a member?
    const dupe = l.memberIds.map((id) => this.memberById(id)).find((m) => m && (m.email || "").toLowerCase() === email);
    if (dupe) return { status: "exists", message: `${dupe.name} is already in this group.` };

    // is it an existing Bill Break user? (secure exact-match lookup)
    let user = null;
    try {
      const { data, error } = await this.sb.rpc("find_member", { p_email: email });
      if (error) throw error;
      user = Array.isArray(data) ? data[0] : data;
    } catch (e) { console.error("[cloud] user lookup failed:", e.message || e); }

    if (user && user.id !== myId) {
      let person = this.state.people.find((p) => p.id === user.id);
      if (!person) { person = { id: user.id, name: user.display_name || email.split("@")[0], email, userId: user.id }; this.state.people.push(person); }
      else { person.userId = user.id; person.email = email; }
      l.memberIds = [...new Set([...l.memberIds, user.id])]; this._notify();
      await this._try("add member", () => this.sb.from("ledger_members").upsert(this._memberRow(ledgerId, user.id), { onConflict: "ledger_id,member_ref" }));
      const emailed = await this._notifyMember("added", email, person.name, l.name);
      return { status: "added", name: person.name, emailed };
    }

    // not a user yet → pending invite
    const ref = crypto.randomUUID();
    const person = { id: ref, name: email.split("@")[0], email, userId: null };
    this.state.people.push(person);
    l.memberIds = [...new Set([...l.memberIds, ref])]; this._notify();
    await this._try("invite", () => this.sb.from("ledger_members").insert(this._memberRow(ledgerId, ref)));
    const emailed = await this._notifyMember("invite", email, person.name, l.name);
    return { status: "invited", email, name: person.name, link: appUrl(), emailed };
  }

  // Fire the notify-member edge function; returns true if the email was sent.
  async _notifyMember(type, email, name, groupName) {
    try {
      const { data, error } = await this.sb.functions.invoke("notify-member", {
        body: { type, email, name, groupName, inviterName: this.state.you.name, link: appUrl() },
      });
      if (error) throw error;
      return data?.ok !== false;
    } catch (e) { console.error("[cloud] notify-member failed:", e.message || e); return false; }
  }

  // ---- people ----
  addPerson({ name, email }) {
    const p = { id: crypto.randomUUID(), name: name.trim(), email: (email || "").trim() };
    this.state.people.push(p); this._notify();
    return p; // persists to DB when added to a ledger
  }
  updatePerson(id, patch) {
    if (id === "you") {
      Object.assign(this.state.you, patch); this._notify();
      this._try("profile update", () => this.sb.from("profiles").update({ display_name: this.state.you.name, email: this.state.you.email }).eq("id", myId));
      this._try("member self update", () => this.sb.from("ledger_members").update({ name: this.state.you.name, email: this.state.you.email }).eq("user_id", myId));
      return;
    }
    const p = this.state.people.find((x) => x.id === id);
    if (p) { Object.assign(p, patch); this._notify(); this._try("member update", () => this.sb.from("ledger_members").update({ name: p.name, email: p.email }).eq("member_ref", id)); }
  }
  removePerson(id) {
    this.state.people = this.state.people.filter((p) => p.id !== id);
    this.state.ledgers.forEach((l) => (l.memberIds = l.memberIds.filter((m) => m !== id)));
    this._notify();
    this._try("member remove", () => this.sb.from("ledger_members").delete().eq("member_ref", id));
  }

  // ---- ledgers ----
  addLedger({ kind, name, baseCurrency = "USD", memberIds = [], parentId = null }) {
    const id = crypto.randomUUID();
    const l = { id, kind, name: name.trim(), baseCurrency, memberIds: [...new Set(["you", ...memberIds])], parentId, reminder: { enabled: false, frequency: "weekly", lastSentAt: null, message: "" }, createdAt: Date.now() };
    this.myRefByLedger[id] = myId; // I created it, so my ref here is my auth id
    this.state.ledgers.push(l); this._notify();
    this._try("ledger insert", async () => {
      await this.sb.from("ledgers").insert({ id, kind, name: l.name, base_currency: baseCurrency, parent_id: parentId, reminder: l.reminder, created_by: myId });
      await this.sb.from("ledger_members").insert(l.memberIds.map((ref) => this._memberRow(id, ref)));
    });
    return l;
  }
  updateLedger(id, patch) {
    const l = this.ledgerById(id); if (!l) return;
    const oldMembers = new Set(l.memberIds);
    Object.assign(l, patch); this._notify();
    this._try("ledger update", async () => {
      await this.sb.from("ledgers").update({ name: l.name, base_currency: l.baseCurrency, parent_id: l.parentId, reminder: l.reminder }).eq("id", id);
      if (patch.memberIds) {
        const now = new Set(l.memberIds);
        const added = [...now].filter((x) => !oldMembers.has(x));
        const removed = [...oldMembers].filter((x) => !now.has(x));
        if (added.length) await this.sb.from("ledger_members").upsert(added.map((ref) => this._memberRow(id, ref)), { onConflict: "ledger_id,member_ref" });
        for (const ref of removed) await this.sb.from("ledger_members").delete().eq("ledger_id", id).eq("member_ref", ref === "you" ? this._myRef(id) : ref);
      }
    });
  }
  removeLedger(id) {
    this.state.ledgers = this.state.ledgers.filter((l) => l.id !== id && l.parentId !== id);
    this.state.expenses = this.state.expenses.filter((e) => e.ledgerId !== id);
    this._notify();
    this._try("ledger delete", () => this.sb.from("ledgers").delete().eq("id", id)); // cascades members + expenses
  }

  // ---- expenses ----
  addExpense(exp) {
    const id = crypto.randomUUID();
    const e = { id, createdAt: Date.now(), ...exp };
    this.state.expenses.push(e); this._notify();
    const { ledgerId, ...rest } = e; const { id: _i, ...data } = rest;
    this._try("expense insert", () => this.sb.from("expenses").insert({ id, ledger_id: ledgerId, data: translateExpenseData(data, "you", this._myRef(ledgerId)), created_by: myId }));
    return e;
  }
  updateExpense(id, patch) {
    const e = this.state.expenses.find((x) => x.id === id); if (!e) return;
    Object.assign(e, patch); this._notify();
    const { ledgerId, id: _i, createdAt, ...data } = e;
    this._try("expense update", () => this.sb.from("expenses").update({ data: translateExpenseData(data, "you", this._myRef(ledgerId)) }).eq("id", id));
  }
  removeExpense(id) {
    this.state.expenses = this.state.expenses.filter((e) => e.id !== id); this._notify();
    this._try("expense delete", () => this.sb.from("expenses").delete().eq("id", id));
  }

  exportJSON() { return JSON.stringify(this.state, null, 2); }
  importJSON() { throw new Error("Import isn't available in cloud mode — data already lives in your Supabase project."); }
  reset() { throw new Error("Erase-all is disabled in cloud mode. Delete ledgers individually, or drop the tables in Supabase."); }
}

// ================= login screen =================
function loginScreen(onGoogle, onMagic) {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand"><span style="font-size:40px">🧾</span><h1>Bill Break</h1><p>Split trips & bills with friends.</p></div>
        <button class="btn google-btn" id="gBtn">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.5 0 20-7.6 20-21 0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 16 3 9.1 7.6 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.5 26.7 36 24 36c-5.3 0-9.7-2.6-11.3-6.9l-6.5 5C9.1 40.4 16 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.3 5.3C41.6 36.6 44 31 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>
          Continue with Google
        </button>
        <div class="login-or"><span>or</span></div>
        <label>Email — we'll send you a magic sign-in link</label>
        <input id="mEmail" type="email" placeholder="you@example.com" autocomplete="email">
        <button class="btn" id="mBtn" style="width:100%;margin-top:10px">Send magic link</button>
        <div id="loginMsg" class="login-msg"></div>
      </div>
    </div>`;
  document.getElementById("gBtn").onclick = onGoogle;
  document.getElementById("mBtn").onclick = () => {
    const email = document.getElementById("mEmail").value.trim();
    if (!email) { document.getElementById("loginMsg").textContent = "Enter your email first."; return; }
    onMagic(email);
  };
}
function loginMsg(text, ok) { const el = document.getElementById("loginMsg"); if (el) { el.textContent = text; el.className = "login-msg " + (ok ? "ok" : "err"); } }

// ================= boot entry =================
// Returns true when authenticated + hydrated (app should render), false when the
// login screen is showing (app should NOT render).
export async function startCloud() {
  const sb = await getClient();
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    loginScreen(
      async () => {
        loginMsg("Redirecting to Google…", true);
        await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href.split("#")[0] } });
      },
      async (email) => {
        loginMsg("Sending link…", true);
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split("#")[0] } });
        loginMsg(error ? ("Couldn't send: " + error.message) : "✅ Check your inbox for the sign-in link, then come back here.", !error);
      }
    );
    // when auth completes (magic link click / OAuth return) reload to re-run boot
    sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_IN") window.location.reload(); });
    return false;
  }

  myId = session.user.id;
  myEmail = session.user.email || "";
  const store = new CloudStore(sb);
  store.state.you.name = session.user.user_metadata?.full_name || session.user.user_metadata?.name || (myEmail ? myEmail.split("@")[0] : "You");
  store.state.you.email = myEmail;
  setStore(store);
  await store.hydrate();
  return true;
}

export async function signOut() {
  const sb = await getClient();
  await sb.auth.signOut();
  window.location.reload();
}
