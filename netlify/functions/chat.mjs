import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GHL_TOKEN = process.env.GHL_PRIVATE_TOKEN;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE = "https://services.leadconnectorhq.com";

// ── GHL tool definitions exposed to Claude ──────────────────────────────────
const GHL_TOOLS = [
  {
    name: "ghl_get_contacts",
    description: "Search and retrieve contacts from GoHighLevel CRM. Use this to look up customer information.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term: name, email, or phone" },
        limit: { type: "number", description: "Max results (default 10)" }
      },
      required: []
    }
  },
  {
    name: "ghl_create_contact",
    description: "Create a new contact in GoHighLevel CRM.",
    input_schema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to apply" }
      },
      required: ["firstName"]
    }
  },
  {
    name: "ghl_get_pipelines",
    description: "Get all sales pipelines and their stages from GoHighLevel.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "ghl_create_opportunity",
    description: "Create a new opportunity/deal in a GoHighLevel pipeline.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Opportunity name" },
        pipelineId: { type: "string", description: "Pipeline ID" },
        pipelineStageId: { type: "string", description: "Stage ID" },
        contactId: { type: "string", description: "Associated contact ID" },
        monetaryValue: { type: "number", description: "Deal value" },
        status: { type: "string", enum: ["open", "won", "lost", "abandoned"] }
      },
      required: ["name", "pipelineId", "pipelineStageId", "contactId"]
    }
  },
  {
    name: "ghl_get_opportunities",
    description: "Get opportunities/deals from GoHighLevel pipelines.",
    input_schema: {
      type: "object",
      properties: {
        pipelineId: { type: "string" },
        status: { type: "string", enum: ["open", "won", "lost", "abandoned"] }
      },
      required: []
    }
  },
  {
    name: "ghl_create_task",
    description: "Create a task for a contact in GoHighLevel.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        title: { type: "string" },
        dueDate: { type: "string", description: "ISO date string" },
        description: { type: "string" }
      },
      required: ["contactId", "title"]
    }
  },
  {
    name: "ghl_get_calendars",
    description: "Get available calendars in GoHighLevel for booking appointments.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "ghl_create_appointment",
    description: "Book an appointment in GoHighLevel.",
    input_schema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        contactId: { type: "string" },
        startTime: { type: "string", description: "ISO datetime" },
        endTime: { type: "string", description: "ISO datetime" },
        title: { type: "string" }
      },
      required: ["calendarId", "contactId", "startTime"]
    }
  },
  {
    name: "ghl_send_sms",
    description: "Send an SMS message to a contact via GoHighLevel.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        message: { type: "string" }
      },
      required: ["contactId", "message"]
    }
  },
  {
    name: "ghl_add_tags",
    description: "Add tags to a contact in GoHighLevel.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["contactId", "tags"]
    }
  }
];

