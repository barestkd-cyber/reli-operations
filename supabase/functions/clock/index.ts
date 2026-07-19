// RELI Ops — Time Clock punch endpoint
// ---------------------------------------------------------------------------
// POST { action: "in" | "out" | "status", site_id?, lat?, lng?, accuracy_m? }
//
// Why this runs server-side:
//   * staff_id comes from the verified JWT, never from the request body.
//   * The geofence distance is computed HERE. A client that says "I'm on site"
//     is not evidence of anything.
//   * Out-of-range is recorded and flagged, not blocked — see the migration
//     for why (indoor GPS drift would strand real cleaners).
//
// Deploy:  supabase functions deploy clock
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

/** Haversine distance in metres. */
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Not signed in." }, 401);

  // Identify the caller from their JWT — this is the only source of staff_id.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid session." }, 401);
  const staffId = userData.user.id;

  const db = createClient(SUPABASE_URL, SERVICE_KEY); // writes bypass RLS, post-verification

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* status needs no body */ }
  const action = String(body.action ?? "status");

  // Current open shift, if any.
  const { data: openRows } = await db
    .from("time_entries")
    .select("*, job_sites(name)")
    .eq("staff_id", staffId)
    .eq("status", "open")
    .order("clock_in_at", { ascending: false })
    .limit(1);
  const open = openRows?.[0] ?? null;

  if (action === "status") return json({ open });

  const lat = typeof body.lat === "number" ? body.lat : null;
  const lng = typeof body.lng === "number" ? body.lng : null;
  const accuracy = typeof body.accuracy_m === "number" ? Math.round(body.accuracy_m) : null;

  // ── CLOCK IN ────────────────────────────────────────────────────────────
  if (action === "in") {
    if (open) return json({ error: "You're already clocked in.", open }, 409);

    const siteId = body.site_id ? String(body.site_id) : null;
    const flags: string[] = [];
    let distance: number | null = null;

    if (siteId) {
      const { data: site } = await db
        .from("job_sites").select("*").eq("id", siteId).single();
      if (!site) return json({ error: "Unknown job site." }, 400);

      if (lat !== null && lng !== null) {
        distance = distanceM(lat, lng, site.lat, site.lng);
        if (distance > site.radius_m) flags.push("out_of_range_in");
        // A huge accuracy radius means the fix is basically a guess.
        if (accuracy !== null && accuracy > 100) flags.push("low_accuracy_in");
      } else {
        flags.push("no_location_in");
      }
    } else {
      flags.push("no_site_selected");
    }

    const { data, error } = await db.from("time_entries").insert({
      staff_id: staffId,
      site_id: siteId,
      clock_in_lat: lat,
      clock_in_lng: lng,
      clock_in_accuracy_m: accuracy,
      clock_in_distance_m: distance,
      clock_in_source: "mobile",
      status: "open",
      flags,
    }).select("*, job_sites(name)").single();

    // The partial unique index is the real guard against a double punch.
    if (error) {
      if (String(error.message).includes("time_entries_one_open_per_staff")) {
        return json({ error: "You're already clocked in." }, 409);
      }
      return json({ error: error.message }, 500);
    }
    return json({ ok: true, entry: data, flags });
  }

  // ── CLOCK OUT ───────────────────────────────────────────────────────────
  if (action === "out") {
    if (!open) return json({ error: "You're not clocked in." }, 409);

    const flags: string[] = [...(open.flags ?? [])];
    let distance: number | null = null;

    if (open.site_id && lat !== null && lng !== null) {
      const { data: site } = await db
        .from("job_sites").select("*").eq("id", open.site_id).single();
      if (site) {
        distance = distanceM(lat, lng, site.lat, site.lng);
        if (distance > site.radius_m) flags.push("out_of_range_out");
        if (accuracy !== null && accuracy > 100) flags.push("low_accuracy_out");
      }
    } else if (lat === null || lng === null) {
      flags.push("no_location_out");
    }

    const { data, error } = await db.from("time_entries").update({
      clock_out_at: new Date().toISOString(),
      clock_out_lat: lat,
      clock_out_lng: lng,
      clock_out_accuracy_m: accuracy,
      clock_out_distance_m: distance,
      clock_out_source: "mobile",
      status: flags.length ? "needs_review" : "closed",
      flags,
    }).eq("id", open.id).select("*, job_sites(name)").single();

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, entry: data, flags });
  }

  return json({ error: "Unknown action." }, 400);
});
