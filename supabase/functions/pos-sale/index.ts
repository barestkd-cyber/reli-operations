// RELI CRM — POS sale creation (trust boundary)
// ---------------------------------------------------------------------------
// The client sends INTENT: contact, lines (with staff-entered prices, since
// RELI's work is custom-quoted), discount, and its displayed total as a
// checksum. This function:
//   * verifies the caller's JWT and requires admin/owner role
//   * re-derives all money math server-side (pricing module below)
//   * 409s if the client's displayed total disagrees (drift = bug or tamper)
//   * writes sale + lines with the service role
//   * is idempotent on the client-minted sale id (double-submit returns the
//     first sale, never creates two)
// Deploy: supabase functions deploy pos-sale --no-verify-jwt
// (--no-verify-jwt so CORS preflight works; the JWT is verified in code.)
// ---------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ── Pricing module ─────────────────────────────────────────────────────────
// KEEP IN SYNC with computeTotals() in reli-operations/index.html (POS block).
// Rule: subtotal = sum(qty*unit); discount caps at subtotal; tax computes on
// the DISCOUNTED taxable base; total = subtotal - discount + tax.
function computeTotals(
  lines: { qty: number; unit_price_cents: number; taxable: boolean }[],
  discountCents: number,
  taxRateBps: number,
) {
  let subtotal = 0, taxableSubtotal = 0;
  for (const l of lines) {
    const lt = l.qty * l.unit_price_cents;
    subtotal += lt;
    if (l.taxable) taxableSubtotal += lt;
  }
  const discount = Math.min(Math.max(0, Math.round(discountCents || 0)), subtotal);
  const taxBase = Math.max(taxableSubtotal - discount, 0);
  const tax = Math.round((taxBase * taxRateBps) / 10000);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}
// ───────────────────────────────────────────────────────────────────────────

const VALID_KINDS = new Set(["recurring", "one_time", "other"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Caller identity from JWT — never from the body.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Not signed in." }, 401);
  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid session." }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: prof } = await db.from("profiles").select("role").eq("id", userData.user.id).single();
  if (!prof || !["admin", "owner"].includes(prof.role)) return json({ error: "Staff only." }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }

  const saleId = String(body.sale_id ?? "");
  if (!UUID_RE.test(saleId)) return json({ error: "sale_id must be a client-minted UUID." }, 400);

  // Idempotency: if this sale id already exists, return it unchanged.
  const { data: existing } = await db.from("pos_sales").select("*").eq("id", saleId).maybeSingle();
  if (existing) return json({ sale: existing, existing: true });

  const contactId = body.contact_id ? String(body.contact_id) : null;
  if (contactId) {
    const { data: c } = await db.from("contacts").select("id").eq("id", contactId).maybeSingle();
    if (!c) return json({ error: "Unknown contact." }, 400);
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0 || rawLines.length > 50) return json({ error: "1-50 lines required." }, 400);

  const lines = [];
  for (const rl of rawLines) {
    const l = rl as Record<string, unknown>;
    const qty = Number(l.qty);
    const unit = Number(l.unit_price_cents);
    const kind = String(l.kind ?? "");
    const description = String(l.description ?? "").trim();
    const category = String(l.income_category ?? "").trim();
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) return json({ error: "Bad qty." }, 400);
    if (!Number.isInteger(unit) || unit < 0 || unit > 100_000_000) return json({ error: "Bad unit price." }, 400);
    if (!VALID_KINDS.has(kind)) return json({ error: "Bad line kind." }, 400);
    if (!description) return json({ error: "Every line needs a description." }, 400);
    if (!category) return json({ error: "Every line needs an income category." }, 400);
    lines.push({
      kind, description, qty,
      unit_price_cents: unit,
      line_total_cents: qty * unit,
      taxable: Boolean(l.taxable),
      income_category: category,
    });
  }

  // Categories must exist in the owner-editable lookup (stamped as labels).
  const { data: cats } = await db.from("pos_income_categories").select("label").eq("active", true);
  const validCats = new Set((cats ?? []).map((c: { label: string }) => c.label));
  for (const l of lines) {
    if (!validCats.has(l.income_category)) return json({ error: `Unknown category: ${l.income_category}` }, 400);
  }

  const taxRateBps = Number.isInteger(Number(body.tax_rate_bps)) ? Number(body.tax_rate_bps) : 825;
  if (taxRateBps < 0 || taxRateBps > 2000) return json({ error: "Bad tax rate." }, 400);

  const t = computeTotals(lines, Number(body.discount_cents ?? 0), taxRateBps);

  // Checksum: the client must be displaying the same total we derived.
  const expected = Number(body.expected_total_cents);
  if (!Number.isInteger(expected) || expected !== t.total) {
    return json({
      error: "Total mismatch. The screen showed a different total than the server computed. Refresh and retry.",
      server_total_cents: t.total,
    }, 409);
  }

  const { data: sale, error: saleErr } = await db.from("pos_sales").insert({
    id: saleId,
    contact_id: contactId,
    subtotal_cents: t.subtotal,
    discount_cents: t.discount,
    tax_cents: t.tax,
    total_cents: t.total,
    tax_rate_bps: taxRateBps,
    notes: String(body.notes ?? ""),
    created_by: userData.user.id,
  }).select("*").single();

  if (saleErr) {
    // PK race with a double-submit: return the winner.
    if (String(saleErr.message).includes("duplicate key")) {
      const { data: winner } = await db.from("pos_sales").select("*").eq("id", saleId).single();
      return json({ sale: winner, existing: true });
    }
    return json({ error: saleErr.message }, 500);
  }

  const { error: lineErr } = await db.from("pos_sale_lines").insert(
    lines.map((l) => ({ ...l, sale_id: saleId })),
  );
  if (lineErr) {
    // Lines failed: unwind the header so no half-written invoice survives.
    await db.from("pos_sales").delete().eq("id", saleId);
    return json({ error: "Line write failed: " + lineErr.message }, 500);
  }

  return json({ sale, existing: false });
});
