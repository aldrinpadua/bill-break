// app.js — UI controller for Bill Break.
import { store } from "./store.js";
import { CURRENCIES, formatMoney, toMinor, toMajor, currencyFactor } from "./money.js";
import { computeOwed, computePaid, computeBalances, settleUp, validateExpense } from "./split.js";

const CATEGORIES = {
  general: "🧾", food: "🍽️", groceries: "🛒", drinks: "🍺", lodging: "🏨",
  transport: "🚕", flights: "✈️", fuel: "⛽", tickets: "🎟️", shopping: "🛍️",
  fun: "🎉", gifts: "🎁", medical: "💊", settle: "✅",
};
const FREQ = { daily: "Every day", every3: "Every 3 days", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };

let view = { type: "dashboard", ledgerId: null, tab: "expenses" };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) => (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const kindLabel = { group: "Group", trip: "Trip", individual: "Friend" };
const kindIcon = { group: "👨‍👩‍👧", trip: "🧳", individual: "🧍" };

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- sidebar ----------
function youNet() {
  // aggregate "you" net across all ledgers, in each ledger's base currency
  const byCur = {};
  for (const l of store.ledgers()) {
    const { base } = computeBalances(store.expensesFor(l.id), l.baseCurrency);
    const n = base.get("you") || 0;
    byCur[l.baseCurrency] = (byCur[l.baseCurrency] || 0) + n;
  }
  return byCur;
}

function renderSidebar() {
  const you = store.state.you;
  const nets = youNet();
  const netStr = Object.keys(nets).length
    ? Object.entries(nets).filter(([, v]) => v !== 0).map(([c, v]) => `<span class="${v >= 0 ? "pos" : "neg"}">${v >= 0 ? "owed " : "owe "}${formatMoney(Math.abs(v), c)}</span>`).join(" · ") || "all settled up ✨"
    : "no activity yet";
  $("#youCard").innerHTML = `
    <div style="display:flex;align-items:center;gap:9px">
      <div class="avatar">${esc(initials(you.name))}</div>
      <div><div style="font-weight:600">${esc(you.name)}${you.email ? "" : ' <span class="tag">add email</span>'}</div>
      <div class="you-net">${netStr}</div></div>
    </div>`;
  $("#youCard").onclick = () => openPersonModal("you");

  const groups = store.ledgers().filter((l) => l.kind === "group");
  const trips = store.ledgers().filter((l) => l.kind === "trip");
  const indiv = store.ledgers().filter((l) => l.kind === "individual");
  fillList("#groupList", groups);
  fillList("#tripList", trips);
  fillList("#indivList", indiv);

  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", view.type === "dashboard" && b.dataset.view === "dashboard"));
}

function fillList(sel, ledgers) {
  const el = $(sel);
  if (!ledgers.length) { el.innerHTML = `<div class="empty">none yet</div>`; return; }
  el.innerHTML = ledgers.map((l) => {
    const { base } = computeBalances(store.expensesFor(l.id), l.baseCurrency);
    const n = base.get("you") || 0;
    const badge = n === 0 ? "" : `<span class="badge ${n > 0 ? "owed" : "owe"}">${n > 0 ? "+" : ""}${formatMoney(n, l.baseCurrency)}</span>`;
    const parent = l.parentId ? store.ledgerById(l.parentId) : null;
    const sub = parent ? ` <span class="tag">${esc(parent.name)}</span>` : "";
    return `<button data-ledger="${l.id}" class="${view.ledgerId === l.id ? "active" : ""}">${kindIcon[l.kind]} <span>${esc(l.name)}</span>${badge}</button>`;
  }).join("");
  el.querySelectorAll("[data-ledger]").forEach((b) => b.onclick = () => { view = { type: "ledger", ledgerId: b.dataset.ledger, tab: "expenses" }; render(); });
}

// ---------- dashboard ----------
function renderDashboard() {
  const main = $("#main");
  const ledgers = store.ledgers();
  const nets = youNet();
  const owed = Object.entries(nets).filter(([, v]) => v > 0);
  const owe = Object.entries(nets).filter(([, v]) => v < 0);
  const fmtSum = (arr) => arr.length ? arr.map(([c, v]) => formatMoney(Math.abs(v), c)).join(" · ") : formatMoney(0);

  main.innerHTML = `
    ${mobileBar()}
    <div class="page-head">
      <div><h1 class="page-title">🏠 Dashboard</h1><p class="page-sub">Everything you're splitting, in one place.</p></div>
      <button class="btn" id="quickAdd">＋ Add expense</button>
    </div>
    <div class="grid cards-3" style="margin-top:14px">
      <div class="card stat"><div class="label">You are owed</div><div class="value pos">${fmtSum(owed)}</div></div>
      <div class="card stat"><div class="label">You owe</div><div class="value neg">${fmtSum(owe)}</div></div>
      <div class="card stat"><div class="label">Active ledgers</div><div class="value">${ledgers.length}</div></div>
    </div>
    <h3 style="margin:26px 0 10px">Your groups, trips & friends</h3>
    <div id="dashList"></div>`;

  const list = $("#dashList");
  if (!ledgers.length) {
    list.innerHTML = emptyState("🧳", "Nothing here yet", "Create a group for your friend circle, a trip for your next getaway, or a 1:1 ledger with one friend.",
      `<div class="row" style="max-width:420px;margin:14px auto 0">
        <button class="btn" data-new="trip">🧳 New trip</button>
        <button class="btn ghost" data-new="group">👨‍👩‍👧 New group</button>
      </div>`);
  } else {
    list.innerHTML = ledgers.map((l) => {
      const { base } = computeBalances(store.expensesFor(l.id), l.baseCurrency);
      const n = base.get("you") || 0;
      const count = store.expensesFor(l.id).filter((e) => !e.settlement).length;
      return `<div class="exp-row" data-ledger="${l.id}" style="cursor:pointer">
        <div class="exp-cat">${kindIcon[l.kind]}</div>
        <div class="exp-main"><div class="exp-desc">${esc(l.name)}</div>
          <div class="exp-meta">${kindLabel[l.kind]} · ${l.memberIds.length} people · ${count} expense${count === 1 ? "" : "s"} · ${l.baseCurrency}</div></div>
        <div class="exp-amt"><div class="${n >= 0 ? "pos" : "neg"}">${n === 0 ? "settled" : (n > 0 ? "you're owed " : "you owe ") + formatMoney(Math.abs(n), l.baseCurrency)}</div></div>
      </div>`;
    }).join("");
    list.querySelectorAll("[data-ledger]").forEach((b) => b.onclick = () => { view = { type: "ledger", ledgerId: b.dataset.ledger, tab: "expenses" }; render(); });
  }
  main.querySelectorAll("[data-new]").forEach((b) => b.onclick = () => openLedgerModal(b.dataset.new));
  $("#quickAdd").onclick = () => { if (!ledgers.length) return toast("Create a trip or group first."); openExpenseModal(ledgers[0].id); };
  wireMobile();
}

// ---------- ledger view ----------
function renderLedger() {
  const l = store.ledgerById(view.ledgerId);
  if (!l) { view = { type: "dashboard" }; return render(); }
  const main = $("#main");
  const tabs = ["expenses", "balances", "settle", "reminders", "members", "settings"];
  const tabLabel = { expenses: "Expenses", balances: "Balances", settle: "Settle up", reminders: "Reminders", members: "Members", settings: "Settings" };
  const parent = l.parentId ? store.ledgerById(l.parentId) : null;

  main.innerHTML = `
    ${mobileBar()}
    <div class="page-head">
      <div>
        <h1 class="page-title">${kindIcon[l.kind]} ${esc(l.name)}</h1>
        <p class="page-sub">${kindLabel[l.kind]}${parent ? " in " + esc(parent.name) : ""} · base currency ${l.baseCurrency} · ${l.memberIds.length} people</p>
      </div>
      <button class="btn" id="addExp">＋ Add expense</button>
    </div>
    <div class="tabs">${tabs.map((t) => `<button class="tab ${view.tab === t ? "active" : ""}" data-tab="${t}">${tabLabel[t]}</button>`).join("")}</div>
    <div id="tabBody"></div>`;

  $("#addExp").onclick = () => openExpenseModal(l.id);
  main.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { view.tab = b.dataset.tab; renderLedger(); });

  const body = $("#tabBody");
  if (view.tab === "expenses") renderExpenses(body, l);
  else if (view.tab === "balances") renderBalances(body, l);
  else if (view.tab === "settle") renderSettle(body, l);
  else if (view.tab === "reminders") renderReminders(body, l);
  else if (view.tab === "members") renderMembers(body, l);
  else if (view.tab === "settings") renderSettings(body, l);
  wireMobile();
}