// ── GHL API executor ─────────────────────────────────────────────────────────
async function executeGHLTool(toolName, toolInput) {
  const headers = {
    Authorization: `Bearer ${GHL_TOKEN}`,
    "Content-Type": "application/json",
    Version: "2021-07-28"
  };

  try {
    switch (toolName) {
      case "ghl_get_contacts": {
        const params = new URLSearchParams({ locationId: GHL_LOCATION_ID });
        if (toolInput.query) params.set("query", toolInput.query);
        if (toolInput.limit) params.set("limit", String(toolInput.limit));
        const r = await fetch(`${GHL_BASE}/contacts/?${params}`, { headers });
        const d = await r.json();
        return { contacts: d.contacts || [], total: d.total || 0 };
      }
      case "ghl_create_contact": {
        const r = await fetch(`${GHL_BASE}/contacts/`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...toolInput, locationId: GHL_LOCATION_ID })
        });
        return await r.json();
      }
      case "ghl_get_pipelines": {
        const r = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`, { headers });
        return await r.json();
      }
      case "ghl_create_opportunity": {
        const r = await fetch(`${GHL_BASE}/opportunities/`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...toolInput, locationId: GHL_LOCATION_ID })
        });
        return await r.json();
      }
      case "ghl_get_opportunities": {
        const params = new URLSearchParams({ location_id: GHL_LOCATION_ID });
        if (toolInput.pipelineId) params.set("pipeline_id", toolInput.pipelineId);
        if (toolInput.status) params.set("status", toolInput.status);
        const r = await fetch(`${GHL_BASE}/opportunities/search?${params}`, { headers });
        return await r.json();
      }
      case "ghl_create_task": {
        const r = await fetch(`${GHL_BASE}/contacts/${toolInput.contactId}/tasks`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: toolInput.title,
            dueDate: toolInput.dueDate || new Date(Date.now() + 86400000).toISOString(),
            description: toolInput.description || "",
            completed: false
          })
        });
        return await r.json();
      }
      case "ghl_get_calendars": {
        const r = await fetch(`${GHL_BASE}/calendars/?locationId=${GHL_LOCATION_ID}`, { headers });
        return await r.json();
      }
      case "ghl_create_appointment": {
        const r = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...toolInput, locationId: GHL_LOCATION_ID })
        });
        return await r.json();
      }
      case "ghl_send_sms": {
        const r = await fetch(`${GHL_BASE}/conversations/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "SMS",
            contactId: toolInput.contactId,
            message: toolInput.message,
            locationId: GHL_LOCATION_ID
          })
        });
        return await r.json();
      }
      case "ghl_add_tags": {
        const r = await fetch(`${GHL_BASE}/contacts/${toolInput.contactId}/tags`, {
          method: "POST",
          headers,
          body: JSON.stringify({ tags: toolInput.tags })
        });
        return await r.json();
      }
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the B-E-S-Team AI Assistant — a smart, professional business assistant for the B-E-S-Team (Business Excellence Systems Team). Your mission is to help users Increase Their Profit By Refining Their Processes.

You have direct access to the GoHighLevel CRM through your tools. You can:
- Look up and create contacts
- View and manage sales pipelines and opportunities
- Book appointments and manage calendars
- Create tasks and follow-ups
- Send SMS messages
- Tag and segment contacts

Personality:
- Professional but warm and approachable
- Action-oriented — you get things done, not just advise
- Concise and clear — no waffle
- When a user asks you to do something in GHL, just do it using your tools
- Always confirm what you've done after completing an action

If you're unsure of something, ask a quick clarifying question rather than guessing.`;

// ── Main handler ─────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method not allowed" };
  }

  try {
    const { message, sessionId, history = [] } = JSON.parse(event.body || "{}");
    if (!message || !sessionId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "message and sessionId required" }) };
    }

    // Save user message to Supabase
    await supabase.from("messages").insert({
      session_id: sessionId,
      role: "user",
      content: message
    });

    // Build messages array for Claude
    const messages = [
      ...history.slice(-20),
      { role: "user", content: message }
    ];

    // Agentic loop — keep calling Claude until no more tool use
    let finalText = "";
    let loopMessages = [...messages];
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: GHL_TOOLS,
        messages: loopMessages
      });

      // Collect any text blocks
      const textBlocks = response.content.filter(b => b.type === "text");
      if (textBlocks.length > 0) {
        finalText = textBlocks.map(b => b.text).join("\n");
      }

      // If no tool use, we're done
      if (response.stop_reason === "end_turn") break;

      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      // Execute all tools in parallel
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (toolUse) => {
          const result = await executeGHLTool(toolUse.name, toolUse.input);
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          };
        })
      );

      // Add assistant response + tool results to loop
      loopMessages = [
        ...loopMessages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults }
      ];
    }

    // Save assistant reply to Supabase
    await supabase.from("messages").insert({
      session_id: sessionId,
      role: "assistant",
      content: finalText
    });

    // Update session last_active
    await supabase.from("sessions").upsert({
      id: sessionId,
      last_active: new Date().toISOString(),
      message_count: (history.length / 2) + 1
    });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ reply: finalText, sessionId })
    };

  } catch (err) {
    console.error("Chat function error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Internal server error", detail: err.message })
    };
  }
};
