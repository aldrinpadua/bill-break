// UNO Ledger — email someone when they're invited to, or added to, a group.
// Deployed as a Supabase Edge Function; called by the app (js/cloud.js) whenever
// you add a person by email in the Members tab.
//
// Secrets it needs (same ones the reminder function uses):
//   RESEND_API_KEY   — from resend.com
//   FROM_EMAIL       — a verified sender, e.g. "UNO Ledger <hello@aldrinpadua.com>"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sendEmail(to: string, subject: string, text: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("FROM_EMAIL") || "onboarding@resend.dev", to, subject, text }),
  });
  if (!res.ok) console.error("Resend error", res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { type, email, name, groupName, inviterName, link } = await req.json();
    if (!email || !link) return new Response(JSON.stringify({ error: "missing email/link" }), { status: 400, headers: cors });

    const who = inviterName || "A friend";
    const greeting = name ? `Hi ${name},` : "Hi,";
    let subject: string, body: string;

    if (type === "invite") {
      subject = `${who} invited you to "${groupName}" on UNO Ledger`;
      body = `${greeting}\n\n${who} is splitting expenses for "${groupName}" on UNO Ledger and added you.\n\nJoin here — sign in with this email (${email}) and you'll automatically be part of "${groupName}":\n${link}\n\nUNO Ledger makes it easy to split trips and bills with friends.\n\n— UNO Ledger`;
    } else {
      subject = `${who} added you to "${groupName}" on UNO Ledger`;
      body = `${greeting}\n\n${who} added you to "${groupName}" on UNO Ledger. Open it here to see the shared expenses and what's owed:\n${link}\n\n— UNO Ledger`;
    }

    const ok = await sendEmail(email, subject, body);
    return new Response(JSON.stringify({ ok }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});