function renderExpenses(body, l) {
  const exps = store.expensesFor(l.id);
  if (!exps.length) { body.innerHTML = emptyState("🧾", "No expenses yet", "Add the first bill — dinner, the hotel, the rental car — and Bill Break figures out who owes what."); return; }
  body.innerHTML = exps.map((e) => {
    if (e.settlement) {
      const from = store.memberById(e.from), to = store.memberById(e.to);
      return `<div class="exp-row"><div class="exp-cat">✅</div>
        <div class="exp-main"><div class="exp-desc">${esc(from?.name)} paid ${esc(to?.name)}</div>
        <div class="exp-meta">Settlement · ${new Date(e.date || e.createdAt).toLocaleDateString()}</div></div>
        <div class="exp-amt"><div>${formatMoney(e.amountMinor, e.currency)}</div></div>
        <div class="exp-actions"><button class="icon-btn" data-del="${e.id}" title="Delete">🗑️</button></div></div>`;
    }
    const owed = computeOwed(e);
    const paid = computePaid(e);
    const yourNet = (paid.get("you") || 0) - (owed.get("you") || 0);
    const payers = [...paid.keys()].map((id) => store.memberById(id)?.name).filter(Boolean);
    const receipt = e.receipt ? `<img src="${e.receipt}" class="receipt-thumb" data-receipt="${e.id}" title="View receipt">` : "";
    return `<div class="exp-row">
      <div class="exp-cat">${CATEGORIES[e.category] || "🧾"}</div>
      <div class="exp-main">
        <div class="exp-desc">${esc(e.description || "Expense")}</div>
        <div class="exp-meta">${esc(payers.join(", ") || "?")} paid · ${new Date(e.date || e.createdAt).toLocaleDateString()} · ${splitLabel(e)}${e.currency !== l.baseCurrency ? ` · <span class="tag">${e.currency}→${l.baseCurrency} @${e.fxToBase ?? 1}</span>` : ""}</div>
      </div>
      ${receipt}
      <div class="exp-amt"><div>${formatMoney(e.amountMinor, e.currency)}</div>
        <div class="exp-you ${yourNet >= 0 ? "pos" : "neg"}">${yourNet === 0 ? "not involved" : (yourNet > 0 ? "you lent " : "you borrowed ") + formatMoney(Math.abs(yourNet), e.currency)}</div></div>
      <div class="exp-actions">
        <button class="icon-btn" data-edit="${e.id}" title="Edit">✏️</button>
        <button class="icon-btn" data-del="${e.id}" title="Delete">🗑️</button>
      </div></div>`;
  }).join("");
  body.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => openExpenseModal(l.id, b.dataset.edit));
  body.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { if (confirm("Delete this entry?")) { store.removeExpense(b.dataset.del); render(); toast("Deleted."); } });
  body.querySelectorAll("[data-receipt]").forEach((img) => img.onclick = () => openReceipt(img.src));
}

