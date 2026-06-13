// Venice AI chat client. Venice speaks the OpenAI wire format (NOT Anthropic), so this
// is a ~30-line raw-fetch wrapper, no SDK: the Anthropic client literally can't call it,
// and the OpenAI/Vercel SDKs add nothing here — the trust boundary is our own schema
// downstream, not the transport. Model comes from VENICE_MODEL; key from VENICE_API_KEY.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** The injectable brain: NL messages in, raw assistant text out. Tests pass a fake. */
export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

const VENICE_BASE = "https://api.venice.ai/api/v1";

// Per attempt. GLM-5's MEDIAN compile is ~4-5s, but Venice has sporadic tail-latency spikes
// (isolated 14-42s blips, ~1 in 5 calls, the rest fast). So we FAIL FAST on a spike and retry
// a fresh request rather than waiting one out — the retry almost always lands in the median.
// CHAT_TIMEOUT_MS × CHAT_TIMEOUT_TRIES must stay under the dashboard's COMPILE_TIMEOUT_MS (65s).
const CHAT_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_TRIES = 3; // 3 × 20s = 60s worst case; a single spike costs ~1 retry (~4s)

export function veniceChat(opts?: { apiKey?: string; model?: string; baseUrl?: string }): ChatFn {
  const apiKey = opts?.apiKey ?? process.env.VENICE_API_KEY;
  const model = opts?.model ?? process.env.VENICE_MODEL ?? "qwen3-235b-a22b-instruct-2507";
  const base = opts?.baseUrl ?? process.env.VENICE_BASE_URL ?? VENICE_BASE;
  if (apiKey && !opts?.model && !process.env.VENICE_MODEL) {
    // the default model has never been validated against the plan schema; deployments
    // are expected to pin VENICE_MODEL alongside VENICE_API_KEY
    console.warn(`[venice] VENICE_MODEL unset, falling back to unvalidated default "${model}"`);
  }
  return async (messages: ChatMessage[]) => {
    if (!apiKey) throw new Error("VENICE_API_KEY not configured");
    let lastTimeout: Error | null = null;
    // retry ONLY on a timeout (a transient tail-latency spike); any other failure is
    // returned immediately so we never spin on a real error (bad key, 4xx, non-JSON).
    for (let attempt = 0; attempt < CHAT_TIMEOUT_TRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            // Venice-specific knobs are ignored by non-Venice OpenAI endpoints; harmless.
            venice_parameters: { include_venice_system_prompt: false },
          }),
          signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        });
      } catch (e) {
        if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
          // fail fast and retry a fresh request; spikes are per-request, so the next try is usually fast
          lastTimeout = new Error(`venice: no response within ${CHAT_TIMEOUT_MS / 1000}s`);
          continue;
        }
        throw e;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`venice ${res.status}: ${text.slice(0, 300)}`);
      let json: { choices?: Array<{ message?: { content?: string } }> };
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`venice: non-JSON response: ${text.slice(0, 200)}`);
      }
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("venice: no message content");
      return content;
    }
    throw lastTimeout ?? new Error("venice: no response");
  };
}

/** Pull the first JSON object out of a model reply (handles ```json fences + prose).
 * Fenced block wins when it parses; otherwise every `{` is tried as the start of a
 * balanced object, so stray braces in surrounding prose can't poison the slice. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!.trim());
    } catch {
      // fall through: fence held prose or a fragment; scan the full reply
    }
  }
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const end = matchBalancedBrace(raw, start);
    if (end === -1) continue;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // not JSON from this brace (e.g. "{placeholder}" in prose); try the next one
    }
  }
  throw new Error("no JSON object in model reply");
}

/** Index of the `}` closing the `{` at `start`, string-aware; -1 if unbalanced. */
function matchBalancedBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      if (inString) escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}
