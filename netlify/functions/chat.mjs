import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};

// ── Verify agent JWT ──────────────────────────────────────────────
async function verifyAgent(authHeader) {
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
  if (error || !user) return null;
  const { data: agent } = await supabase.from("agents").select("*").eq("id", user.id).single();
  return agent?.is_active ? agent : null;
}

// ── Verify agent owns session + get sub-account creds ─────────────
async function getSessionContext(sessionId, agentId) {
  const { data: session } = await supabase
    .from("sessions")
    .select("*, sub_accounts(id, name, location_id, api_token)")
    .eq("id", sessionId).eq("agent_id", agentId).single();
  return session;
}

// ── GHL Tools ─────────────────────────────────────────────────────
const GHL_TOOLS = [
  { name: "ghl_get_contacts", description: "Search contacts in GoHighLevel CRM by name, email, or phone.",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } } },
  { name: "ghl_create_contact", description: "Create a new contact in GoHighLevel.",
    input_schema: { type: "object", properties: { firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["firstName"] } },
  { name: "ghl_get_pipelines", description: "Get all sales pipelines and stages.",
    input_schema: { type: "object", properties: {} } },
  { name: "ghl_create_opportunity", description: "Create a new deal/opportunity in a pipeline.",
    input_schema: { type: "object", properties: { name: { type: "string" }, pipelineId: { type: "string" }, pipelineStageId: { type: "string" }, contactId: { type: "string" }, monetaryValue: { type: "number" }, status: { type: "string" } }, required: ["name","pipelineId","pipelineStageId","contactId"] } },
  { name: "ghl_get_opportunities", description: "Get opportunities/deals.",
    input_schema: { type: "object", properties: { pipelineId: { type: "string" }, status: { type: "string" } } } },
  { name: "ghl_create_task", description: "Create a follow-up task for a contact.",
    input_schema: { type: "object", properties: { contactId: { type: "string" }, title: { type: "string" }, dueDate: { type: "string" }, description: { type: "string" } }, required: ["contactId","title"] } },
  { name: "ghl_get_calendars", description: "List available booking calendars.",
    input_schema: { type: "object", properties: {} } },
  { name: "ghl_create_appointment", description: "Book an appointment.",
    input_schema: { type: "object", properties: { calendarId: { type: "string" }, contactId: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, title: { type: "string" } }, required: ["calendarId","contactId","startTime"] } },
  { name: "ghl_send_sms", description: "Send SMS to a contact.",
    input_schema: { type: "object", properties: { contactId: { type: "string" }, message: { type: "string" } }, required: ["contactId","message"] } },
  { name: "ghl_add_tags", description: "Add tags to a contact.",
    input_schema: { type: "object", properties: { contactId: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["contactId","tags"] } }
];

async function executeGHLTool(toolName, input, locationId, apiToken) {
  const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json", Version: "2021-07-28" };
  const BASE = "https://services.leadconnectorhq.com";
  try {
    switch (toolName) {
      case "ghl_get_contacts": {
        const p = new URLSearchParams({ locationId });
        if (input.query) p.set("query", input.query);
        if (input.limit) p.set("limit", String(input.limit || 10));
        const r = await fetch(`${BASE}/contacts/?${p}`, { headers });
        return await r.json();
      }
      case "ghl_create_contact": {
        const r = await fetch(`${BASE}/contacts/`, { method: "POST", headers, body: JSON.stringify({ ...input, locationId }) });
        return await r.json();
      }
      case "ghl_get_pipelines": {
        const r = await fetch(`${BASE}/opportunities/pipelines?locationId=${locationId}`, { headers });
        return await r.json();
      }
      case "ghl_create_opportunity": {
        const r = await fetch(`${BASE}/opportunities/`, { method: "POST", headers, body: JSON.stringify({ ...input, locationId }) });
        return await r.json();
      }
      case "ghl_get_opportunities": {
        const p = new URLSearchParams({ location_id: locationId });
        if (input.pipelineId) p.set("pipeline_id", input.pipelineId);
        if (input.status) p.set("status", input.status);
        const r = await fetch(`${BASE}/opportunities/search?${p}`, { headers });
        return await r.json();
      }
      case "ghl_create_task": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/tasks`, { method: "POST", headers,
          body: JSON.stringify({ title: input.title, dueDate: input.dueDate || new Date(Date.now()+86400000).toISOString(), description: input.description || "", completed: false }) });
        return await r.json();
      }
      case "ghl_get_calendars": {
        const r = await fetch(`${BASE}/calendars/?locationId=${locationId}`, { headers });
        return await r.json();
      }
      case "ghl_create_appointment": {
        const r = await fetch(`${BASE}/calendars/events/appointments`, { method: "POST", headers, body: JSON.stringify({ ...input, locationId }) });
        return await r.json();
      }
      case "ghl_send_sms": {
        const r = await fetch(`${BASE}/conversations/messages`, { method: "POST", headers,
          body: JSON.stringify({ type: "SMS", contactId: input.contactId, message: input.message, locationId }) });
        return await r.json();
      }
      case "ghl_add_tags": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/tags`, { method: "POST", headers, body: JSON.stringify({ tags: input.tags }) });
        return await r.json();
      }
      default: return { error: "Unknown tool" };
    }
  } catch (err) { return { error: err.message }; }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  const agent = await verifyAgent(event.headers.authorization);
  if (!agent) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "Unauthorized" }) };

  const path = event.path.replace("/.netlify/functions/chat", "").replace("/api/chat", "");

  // ── GET /api/chat/sessions ── list agent's sessions for a sub-account
  if (event.httpMethod === "GET" && path.includes("sessions")) {
    const subAccountId = event.queryStringParameters?.subAccountId;
    let query = supabase.from("sessions").select("id, title, created_at, last_active, message_count, sub_account_id")
      .eq("agent_id", agent.id).order("last_active", { ascending: false });
    if (subAccountId) query = query.eq("sub_account_id", subAccountId);
    const { data } = await query;
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sessions: data || [] }) };
  }

  // ── POST /api/chat/session ── create new session
  if (event.httpMethod === "POST" && path.includes("session")) {
    const { subAccountId, title } = JSON.parse(event.body || "{}");
    // Verify agent is assigned to this sub-account
    const { data: assignment } = await supabase.from("agent_sub_accounts")
      .select("id").eq("agent_id", agent.id).eq("sub_account_id", subAccountId).single();
    if (!assignment) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Not assigned to this sub-account" }) };

    const { data: session, error } = await supabase.from("sessions")
      .insert({ agent_id: agent.id, sub_account_id: subAccountId, title: title || "New Chat" }).select().single();
    if (error) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: cors, body: JSON.stringify({ session }) };
  }

  // ── GET /api/chat/history ── load messages for session
  if (event.httpMethod === "GET" && path.includes("history")) {
    const sessionId = event.queryStringParameters?.sessionId;
    const session = await getSessionContext(sessionId, agent.id);
    if (!session) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Session not found" }) };
    const { data } = await supabase.from("messages").select("role, content, created_at")
      .eq("session_id", sessionId).order("created_at", { ascending: true }).limit(100);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ messages: data || [], session }) };
  }

  // ── POST /api/chat ── send message
  if (event.httpMethod === "POST") {
    const { message, sessionId, history = [] } = JSON.parse(event.body || "{}");
    if (!message || !sessionId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "message and sessionId required" }) };

    const session = await getSessionContext(sessionId, agent.id);
    if (!session) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Session not found or access denied" }) };

    const { location_id, api_token, name: subAccountName } = session.sub_accounts;

    // Save user message
    await supabase.from("messages").insert({ session_id: sessionId, role: "user", content: message });

    const SYSTEM = `You are the B-E-S-Team AI Assistant — a smart, professional CRM assistant.
You are currently working with the GoHighLevel sub-account: "${subAccountName}".
You help agents manage contacts, pipelines, appointments, tasks, and SMS.
Be concise, action-oriented, and confirm what you've done after each action.
Agent name: ${agent.full_name}`;

    let loopMessages = [...history.slice(-20), { role: "user", content: message }];
    let finalText = "";

    for (let i = 0; i < 10; i++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 4096,
        system: SYSTEM, tools: GHL_TOOLS, messages: loopMessages
      });

      const textBlocks = response.content.filter(b => b.type === "text");
      if (textBlocks.length) finalText = textBlocks.map(b => b.text).join("\n");
      if (response.stop_reason === "end_turn") break;

      const toolUses = response.content.filter(b => b.type === "tool_use");
      if (!toolUses.length) break;

      const toolResults = await Promise.all(toolUses.map(async t => ({
        type: "tool_result", tool_use_id: t.id,
        content: JSON.stringify(await executeGHLTool(t.name, t.input, location_id, api_token))
      })));

      loopMessages = [...loopMessages, { role: "assistant", content: response.content }, { role: "user", content: toolResults }];
    }

    await supabase.from("messages").insert({ session_id: sessionId, role: "assistant", content: finalText });

    // Auto-title session from first message
    if (history.length === 0) {
      const title = message.slice(0, 50) + (message.length > 50 ? "…" : "");
      await supabase.from("sessions").update({ title }).eq("id", sessionId);
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: finalText }) };
  }

  return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Not found" }) };
};
