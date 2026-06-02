// ─────────────────────────────────────────────────────────────────
// B-E-S-Team Chat Trigger — responds in <1s with a jobId
// Then kicks off chat-background which does all the heavy work
// ─────────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};

async function verifyAgent(authHeader) {
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
  if (error || !user) return null;
  const { data: agent } = await supabase.from("agents").select("*").eq("id", user.id).single();
  return agent?.is_active ? agent : null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  try {
    const agent = await verifyAgent(event.headers.authorization);
    if (!agent) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "Unauthorized" }) };

    const path = event.path.replace("/.netlify/functions/chat", "").replace("/api/chat", "");

    // ── GET sessions ──────────────────────────────────────────────
    if (event.httpMethod === "GET" && path.includes("sessions")) {
      const subAccountId = event.queryStringParameters?.subAccountId;
      let query = supabase.from("sessions")
        .select("id, title, created_at, last_active, message_count, sub_account_id")
        .eq("agent_id", agent.id).order("last_active", { ascending: false });
      if (subAccountId) query = query.eq("sub_account_id", subAccountId);
      const { data } = await query;
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sessions: data || [] }) };
    }

    // ── POST /session — create new session ────────────────────────
    if (event.httpMethod === "POST" && path.includes("session") && !path.includes("sessions")) {
      const { subAccountId, title } = JSON.parse(event.body || "{}");
      const { data: assignment } = await supabase.from("agent_sub_accounts")
        .select("id").eq("agent_id", agent.id).eq("sub_account_id", subAccountId).single();
      if (!assignment) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Not assigned to this sub-account" }) };
      const { data: session, error } = await supabase.from("sessions")
        .insert({ agent_id: agent.id, sub_account_id: subAccountId, title: title || "New Chat" }).select().single();
      if (error) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ session }) };
    }

    // ── GET /history — load messages ──────────────────────────────
    if (event.httpMethod === "GET" && path.includes("history")) {
      const sessionId = event.queryStringParameters?.sessionId;
      const { data: session } = await supabase.from("sessions")
        .select("*, sub_accounts(id, name)")
        .eq("id", sessionId).eq("agent_id", agent.id).single();
      if (!session) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Session not found" }) };
      const { data } = await supabase.from("messages").select("role, content, created_at")
        .eq("session_id", sessionId).order("created_at", { ascending: true }).limit(100);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ messages: data || [], session }) };
    }

    // ── GET /poll — check if background job is done ───────────────
    if (event.httpMethod === "GET" && path.includes("poll")) {
      const jobId = event.queryStringParameters?.jobId;
      if (!jobId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "jobId required" }) };
      const { data } = await supabase.from("job_results").select("status, reply").eq("id", jobId).single();
      if (!data) return { statusCode: 200, headers: cors, body: JSON.stringify({ status: "pending" }) };
      // Clean up completed job
      if (data.status === "done" || data.status === "error") {
        supabase.from("job_results").delete().eq("id", jobId).then(() => {});
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ status: data.status, reply: data.reply }) };
    }

    // ── POST /chat — kick off background job ──────────────────────
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { message, sessionId, history = [] } = body;
      if (!message || !sessionId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "message and sessionId required" }) };

      // Verify agent owns this session
      const { data: session } = await supabase.from("sessions")
        .select("id").eq("id", sessionId).eq("agent_id", agent.id).single();
      if (!session) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Session not found or access denied" }) };

      // Create a job record immediately
      const jobId = crypto.randomUUID();
      await supabase.from("job_results").insert({ id: jobId, status: "pending", session_id: sessionId });

      // Extract token for background function
      const token = event.headers.authorization?.replace("Bearer ", "");

      // Fire the background function — non-blocking
      const bgUrl = process.env.APP_URL + "/.netlify/functions/chat-background?jobId=" + jobId;
      fetch(bgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId, history, token })
      }).catch(err => console.error("BG trigger error:", err.message));

      // Respond instantly with jobId — frontend will poll
      return {
        statusCode: 202,
        headers: cors,
        body: JSON.stringify({ jobId, status: "pending" })
      };
    }

    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Not found" }) };

  } catch (err) {
    console.error("Chat trigger error:", err.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Server error: " + err.message }) };
  }
};