function splitLabel(e) {
  const t = e.split?.type;
  const n = t === "items" ? new Set((e.split.items || []).flatMap((i) => i.participants)).size : (e.split?.participants?.length || 0);
  return { equal: `split ${n} ways`, exact: "exact amounts", percent: "by %", shares: "by shares", items: "itemized" }[t] || "split";
}

function renderBalances(body, l) {
  const { base, perCurrency } = computeBalances(store.expensesFor(l.id), l.baseCurrency);
  const rows = l.memberIds.map((id) => ({ m: store.memberById(id), net: base.get(id) || 0 })).filter((r) => r.m).sort((a, b) => b.net - a.net);
  const multi = Object.keys(perCurrency).length > 1;
  body.innerHTML = `
    ${multi ? `<div class="card" style="margin-bottom:14px"><div class="exp-meta">Multiple currencies used — balances below are converted to <b>${l.baseCurrency}</b> using each expense's rate.</div></div>` : ""}
    <div class="card" style="padding:6px 0">
      ${rows.map((r) => `<div class="bal-row">
        <div class="avatar">${esc(initials(r.m.name))}</div>
        <div class="grow"><b>${esc(r.m.name)}</b>${r.m.id === "you" ? " (you)" : ""}</div>
        <div class="${r.net >= 0 ? "pos" : "neg"}" style="font-weight:700">${r.net === 0 ? "settled up" : (r.net > 0 ? "gets back " : "owes ") + formatMoney(Math.abs(r.net), l.baseCurrency)}</div>
      </div>`).join("")}
    </div>`;
}

function renderSettle(body, l) {
  const { base } = computeBalances(store.expensesFor(l.id), l.baseCurrency);
  const transfers = settleUp(base);
  if (!transfers.length) { body.innerHTML = emptyState("✅", "All settled up", "Nobody owes anybody. Nice."); return; }
  body.innerHTML = `
    <div class="card" style="margin-bottom:14px"><div class="exp-meta">💡 Smart settle-up: the fewest payments that clear every debt (${transfers.length} payment${transfers.length === 1 ? "" : "s"}).</div></div>
    <div class="card" style="padding:6px 0">
    ${transfers.map((t, i) => {
      const from = store.memberById(t.from), to = store.memberById(t.to);
      return `<div class="settle-row">
        <div class="avatar">${esc(initials(from?.name))}</div>
        <div class="grow"><b>${esc(from?.name)}</b> pays <b>${esc(to?.name)}</b></div>
        <div style="font-weight:700">${formatMoney(t.amountMinor, l.baseCurrency)}</div>
        <button class="btn ghost sm" data-settle="${i}">Mark paid</button>
      </div>`;
    }).join("")}
    </div>`;
  body.querySelectorAll("[data-settle]").forEach((b) => b.onclick = () => {
    const t = transfers[+b.dataset.settle];
    store.addExpense({ ledgerId: l.id, settlement: true, from: t.from, to: t.to, amountMinor: t.amountMinor, currency: l.baseCurrency, fxToBase: 1, date: Date.now(), description: "Settlement", category: "settle" });
    render(); toast("Recorded payment.");
  });
}

function renderReminders(body, l) {
  const r = l.reminder || {};
  const { base } = computeBalances(store.expensesFor(l.id), l.baseCurrency);
  const debtors = l.memberIds.map((id) => ({ m: store.memberById(id), net: base.get(id) || 0 })).filter((x) => x.m && x.net < 0);
  body.innerHTML = `
    <div class="card">
      <label style="margin-top:0">Automatic email reminders</label>
      <div class="row" style="align-items:center">
        <label style="margin:0"><input type="checkbox" id="remOn" ${r.enabled ? "checked" : ""} style="width:auto;margin-right:8px">Send reminders to people who owe</label>
      </div>
      <label>Frequency</label>
      <select id="remFreq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${r.frequency === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <label>Custom message (optional — added to the top of the email)</label>
      <textarea id="remMsg" rows="2" placeholder="Hey! Here's what's outstanding from our trip 🙂">${esc(r.message || "")}</textarea>
      <div class="hint">⚠️ Automatic sending activates once you connect Supabase + Resend (Phase 2 — see README). Until then, use the previews below to copy & send manually.</div>
      <div style="margin-top:12px"><button class="btn" id="remSave">Save reminder settings</button></div>
    </div>
    <h3 style="margin:22px 0 10px">Who owes right now</h3>
    ${debtors.length ? debtors.map((d) => {
      const transfers = settleUp(base).filter((t) => t.from === d.m.id);
      return `<div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div class="avatar">${esc(initials(d.m.name))}</div>
          <div class="grow"><b>${esc(d.m.name)}</b> <span class="exp-meta">${d.m.email ? esc(d.m.email) : "⚠️ no email on file"}</span></div>
          <div class="neg" style="font-weight:700">owes ${formatMoney(-d.net, l.baseCurrency)}</div>
          <button class="btn ghost sm" data-copy="${d.m.id}">Copy email</button>
        </div>
        <div class="mail-preview" id="mail_${d.m.id}">${esc(reminderText(l, d.m, transfers))}</div>
      </div>`;
    }).join("") : emptyState("✅", "Nobody owes anything", "No reminders needed right now.")}`;

  $("#remSave").onclick = () => {
    store.updateLedger(l.id, { reminder: { ...r, enabled: $("#remOn").checked, frequency: $("#remFreq").value, message: $("#remMsg").value } });
    toast("Reminder settings saved."); render();
  };
  body.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
    const txt = $("#mail_" + b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(txt); toast("Reminder copied to clipboard."); }
    catch { toast("Copy failed — select the text manually."); }
  });
}

function reminderText(l, member, transfers) {
  const lines = transfers.map((t) => `  • Pay ${store.memberById(t.to)?.name}: ${formatMoney(t.amountMinor, l.baseCurrency)}`);
  const total = transfers.reduce((a, t) => a + t.amountMinor, 0);
  const custom = l.reminder?.message ? l.reminder.message + "\n\n" : "";
  return `Subject: Reminder: you owe ${formatMoney(total, l.baseCurrency)} for "${l.name}"

Hi ${member.name},

${custom}This is a friendly reminder about outstanding balances for ${l.name}. You currently owe a total of ${formatMoney(total, l.baseCurrency)}:

${lines.join("\n")}

Thanks!
— sent via Bill Break`;
}

function renderMembers(body, l) {
  const inLedger = new Set(l.memberIds);
  const others = store.allMembers().filter((m) => !inLedger.has(m.id));
  body.innerHTML = `
    <div class="card" style="padding:6px 0">
      ${l.memberIds.map((id) => { const m = store.memberById(id); return `<div class="bal-row">
        <div class="avatar">${esc(initials(m?.name))}</div>
        <div class="grow"><b>${esc(m?.name)}</b>${id === "you" ? " (you)" : ""} <span class="exp-meta">${m?.email ? esc(m.email) : "no email"}</span></div>
        ${id === "you" ? "" : `<button class="icon-btn" data-remove="${id}" title="Remove from ${esc(l.name)}">✖</button>`}
      </div>`; }).join("")}
    </div>
    <h3 style="margin:20px 0 10px">Add people</h3>
    <div class="card">
      ${others.length ? `<div class="chips">${others.map((m) => `<span class="chip" data-add="${m.id}">＋ ${esc(m.name)}</span>`).join("")}</div>` : `<div class="exp-meta">Everyone's already here.</div>`}
      <div class="row" style="margin-top:14px">
        <input id="newName" placeholder="New person's name">
        <input id="newEmail" placeholder="email (for reminders)">
        <button class="btn" id="addNew" style="flex:none">Add</button>
      </div>
    </div>`;
  body.querySelectorAll("[data-remove]").forEach((b) => b.onclick = () => { store.updateLedger(l.id, { memberIds: l.memberIds.filter((x) => x !== b.dataset.remove) }); render(); });
  body.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => { store.updateLedger(l.id, { memberIds: [...l.memberIds, b.dataset.add] }); render(); });
  $("#addNew").onclick = () => {
    const name = $("#newName").value.trim(); if (!name) return toast("Enter a name.");
    const p = store.addPerson({ name, email: $("#newEmail").value });
    store.updateLedger(l.id, { memberIds: [...l.memberIds, p.id] }); render();
  };
}

function renderSettings(body, l) {
  body.innerHTML = `
    <div class="card">
      <label style="margin-top:0">Name</label>
      <input id="lName" value="${esc(l.name)}">
      <label>Base currency (balances shown in this)</label>
      <select id="lCur">${Object.keys(CURRENCIES).map((c) => `<option value="${c}" ${l.baseCurrency === c ? "selected" : ""}>${c} — ${CURRENCIES[c].name}</option>`).join("")}</select>
      ${l.kind === "trip" ? `<label>Part of group (optional)</label>
        <select id="lParent"><option value="">— standalone —</option>${store.ledgers().filter((g) => g.kind === "group").map((g) => `<option value="${g.id}" ${l.parentId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>` : ""}
      <div style="margin-top:16px;display:flex;gap:10px">
        <button class="btn" id="lSave">Save</button>
        <button class="btn danger" id="lDel">Delete ${kindLabel[l.kind].toLowerCase()}</button>
      </div>
    </div>`;
  $("#lSave").onclick = () => {
    const patch = { name: $("#lName").value.trim() || l.name, baseCurrency: $("#lCur").value };
    if (l.kind === "trip") patch.parentId = $("#lParent").value || null;
    store.updateLedger(l.id, patch); render(); toast("Saved.");
  };
  $("#lDel").onclick = () => { if (confirm(`Delete "${l.name}" and all its expenses? This cannot be undone.`)) { store.removeLedger(l.id); view = { type: "dashboard" }; render(); toast("Deleted."); } };
}

// ---------- modals ----------
function modal(title, bodyHTML, footHTML) {
  const host = $("#modalHost");
  host.hidden = false;
  host.innerHTML = `<div class="modal"><div class="modal-head"><h3>${esc(title)}</h3><button class="close-x" data-close>×</button></div>
    <div class="modal-body">${bodyHTML}</div><div class="modal-foot">${footHTML}</div></div>`;
  host.onclick = (e) => { if (e.target === host || e.target.dataset.close !== undefined) closeModal(); };
  return host;
}
function closeModal() { const h = $("#modalHost"); h.hidden = true; h.innerHTML = ""; }

function openLedgerModal(kind) {
  const people = store.state.people;
  modal(`New ${kindLabel[kind].toLowerCase()}`, `
    <label>${kind === "individual" ? "Friend's name" : "Name"}</label>
    <input id="mName" placeholder="${kind === "trip" ? "Tokyo 2026" : kind === "group" ? "College Friends" : "Alex"}">
    <label>Base currency</label>
    <select id="mCur">${Object.keys(CURRENCIES).map((c) => `<option value="${c}">${c} — ${CURRENCIES[c].name}</option>`).join("")}</select>
    ${kind === "trip" ? `<label>Part of a group? (optional)</label><select id="mParent"><option value="">— standalone —</option>${store.ledgers().filter((g) => g.kind === "group").map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>` : ""}
    ${kind !== "individual" ? `<label>Add people (you're always included)</label>
      <div class="chips" id="mPeople">${people.map((p) => `<span class="chip" data-p="${p.id}">${esc(p.name)}</span>`).join("") || '<span class="exp-meta">No saved people yet — add them below or in the Members tab.</span>'}</div>
      <div class="row" style="margin-top:10px"><input id="mNewP" placeholder="quick add a name"><button class="btn ghost" id="mAddP" style="flex:none">Add</button></div>` : ""}
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="mCreate">Create</button>`);

  const chosen = new Set();
  const host = $("#modalHost");
  host.querySelectorAll("[data-p]").forEach((c) => c.onclick = () => { c.classList.toggle("on"); chosen.has(c.dataset.p) ? chosen.delete(c.dataset.p) : chosen.add(c.dataset.p); });
  if ($("#mAddP")) $("#mAddP").onclick = () => {
    const n = $("#mNewP").value.trim(); if (!n) return;
    const p = store.addPerson({ name: n, email: "" });
    const span = document.createElement("span"); span.className = "chip on"; span.dataset.p = p.id; span.textContent = p.name;
    span.onclick = () => { span.classList.toggle("on"); chosen.has(p.id) ? chosen.delete(p.id) : chosen.add(p.id); };
    $("#mPeople").appendChild(span); chosen.add(p.id); $("#mNewP").value = "";
  };
  $("#mCreate").onclick = () => {
    const name = $("#mName").value.trim(); if (!name) return toast("Enter a name.");
    let memberIds = [...chosen];
    if (kind === "individual") { const p = store.addPerson({ name, email: "" }); memberIds = [p.id]; }
    const l = store.addLedger({ kind, name, baseCurrency: $("#mCur").value, memberIds, parentId: $("#mParent")?.value || null });
    closeModal(); view = { type: "ledger", ledgerId: l.id, tab: "expenses" }; render();
    toast(`${kindLabel[kind]} created.`);
  };
}

function openPersonModal(id) {
  const m = store.memberById(id);
  modal(id === "you" ? "Your profile" : "Edit person", `
    <label>Name</label><input id="pName" value="${esc(m.name)}">
    <label>Email ${id === "you" ? "(so reminders are sent from a name people recognize)" : "(for reminders)"}</label>
    <input id="pEmail" value="${esc(m.email || "")}" placeholder="name@example.com">
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="pSave">Save</button>`);
  $("#pSave").onclick = () => { store.updatePerson(id, { name: $("#pName").value.trim() || m.name, email: $("#pEmail").value.trim() }); closeModal(); render(); toast("Saved."); };
}

// ---------- expense modal (the big one) ----------
function openExpenseModal(ledgerId, editId) {
  const l = store.ledgerById(ledgerId);
  const existing = editId ? store.state.expenses.find((e) => e.id === editId) : null;
  const members = l.memberIds.map((id) => store.memberById(id)).filter(Boolean);

  // working state
  const st = {
    currency: existing?.currency || l.baseCurrency,
    method: existing?.split?.type || "equal",
    participants: new Set(existing ? participantsOf(existing) : l.memberIds),
    payer: existing?.paidBy?.[0]?.memberId || "you",
    receipt: existing?.receipt || null,
    items: null,   // lazily built {items:[{name,amount,parts:Set}], tax, tip}
  };
  // seed itemized editor from an existing itemized expense
  if (existing?.split?.type === "items") {
    const legacyShared = existing.split.sharedMinor ? toMajor(existing.split.sharedMinor, existing.currency) : "";
    st.items = {
      items: (existing.split.items || []).map((it) => ({ name: it.name, amount: toMajor(it.amountMinor, existing.currency), parts: new Set(it.participants) })),
      tax: existing.split.taxMinor ? toMajor(existing.split.taxMinor, existing.currency) : (legacyShared || ""),
      tip: existing.split.tipMinor ? toMajor(existing.split.tipMinor, existing.currency) : "",
    };
  }

  modal(existing ? "Edit expense" : "Add expense", `
    <label>Description</label>
    <input id="eDesc" value="${esc(existing?.description || "")}" placeholder="Dinner at Nabe">
    <div class="row">
      <div><label>Amount</label><input id="eAmt" type="text" inputmode="decimal" value="${existing ? toMajor(existing.amountMinor, existing.currency) : ""}" placeholder="0.00"></div>
      <div style="flex:0 0 120px"><label>Currency</label><select id="eCur">${Object.keys(CURRENCIES).map((c) => `<option value="${c}" ${st.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
    </div>
    <div id="fxRow" ${st.currency === l.baseCurrency ? "hidden" : ""}>
      <label>Exchange rate → ${l.baseCurrency} <span class="hint" style="display:inline">(1 <span id="fxFrom">${st.currency}</span> = ? ${l.baseCurrency})</span></label>
      <input id="eFx" type="text" inputmode="decimal" value="${existing?.fxToBase ?? ""}" placeholder="e.g. 0.0067">
    </div>
    <div class="row">
      <div><label>Paid by</label><select id="ePayer">${members.map((m) => `<option value="${m.id}" ${st.payer === m.id ? "selected" : ""}>${esc(m.name)}${m.id === "you" ? " (you)" : ""}</option>`).join("")}</select></div>
      <div><label>Date</label><input id="eDate" type="date" value="${new Date(existing?.date || Date.now()).toISOString().slice(0, 10)}"></div>
      <div style="flex:0 0 92px"><label>Category</label><select id="eCat">${Object.keys(CATEGORIES).filter((c) => c !== "settle").map((c) => `<option value="${c}" ${existing?.category === c ? "selected" : ""}>${CATEGORIES[c]} ${c}</option>`).join("")}</select></div>
    </div>

    <label>Split method</label>
    <div class="seg" id="eMethod">
      ${[["equal", "= Equal"], ["exact", "Exact"], ["percent", "%"], ["shares", "Shares"], ["items", "Items"]].map(([k, v]) => `<button data-m="${k}" class="${st.method === k ? "on" : ""}">${v}</button>`).join("")}
    </div>
    <div id="splitArea" style="margin-top:12px"></div>
    <div id="splitStatus" class="hint"></div>

    <label>Receipt photo (optional)</label>
    <input id="eReceipt" type="file" accept="image/*">
    <div id="receiptPrev" style="margin-top:8px">${st.receipt ? `<img src="${st.receipt}" class="receipt-thumb">` : ""}</div>
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="eSave">${existing ? "Save changes" : "Add expense"}</button>`);

  const host = $("#modalHost");
  const amtEl = $("#eAmt"), curEl = $("#eCur");

  function renderSplitArea() {
    const area = $("#splitArea");
    const parts = members.filter((m) => st.participants.has(m.id));
    // In itemized mode the total is computed from subtotal + tax + tip, so the
    // Amount box becomes read-only and auto-fills.
    amtEl.readOnly = st.method === "items";
    amtEl.style.opacity = st.method === "items" ? "0.7" : "1";
    if (st.method === "items") { renderItemsEditor(area, members, st, updateStatus); updateStatus(); return; }

    // participant chips
    let html = `<div class="chips">${members.map((m) => `<span class="chip ${st.participants.has(m.id) ? "on" : ""}" data-part="${m.id}">${esc(m.name)}</span>`).join("")}</div>`;
    if (st.method !== "equal") {
      html += `<div style="margin-top:12px">${parts.map((m) => `<div class="split-line"><span class="name">${esc(m.name)}</span>
        <input data-val="${m.id}" type="text" inputmode="decimal" placeholder="${st.method === "percent" ? "%" : st.method === "shares" ? "shares" : "amount"}" value="${prefill(existing, m.id, st.method)}"></div>`).join("")}</div>`;
    }
    area.innerHTML = html;
    area.querySelectorAll("[data-part]").forEach((c) => c.onclick = () => {
      const id = c.dataset.part;
      st.participants.has(id) ? st.participants.delete(id) : st.participants.add(id);
      renderSplitArea();
    });
    area.querySelectorAll("[data-val]").forEach((inp) => inp.oninput = updateStatus);
    updateStatus();
  }

  function currentSplit() {
    const parts = members.filter((m) => st.participants.has(m.id)).map((m) => m.id);
    if (st.method === "items") {
      const cur = st.currency;
      const src = st.items || { items: [], tax: "", tip: "" };
      const items = src.items.filter((it) => it.name || it.amount).map((it) => ({ name: it.name, amountMinor: toMinor(it.amount || 0, cur), participants: [...it.parts] }));
      return { type: "items", items, taxMinor: toMinor(src.tax || 0, cur), tipMinor: toMinor(src.tip || 0, cur) };
    }
    if (st.method === "equal") return { type: "equal", participants: parts };
    if (st.method === "exact") return { type: "exact", participants: parts, amounts: parts.map((id) => toMinor($(`[data-val="${id}"]`).value || 0, st.currency)) };
    // percent or shares
    return { type: st.method, participants: parts, weights: parts.map((id) => parseFloat($(`[data-val="${id}"]`).value || 0) || 0) };
  }

  function updateStatus() {
    const totalMinor = toMinor(amtEl.value || 0, st.currency);
    const exp = { amountMinor: totalMinor, currency: st.currency, split: currentSplit(), paidBy: [{ memberId: st.payer, amountMinor: totalMinor }] };
    const owed = computeOwed(exp);
    const sum = [...owed.values()].reduce((a, b) => a + b, 0);
    const el = $("#splitStatus");
    if (st.method === "percent") {
      const pct = (currentSplit().weights || []).reduce((a, b) => a + b, 0);
      el.innerHTML = `Percentages add to <b>${pct}%</b>. ${pct === 100 ? "✅" : "⚠️ should be 100%"}`;
    } else if (st.method === "items") {
      const s = currentSplit();
      const subtotal = (s.items || []).reduce((a, i) => a + i.amountMinor, 0);
      const tax = s.taxMinor || 0, tip = s.tipMinor || 0;
      const grand = subtotal + tax + tip;
      // auto-fill the (read-only) Amount box with the computed grand total
      amtEl.value = grand ? toMajor(grand, st.currency) : "";
      const parts = [`Subtotal <b>${formatMoney(subtotal, st.currency)}</b>`];
      if (tax) parts.push(`tax <b>${formatMoney(tax, st.currency)}</b>`);
      if (tip) parts.push(`tip <b>${formatMoney(tip, st.currency)}</b>`);
      el.innerHTML = `${parts.join(" + ")} = total <b>${formatMoney(grand, st.currency)}</b> ✅<br><span style="color:var(--muted)">Tax &amp; tip are shared out in proportion to what each person ordered.</span>`;
    } else {
      const diff = totalMinor - sum;
      el.innerHTML = diff === 0 ? "Splits add up ✅" : `<span class="neg">Off by ${formatMoney(Math.abs(diff), st.currency)} — ${diff > 0 ? "unassigned" : "over"}</span>`;
    }
  }

  host.querySelectorAll("[data-m]").forEach((b) => b.onclick = () => {
    st.method = b.dataset.m;
    host.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x.dataset.m === st.method));
    renderSplitArea();
  });
  curEl.onchange = () => { st.currency = curEl.value; $("#fxRow").hidden = st.currency === l.baseCurrency; $("#fxFrom").textContent = st.currency; renderSplitArea(); };
  amtEl.oninput = () => { if (st.method === "equal" || st.method === "items") updateStatus(); else updateStatus(); };
  $("#ePayer").onchange = (e) => st.payer = e.target.value;
  $("#eReceipt").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    st.receipt = await resizeImage(file);
    $("#receiptPrev").innerHTML = `<img src="${st.receipt}" class="receipt-thumb">`;
  };

  $("#eSave").onclick = () => {
    const split = currentSplit();
    const amountMinor = st.method === "items"
      ? (split.items || []).reduce((a, i) => a + i.amountMinor, 0) + (split.taxMinor || 0) + (split.tipMinor || 0)
      : toMinor(amtEl.value || 0, st.currency);
    if (amountMinor <= 0) return toast(st.method === "items" ? "Add at least one item." : "Enter an amount.");
    const exp = {
      ledgerId, description: $("#eDesc").value.trim(), amountMinor, currency: st.currency,
      fxToBase: st.currency === l.baseCurrency ? 1 : (parseFloat($("#eFx").value) || 1),
      paidBy: [{ memberId: st.payer, amountMinor }],
      split, category: $("#eCat").value, date: new Date($("#eDate").value).getTime() || Date.now(),
      receipt: st.receipt || null,
    };
    const errs = validateExpense(exp);
    if (errs.length && !confirm("Heads up — the split doesn't add up exactly:\n\n" + errs.join("\n") + "\n\nSave anyway?")) return;
    if (existing) store.updateExpense(existing.id, exp); else store.addExpense(exp);
    closeModal(); render(); toast(existing ? "Expense updated." : "Expense added.");
  };

  renderSplitArea();
}

// itemized editor — all state lives on st.items (per-modal, no globals)
function renderItemsEditor(area, members, st, onChange) {
  if (!st.items) st.items = { items: [{ name: "", amount: "", parts: new Set(st.participants) }], tax: "", tip: "" };
  const S = st.items;
  if (!("tax" in S)) S.tax = ""; if (!("tip" in S)) S.tip = "";
  const draw = () => {
    // preserve focus across redraws (chips redraw the whole area)
    const active = document.activeElement;
    const activeKey = active && active.dataset ? (active.dataset.iname !== undefined ? "n" + active.dataset.iname : active.dataset.iamt !== undefined ? "a" + active.dataset.iamt : active.id) : null;
    area.innerHTML = `
      <div class="hint">Add each item and tap who shared it. Enter the <b>subtotal</b> per item; tax and gratuity below are optional and get split in proportion to what each person ordered.</div>
      ${S.items.map((it, i) => `
        <div class="card" style="margin:10px 0;padding:12px">
          <div class="row"><input data-iname="${i}" placeholder="Item (e.g. Ramen)" value="${esc(it.name)}"><input data-iamt="${i}" style="flex:0 0 110px" inputmode="decimal" placeholder="amount" value="${esc(it.amount)}"></div>
          <div class="chips" style="margin-top:8px">${members.map((m) => `<span class="chip ${it.parts.has(m.id) ? "on" : ""}" data-ip="${i}:${m.id}">${esc(m.name)}</span>`).join("")}</div>
          <button class="link-btn" data-irm="${i}" style="margin-top:6px">✖ remove item</button>
        </div>`).join("")}
      <button class="btn ghost sm" id="addItem">＋ Add item</button>
      <div class="row" style="margin-top:6px">
        <div><label>Tax (optional)</label><input id="iTax" inputmode="decimal" placeholder="0.00" value="${esc(S.tax)}"></div>
        <div><label>Gratuity / tip (optional)</label><input id="iTip" inputmode="decimal" placeholder="0.00" value="${esc(S.tip)}"></div>
      </div>
    `;
    area.querySelector("#addItem").onclick = () => { S.items.push({ name: "", amount: "", parts: new Set(st.participants) }); draw(); onChange && onChange(); };
    area.querySelectorAll("[data-iname]").forEach((el) => el.oninput = () => { S.items[+el.dataset.iname].name = el.value; });
    area.querySelectorAll("[data-iamt]").forEach((el) => el.oninput = () => { S.items[+el.dataset.iamt].amount = el.value; onChange && onChange(); });
    area.querySelector("#iTax").oninput = (e) => { S.tax = e.target.value; onChange && onChange(); };
    area.querySelector("#iTip").oninput = (e) => { S.tip = e.target.value; onChange && onChange(); };
    area.querySelectorAll("[data-ip]").forEach((c) => c.onclick = () => { const [i, id] = c.dataset.ip.split(":"); const p = S.items[+i].parts; p.has(id) ? p.delete(id) : p.add(id); draw(); onChange && onChange(); });
    area.querySelectorAll("[data-irm]").forEach((b) => b.onclick = () => { S.items.splice(+b.dataset.irm, 1); if (!S.items.length) S.items.push({ name: "", amount: "", parts: new Set(st.participants) }); draw(); onChange && onChange(); });
    // restore focus
    if (activeKey) {
      const sel = activeKey[0] === "n" ? `[data-iname="${activeKey.slice(1)}"]` : activeKey[0] === "a" ? `[data-iamt="${activeKey.slice(1)}"]` : "#" + activeKey;
      const el = area.querySelector(sel); if (el) { el.focus(); const v = el.value; el.value = ""; el.value = v; }
    }
  };
  draw();
}

function participantsOf(e) {
  if (e.split?.type === "items") return [...new Set((e.split.items || []).flatMap((i) => i.participants))];
  return e.split?.participants || [];
}
function prefill(existing, id, method) {
  if (!existing || !existing.split) return "";
  const s = existing.split; const idx = (s.participants || []).indexOf(id);
  if (idx < 0) return "";
  if (method === "exact") return toMajor((s.amounts || [])[idx] || 0, existing.currency);
  if (method === "percent" || method === "shares") return (s.weights || [])[idx] || "";
  return "";
}

function openReceipt(src) {
  modal("Receipt", `<img src="${src}" style="width:100%;border-radius:8px">`, `<button class="btn" data-close>Close</button>`);
}

// ---------- image resize (keep localStorage small) ----------
function resizeImage(file, max = 1000, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(null);
    const r = new FileReader(); r.onload = () => (img.src = r.result); r.readAsDataURL(file);
  });
}

// ---------- backup ----------
function openBackup() {
  modal("Backup & restore", `
    <p class="hint" style="margin-top:0">Your data lives in this browser only (Phase 1). Export a backup to keep it safe or move it to another device. Connect Supabase (Phase 2) for automatic cloud sync across everyone.</p>
    <div style="display:flex;gap:10px;margin-top:12px">
      <button class="btn" id="expBtn">⬇️ Export backup (.json)</button>
      <button class="btn ghost" id="impBtn">⬆️ Import backup</button>
    </div>
    <input id="impFile" type="file" accept="application/json" hidden>
    <hr style="border-color:var(--line);margin:18px 0">
    <button class="btn danger" id="resetBtn">Erase all data</button>
  `, `<button class="btn ghost" data-close>Close</button>`);
  $("#expBtn").onclick = () => {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `billbreak-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  $("#impBtn").onclick = () => $("#impFile").click();
  $("#impFile").onchange = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { store.importJSON(r.result); closeModal(); render(); toast("Backup restored."); } catch (err) { toast(err.message); } }; r.readAsText(f); };
  $("#resetBtn").onclick = () => { if (confirm("Erase ALL data on this device? This cannot be undone.")) { store.reset(); closeModal(); view = { type: "dashboard" }; render(); toast("Erased."); } };
}

// ---------- misc ----------
function emptyState(icon, title, sub, extra = "") {
  return `<div class="empty-state"><div class="big">${icon}</div><h3 style="margin:0 0 6px;color:var(--text)">${esc(title)}</h3><p style="max-width:440px;margin:0 auto">${esc(sub)}</p>${extra}</div>`;
}
function mobileBar() { return `<div class="mobile-bar"><button class="hamburger" id="hamburger">☰</button><b>Bill Break</b></div>`; }
function wireMobile() { const h = $("#hamburger"); if (h) h.onclick = () => $("#sidebar").classList.toggle("open"); }

// ---------- boot ----------
function render() {
  // sync itemsState currency for read-back
  renderSidebar();
  if (view.type === "dashboard") renderDashboard();
  else renderLedger();
}

// wire global sidebar buttons
document.querySelectorAll(".nav-item[data-view='dashboard']").forEach((b) => b.onclick = () => { view = { type: "dashboard" }; $("#sidebar").classList.remove("open"); render(); });
document.querySelectorAll("[data-new]").forEach((b) => b.onclick = () => openLedgerModal(b.dataset.new));
$("#manageFriends").onclick = () => openPeopleModal();
$("#dataBtn").onclick = () => openBackup();

function openPeopleModal() {
  const people = store.state.people;
  modal("People", `
    <p class="hint" style="margin-top:0">Friends you split with. Add their email so reminders can reach them.</p>
    <div class="card" style="padding:6px 0">
      <div class="bal-row"><div class="avatar">${esc(initials(store.state.you.name))}</div><div class="grow"><b>${esc(store.state.you.name)}</b> (you)</div><button class="btn ghost sm" id="editYou">Edit</button></div>
      ${people.map((p) => `<div class="bal-row"><div class="avatar">${esc(initials(p.name))}</div><div class="grow"><b>${esc(p.name)}</b> <span class="exp-meta">${p.email ? esc(p.email) : "no email"}</span></div><button class="icon-btn" data-pedit="${p.id}">✏️</button><button class="icon-btn" data-pdel="${p.id}">🗑️</button></div>`).join("")}
    </div>
    <div class="row" style="margin-top:14px"><input id="ppName" placeholder="name"><input id="ppEmail" placeholder="email"><button class="btn" id="ppAdd" style="flex:none">Add</button></div>
  `, `<button class="btn ghost" data-close>Close</button>`);
  $("#editYou").onclick = () => openPersonModal("you");
  $("#ppAdd").onclick = () => { const n = $("#ppName").value.trim(); if (!n) return toast("Enter a name."); store.addPerson({ name: n, email: $("#ppEmail").value }); openPeopleModal(); render(); };
  document.querySelectorAll("[data-pedit]").forEach((b) => b.onclick = () => openPersonModal(b.dataset.pedit));
  document.querySelectorAll("[data-pdel]").forEach((b) => b.onclick = () => { if (confirm("Remove this person?")) { store.removePerson(b.dataset.pdel); openPeopleModal(); render(); } });
}

store.subscribe(() => {}); // reserved for future live updates
render();
