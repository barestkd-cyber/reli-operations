// RELI CRM — "Find Businesses" (Outreach tab) server-side proxy
// ---------------------------------------------------------------------------
// The CRM runs entirely in the browser, so it CANNOT hold an Anthropic API key.
// This Edge Function is the server side of that call: the key lives here as a
// Supabase secret and never reaches the client.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy find-businesses
//
// The browser calls it with the Supabase anon key it already has, so the
// function is not an open relay to the Anthropic API.
// ---------------------------------------------------------------------------

import Anthropic from "npm:@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

// Tighten to the CRM's real origin once it has a stable URL.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json({ error: "ANTHROPIC_API_KEY secret is not set on this project." }, 500);
  }

  try {
    const { category, city = "Tyler, Texas", limit = 15 } = await req.json();
    if (!category || typeof category !== "string") {
      return json({ error: "Missing 'category'." }, 400);
    }

    const prompt =
      `Search the web for ${category} located in ${city}.\n\n` +
      `Return ONLY a JSON array of up to ${limit} real businesses you actually found. ` +
      `Each object must have exactly these fields:\n` +
      `  name    (string)  - the business name\n` +
      `  phone   (string)  - formatted (903) 555-1234, or "" if not found\n` +
      `  address (string)  - street address or area, or "" if not found\n` +
      `  notes   (string)  - one short line on why they'd need commercial cleaning\n\n` +
      `Rules: do not invent businesses or phone numbers — omit a field you can't ` +
      `verify rather than guessing. Output the raw JSON array and nothing else: ` +
      `no prose before or after, no markdown code fences.`;

    const msg = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      // Adaptive thinking keeps the model's reasoning in `thinking` blocks instead
      // of leaking it into the text we parse as JSON.
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    if (msg.stop_reason === "refusal") {
      return json({ error: "Request was declined by safety filters." }, 422);
    }

    // Parse ONLY `text` blocks. The original client-side version also concatenated
    // `web_search_tool_result` snippet text, which corrupted the JSON payload.
    const raw = msg.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) {
      return json({ error: "Model did not return a JSON array.", raw: raw.slice(0, 400) }, 502);
    }

    let businesses: unknown;
    try {
      businesses = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return json({ error: "Model returned malformed JSON.", raw: raw.slice(0, 400) }, 502);
    }
    if (!Array.isArray(businesses)) {
      return json({ error: "Expected a JSON array." }, 502);
    }

    const clean = businesses
      .filter((b) => b && typeof b === "object" && typeof (b as { name?: unknown }).name === "string")
      .map((b) => {
        const o = b as Record<string, unknown>;
        return {
          name: String(o.name ?? "").trim(),
          phone: String(o.phone ?? "").trim(),
          address: String(o.address ?? "").trim(),
          notes: String(o.notes ?? "").trim(),
        };
      })
      .filter((b) => b.name.length > 0);

    return json({ businesses: clean, count: clean.length });
  } catch (err) {
    console.error("find-businesses failed:", err);
    return json({ error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});
