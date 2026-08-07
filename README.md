# 🧾 Bill Break

Split trip and group bills with friends — like Splitwise, but with itemized
splits, multi-currency, smart settle-up, and **automatic email reminders** to
people who owe you.

Hosted free on GitHub Pages. Works instantly with no backend (Phase 1), and
upgrades to real accounts + auto-email when you connect free Supabase + Resend
accounts (Phase 2).

---

## What it does

- **Groups, trips, and 1:1 friends** — a group for your friend circle, a trip
  for a getaway (optionally inside a group), or a simple ledger with one friend.
- **Every kind of split** — equal, exact amounts, percentages, shares, or fully
  **itemized** (who ate what, with tax/tip shared across everyone).
- **Multi-currency** — log an expense in any currency with an exchange rate;
  balances roll up into the ledger's base currency.
- **Smart settle-up** — instead of everyone paying everyone, it computes the
  *fewest* payments that clear all debts.
- **Receipt photos** — attach a photo to any expense.
- **Email reminders** — set a per-group frequency (daily → monthly); people who
  owe get an automatic email. (Auto-send is Phase 2; Phase 1 drafts the email
  for you to copy & send.)
- **Backup / restore** — export your data to a file, import it anywhere.

---

## Phase 1 — get it live on GitHub Pages (10 minutes, free)

Phase 1 needs **no accounts and no backend**. Data is saved in your browser.
Perfect for using it solo and showing friends.

1. **Create a GitHub repo.** Go to <https://github.com/new>, name it
   `bill-break` (or anything), set it **Public**, and create it.
2. **Upload these files.** On the repo page click **Add file → Upload files**,
   drag in everything from this folder (keep the folders `css/`, `js/`,
   `supabase/`), and **Commit**.
3. **Turn on Pages.** Repo **Settings → Pages**. Under *Build and deployment*,
   set **Source = Deploy from a branch**, **Branch = `main`**, **Folder =
   `/ (root)`**, and **Save**.
4. Wait ~1 minute, then open the URL GitHub shows you:
   `https://<your-username>.github.io/bill-break/`

That's it — you have a live bill-splitter. Add a trip, add expenses, check the
**Settle up** tab.

> Prefer the command line? From this folder:
> ```
> git init && git add . && git commit -m "Bill Break"
> git branch -M main
> git remote add origin https://github.com/<you>/bill-break.git
> git push -u origin main
> ```
> then do step 3 above.

### A note on Phase 1 storage
Phase 1 keeps data **in the browser you use** (localStorage). It doesn't sync
between devices or people. Use **💾 Backup** to move data or keep it safe. To
get real multi-device, multi-person accounts and automatic emails, do Phase 2.

---

## Phase 2 — accounts, sync & automatic email reminders (free)

This adds a database (so everyone logs in and shares data) and a scheduler that
emails people who owe. All free at your scale.

### 2a. Create a Supabase project
1. Sign up at <https://supabase.com> → **New project** (pick a strong DB
   password, any region).
2. **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. This creates the
   tables, security rules, and the receipts storage bucket.
3. **Settings → API**: copy the **Project URL** and the **anon public** key.
4. Open [`js/config.js`](js/config.js), set `MODE: "cloud"`, and paste those two
   values. Commit/push. (These two values are safe to publish — access is
   still guarded by the security rules from step 2.)

> The front-end **cloud adapter** (login screen + read/write against Supabase)
> is the one remaining piece to wire in — it swaps in behind the same data API
> the app already uses (`js/store.js`). Ping me and we'll drop it in; I kept the
> whole app talking to one small interface specifically so this is a clean swap.

### 2b. Turn on automatic emails (Resend)
1. Sign up at <https://resend.com> (free tier = 3,000 emails/month). To send
   from your own domain, add + verify it; otherwise you can test with
   `onboarding@resend.dev`. Copy your **API key**.
2. Install the Supabase CLI (<https://supabase.com/docs/guides/cli>), then from
   this folder:
   ```
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase functions deploy send-reminders
   supabase secrets set RESEND_API_KEY=... FROM_EMAIL="Bill Break <reminders@yourdomain.com>"
   ```
3. **Schedule it:** in Supabase **Database → Extensions**, enable **pg_cron**
   and **pg_net**. Then **SQL Editor**, paste
   [`supabase/schedule.sql`](supabase/schedule.sql), fill in your project ref +
   anon key, and **Run**. It now runs daily and emails anyone who's due based on
   each group's frequency.

Test it immediately without waiting for the schedule:
```
curl -X POST https://<project-ref>.functions.supabase.co/send-reminders \
  -H "Authorization: Bearer <anon-key>"
```

---

## How the money math works (and why it's exact)

All amounts are stored as **integer minor units** (cents), never floats, so
splits always sum back to the total to the penny. Remainders from uneven splits
are distributed one cent at a time (largest-remainder method). The settle-up
uses a greedy min-cash-flow algorithm to minimize the number of payments. The
logic lives in [`js/money.js`](js/money.js) and [`js/split.js`](js/split.js) and
is covered by tests in [`tests/engine.test.mjs`](tests/engine.test.mjs):

```
cd tests && node engine.test.mjs      # 20 assertions, all passing
```

---

## Project layout

```
index.html               app shell
css/styles.css           styling
js/money.js              currency + cent-exact math
js/split.js              split types, balances, smart settle-up
js/store.js              data layer (localStorage now, Supabase-ready)
js/app.js                UI
js/config.js             local vs cloud switch + Supabase keys
supabase/schema.sql      Phase 2 database + security rules
supabase/functions/send-reminders/index.ts   auto-email function
supabase/schedule.sql    Phase 2 cron schedule
tests/engine.test.mjs    money/split/settle-up tests
```

## Cost
GitHub Pages, Supabase free tier, and Resend free tier are all $0 at the scale
of splitting trips with friends.

## Roadmap ideas
Receipt OCR (auto-read totals), recurring expenses, "simplify debts across all
groups", payment-app deep links (Venmo/PayPal), CSV export, PWA install.
