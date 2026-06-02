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

async function verifyAgent(authHeader) {
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
  if (error || !user) return null;
  const { data: agent } = await supabase.from("agents").select("*").eq("id", user.id).single();
  return agent?.is_active ? agent : null;
}

async function getSessionContext(sessionId, agentId) {
  const { data: session } = await supabase
    .from("sessions")
    .select("*, sub_accounts(id, name, location_id, api_token)")
    .eq("id", sessionId).eq("agent_id", agentId).single();
  return session;
}

// ── PDF text extractor ────────────────────────────────────────────
async function fetchPdfText(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BESTeamBot/1.0)" }
    });
    if (!response.ok) {
      return { error: "Failed to fetch PDF: HTTP " + response.status };
    }

    const contentType = response.headers.get("content-type") || "";
    const urlLower = url.toLowerCase();
    const isPdf = contentType.includes("pdf") || urlLower.includes(".pdf") || contentType.includes("octet-stream");
    if (!isPdf) {
      return { error: "URL does not appear to be a PDF (content-type: " + contentType + ")" };
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder("latin1");
    const raw = decoder.decode(bytes);

    let text = "";

    // Extract text blocks between BT...ET markers
    let btIdx = 0;
    while (true) {
      const btPos = raw.indexOf("BT", btIdx);
      if (btPos === -1) break;
      const etPos = raw.indexOf("ET", btPos + 2);
      if (etPos === -1) break;
      const block = raw.slice(btPos + 2, etPos);
      btIdx = etPos + 2;

      // Extract parenthesis strings: (text here)
      let i = 0;
      while (i < block.length) {
        if (block[i] === "(") {
          let str = "";
          i++;
          while (i < block.length && block[i] !== ")") {
            if (block[i] === "\\" && i + 1 < block.length) {
              const next = block[i + 1];
              if (next === "n") { str += "\n"; i += 2; }
              else if (next === "r") { str += "\r"; i += 2; }
              else if (next === "t") { str += "\t"; i += 2; }
              else if (next === "(" || next === ")" || next === "\\") { str += next; i += 2; }
              else { i++; }
            } else {
              const code = block.charCodeAt(i);
              if (code >= 32 && code <= 126) str += block[i];
              i++;
            }
          }
          str = str.trim();
          if (str.length > 1) text += str + " ";
          i++;
        } else if (block[i] === "<") {
          // Extract hex strings: <48656c6c6f>
          const closeIdx = block.indexOf(">", i + 1);
          if (closeIdx !== -1) {
            const hex = block.slice(i + 1, closeIdx);
            if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(hex)) {
              let hexStr = "";
              for (let h = 0; h < hex.length; h += 2) {
                const code = parseInt(hex.substr(h, 2), 16);
                if (code >= 32 && code <= 126) hexStr += String.fromCharCode(code);
              }
              if (hexStr.trim().length > 1) text += hexStr + " ";
            }
            i = closeIdx + 1;
          } else {
            i++;
          }
        } else {
          i++;
        }
      }
    }

    // Clean up whitespace
    text = text.replace(/[ \t]{3,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

    if (text.length < 50) {
      return {
        error: "Could not extract readable text from this PDF. It may be a scanned or image-based PDF that requires OCR. Please ensure the PDF contains selectable text.",
        rawLength: bytes.length
      };
    }

    const truncated = text.length > 15000;
    return {
      text: text.slice(0, 15000),
      charCount: text.length,
      truncated: truncated
    };
  } catch (err) {
    return { error: "PDF fetch error: " + err.message };
  }
}

// ── ALL GHL TOOLS ─────────────────────────────────────────────────
const GHL_TOOLS = [

  // ════════════ CONTACTS ════════════
  {
    name: "ghl_get_contacts",
    description: "Search and list contacts in the CRM. Filter by name, email, phone, or tags.",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "Search by name, email, or phone" },
      limit: { type: "number", description: "Max results (default 20)" },
      skip: { type: "number", description: "Pagination offset" },
      tags: { type: "array", items: { type: "string" }, description: "Filter by tags" }
    }}
  },
  {
    name: "ghl_get_contact",
    description: "Get full details of a single contact by their contact ID.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" }
    }, required: ["contactId"] }
  },
  {
    name: "ghl_create_contact",
    description: "Create a new contact in the CRM.",
    input_schema: { type: "object", properties: {
      firstName: { type: "string" },
      lastName: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      address1: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      postalCode: { type: "string" },
      country: { type: "string" },
      companyName: { type: "string" },
      website: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      source: { type: "string" },
      customFields: { type: "array", items: { type: "object" }, description: "Array of {id, field_value}" }
    }, required: ["firstName"] }
  },
  {
    name: "ghl_update_contact",
    description: "Update an existing contact's details.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      companyName: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      customFields: { type: "array", items: { type: "object" } }
    }, required: ["contactId"] }
  },
  {
    name: "ghl_delete_contact",
    description: "Delete a contact from the CRM permanently.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" }
    }, required: ["contactId"] }
  },
  {
    name: "ghl_add_tags",
    description: "Add tags to a contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      tags: { type: "array", items: { type: "string" } }
    }, required: ["contactId", "tags"] }
  },
  {
    name: "ghl_remove_tags",
    description: "Remove tags from a contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      tags: { type: "array", items: { type: "string" } }
    }, required: ["contactId", "tags"] }
  },
  {
    name: "ghl_get_contact_notes",
    description: "Get all notes for a contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" }
    }, required: ["contactId"] }
  },
  {
    name: "ghl_create_contact_note",
    description: "Add a note to a contact record.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      body: { type: "string", description: "Note content" }
    }, required: ["contactId", "body"] }
  },
  {
    name: "ghl_get_contact_tasks",
    description: "Get all tasks for a contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" }
    }, required: ["contactId"] }
  },
  {
    name: "ghl_create_task",
    description: "Create a task for a contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      title: { type: "string" },
      dueDate: { type: "string", description: "ISO date string e.g. 2024-12-31T10:00:00Z" },
      description: { type: "string" },
      assignedTo: { type: "string", description: "User ID to assign task to" }
    }, required: ["contactId", "title"] }
  },
  {
    name: "ghl_update_task",
    description: "Update or complete a task.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      taskId: { type: "string" },
      title: { type: "string" },
      dueDate: { type: "string" },
      completed: { type: "boolean" }
    }, required: ["contactId", "taskId"] }
  },
  {
    name: "ghl_get_contact_appointments",
    description: "Get all appointments for a specific contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" }
    }, required: ["contactId"] }
  },

  // ════════════ CONVERSATIONS ════════════
  {
    name: "ghl_search_conversations",
    description: "Search and list conversations. Filter by contact, type (SMS, email, call), or status.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string", description: "Filter by contact ID" },
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 20)" },
      status: { type: "string", enum: ["open", "read", "unread", "starred", "recents"], description: "Filter by status" },
      assignedTo: { type: "string", description: "Filter by assigned user ID" }
    }}
  },
  {
    name: "ghl_get_conversation",
    description: "Get full details of a conversation by conversation ID.",
    input_schema: { type: "object", properties: {
      conversationId: { type: "string" }
    }, required: ["conversationId"] }
  },
  {
    name: "ghl_get_messages",
    description: "Get all messages in a conversation thread.",
    input_schema: { type: "object", properties: {
      conversationId: { type: "string" },
      limit: { type: "number", description: "Max messages to return" },
      lastMessageId: { type: "string", description: "For pagination — get messages before this ID" }
    }, required: ["conversationId"] }
  },
  {
    name: "ghl_send_message",
    description: "Send a message to a contact. Supports SMS, email, WhatsApp, FB Messenger, Instagram.",
    input_schema: { type: "object", properties: {
      conversationId: { type: "string", description: "Conversation ID to reply to (use with existing conversations)" },
      contactId: { type: "string", description: "Contact ID (used if no conversationId)" },
      type: { type: "string", enum: ["SMS", "Email", "WhatsApp", "IG", "FB", "Custom"], description: "Message channel" },
      message: { type: "string", description: "Message text body" },
      subject: { type: "string", description: "Email subject (for Email type only)" },
      html: { type: "string", description: "HTML body (for Email type only)" }
    }, required: ["type", "message"] }
  },
  {
    name: "ghl_create_conversation",
    description: "Create a new conversation thread with a contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      userId: { type: "string", description: "Assign to a specific user" }
    }, required: ["contactId"] }
  },
  {
    name: "ghl_update_conversation",
    description: "Update conversation status — mark as read, unread, starred, or assign to user.",
    input_schema: { type: "object", properties: {
      conversationId: { type: "string" },
      unreadCount: { type: "number" },
      starred: { type: "boolean" },
      assignedTo: { type: "string", description: "User ID" }
    }, required: ["conversationId"] }
  },

  // ════════════ OPPORTUNITIES / PIPELINE ════════════
  {
    name: "ghl_get_pipelines",
    description: "Get all sales pipelines and their stages.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "ghl_search_opportunities",
    description: "Search opportunities/deals across pipelines.",
    input_schema: { type: "object", properties: {
      pipelineId: { type: "string" },
      pipelineStageId: { type: "string" },
      contactId: { type: "string" },
      status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] },
      assignedTo: { type: "string" },
      query: { type: "string", description: "Search by name" },
      limit: { type: "number" }
    }}
  },
  {
    name: "ghl_get_opportunity",
    description: "Get full details of a specific opportunity by ID.",
    input_schema: { type: "object", properties: {
      opportunityId: { type: "string" }
    }, required: ["opportunityId"] }
  },
  {
    name: "ghl_create_opportunity",
    description: "Create a new deal/opportunity in a pipeline.",
    input_schema: { type: "object", properties: {
      name: { type: "string" },
      pipelineId: { type: "string" },
      pipelineStageId: { type: "string" },
      contactId: { type: "string" },
      monetaryValue: { type: "number" },
      status: { type: "string", enum: ["open", "won", "lost", "abandoned"] },
      assignedTo: { type: "string" },
      customFields: { type: "array", items: { type: "object" } }
    }, required: ["name", "pipelineId", "pipelineStageId", "contactId"] }
  },
  {
    name: "ghl_update_opportunity",
    description: "Update an opportunity — move stage, change value, update status.",
    input_schema: { type: "object", properties: {
      opportunityId: { type: "string" },
      name: { type: "string" },
      pipelineStageId: { type: "string" },
      status: { type: "string", enum: ["open", "won", "lost", "abandoned"] },
      monetaryValue: { type: "number" },
      assignedTo: { type: "string" }
    }, required: ["opportunityId"] }
  },
  {
    name: "ghl_delete_opportunity",
    description: "Delete an opportunity permanently.",
    input_schema: { type: "object", properties: {
      opportunityId: { type: "string" }
    }, required: ["opportunityId"] }
  },

  // ════════════ CALENDARS & APPOINTMENTS ════════════
  {
    name: "ghl_get_calendars",
    description: "List all available booking calendars.",
    input_schema: { type: "object", properties: {
      showActive: { type: "boolean", description: "Only show active calendars" }
    }}
  },
  {
    name: "ghl_get_calendar_slots",
    description: "Get available time slots for a calendar on a given date range.",
    input_schema: { type: "object", properties: {
      calendarId: { type: "string" },
      startDate: { type: "number", description: "Unix timestamp in ms" },
      endDate: { type: "number", description: "Unix timestamp in ms" },
      timezone: { type: "string", description: "e.g. America/New_York" }
    }, required: ["calendarId", "startDate", "endDate"] }
  },
  {
    name: "ghl_get_appointments",
    description: "Get appointments/events within a date range.",
    input_schema: { type: "object", properties: {
      calendarId: { type: "string" },
      startTime: { type: "number", description: "Unix timestamp ms" },
      endTime: { type: "number", description: "Unix timestamp ms" },
      userId: { type: "string" }
    }}
  },
  {
    name: "ghl_create_appointment",
    description: "Book an appointment for a contact on a calendar.",
    input_schema: { type: "object", properties: {
      calendarId: { type: "string" },
      contactId: { type: "string" },
      startTime: { type: "string", description: "ISO datetime e.g. 2024-12-31T10:00:00+05:30" },
      endTime: { type: "string", description: "ISO datetime" },
      title: { type: "string" },
      appointmentStatus: { type: "string", enum: ["new", "confirmed", "cancelled", "showed", "noshow", "invalid"] },
      assignedUserId: { type: "string" },
      address: { type: "string" },
      notes: { type: "string" }
    }, required: ["calendarId", "contactId", "startTime"] }
  },
  {
    name: "ghl_update_appointment",
    description: "Update an existing appointment — reschedule, change status, add notes.",
    input_schema: { type: "object", properties: {
      appointmentId: { type: "string" },
      startTime: { type: "string" },
      endTime: { type: "string" },
      title: { type: "string" },
      appointmentStatus: { type: "string", enum: ["new", "confirmed", "cancelled", "showed", "noshow", "invalid"] },
      notes: { type: "string" }
    }, required: ["appointmentId"] }
  },
  {
    name: "ghl_delete_appointment",
    description: "Cancel/delete an appointment.",
    input_schema: { type: "object", properties: {
      appointmentId: { type: "string" }
    }, required: ["appointmentId"] }
  },

  // ════════════ WORKFLOWS ════════════
  {
    name: "ghl_get_workflows",
    description: "List all automation workflows in the account.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "ghl_add_contact_to_workflow",
    description: "Add a contact to an automation workflow.",
    input_schema: { type: "object", properties: {
      workflowId: { type: "string" },
      contactId: { type: "string" },
      eventStartTime: { type: "string", description: "Optional ISO datetime to schedule" }
    }, required: ["workflowId", "contactId"] }
  },
  {
    name: "ghl_remove_contact_from_workflow",
    description: "Remove a contact from an automation workflow.",
    input_schema: { type: "object", properties: {
      workflowId: { type: "string" },
      contactId: { type: "string" }
    }, required: ["workflowId", "contactId"] }
  },

  // ════════════ CAMPAIGNS ════════════
  {
    name: "ghl_get_campaigns",
    description: "List all campaigns in the account.",
    input_schema: { type: "object", properties: {
      status: { type: "string", description: "Filter by status" }
    }}
  },

  // ════════════ FORMS & SURVEYS ════════════
  {
    name: "ghl_get_forms",
    description: "List all forms in the account.",
    input_schema: { type: "object", properties: {
      skip: { type: "number" },
      limit: { type: "number" },
      type: { type: "string", description: "Filter by form type" }
    }}
  },
  {
    name: "ghl_get_form_submissions",
    description: "Get submissions for a specific form.",
    input_schema: { type: "object", properties: {
      formId: { type: "string" },
      startAt: { type: "number", description: "Unix timestamp ms" },
      endAt: { type: "number", description: "Unix timestamp ms" },
      limit: { type: "number" }
    }, required: ["formId"] }
  },
  {
    name: "ghl_get_surveys",
    description: "List all surveys in the account.",
    input_schema: { type: "object", properties: {
      skip: { type: "number" },
      limit: { type: "number" }
    }}
  },
  {
    name: "ghl_get_survey_submissions",
    description: "Get submissions for a specific survey.",
    input_schema: { type: "object", properties: {
      surveyId: { type: "string" },
      startAt: { type: "number" },
      endAt: { type: "number" },
      limit: { type: "number" }
    }, required: ["surveyId"] }
  },

  // ════════════ USERS ════════════
  {
    name: "ghl_get_users",
    description: "Get all users/team members in the sub-account.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "ghl_get_user",
    description: "Get details of a specific user by ID.",
    input_schema: { type: "object", properties: {
      userId: { type: "string" }
    }, required: ["userId"] }
  },

  // ════════════ LOCATION / ACCOUNT ════════════
  {
    name: "ghl_get_location",
    description: "Get details about the current sub-account/location — business info, settings, timezone.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "ghl_get_custom_fields",
    description: "Get all custom field definitions for the account.",
    input_schema: { type: "object", properties: {
      model: { type: "string", enum: ["contact", "opportunity", "all"], description: "Filter by model type" }
    }}
  },
  {
    name: "ghl_get_tags",
    description: "Get all tags used in the account.",
    input_schema: { type: "object", properties: {} }
  },

  // ════════════ PAYMENTS ════════════
  {
    name: "ghl_get_orders",
    description: "List payment orders/transactions.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      limit: { type: "number" },
      offset: { type: "number" },
      status: { type: "string", description: "Filter by order status" }
    }}
  },
  {
    name: "ghl_get_order",
    description: "Get details of a specific order by ID.",
    input_schema: { type: "object", properties: {
      orderId: { type: "string" }
    }, required: ["orderId"] }
  },
  {
    name: "ghl_get_transactions",
    description: "List payment transactions.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      limit: { type: "number" },
      offset: { type: "number" }
    }}
  },

  // ════════════ INVOICES ════════════
  {
    name: "ghl_get_invoices",
    description: "List invoices for the account or a specific contact.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string" },
      status: { type: "string", description: "draft, sent, payment_processing, paid, void, partially_paid" },
      limit: { type: "number" }
    }}
  },
  {
    name: "ghl_get_invoice",
    description: "Get a specific invoice by ID.",
    input_schema: { type: "object", properties: {
      invoiceId: { type: "string" }
    }, required: ["invoiceId"] }
  },
  {
    name: "ghl_send_invoice",
    description: "Send an invoice to a contact.",
    input_schema: { type: "object", properties: {
      invoiceId: { type: "string" }
    }, required: ["invoiceId"] }
  },
  {
    name: "ghl_void_invoice",
    description: "Void/cancel an invoice.",
    input_schema: { type: "object", properties: {
      invoiceId: { type: "string" }
    }, required: ["invoiceId"] }
  },

  // ════════════ SOCIAL PLANNER ════════════
  {
    name: "ghl_get_social_posts",
    description: "Get scheduled or published social media posts.",
    input_schema: { type: "object", properties: {
      startDate: { type: "number", description: "Unix timestamp ms" },
      endDate: { type: "number", description: "Unix timestamp ms" },
      limit: { type: "number" }
    }}
  },

  // ════════════ TRIGGER LINKS ════════════
  {
    name: "ghl_get_trigger_links",
    description: "Get all trigger links in the account.",
    input_schema: { type: "object", properties: {} }
  },

  // ════════════ CONTACTS — UPSERT ════════════
  {
    name: "ghl_upsert_contact",
    description: "Create a new contact OR update an existing one based on email/phone match. Prevents duplicate contacts. Use this instead of create when you're not sure if the contact already exists.",
    input_schema: { type: "object", properties: {
      firstName: { type: "string" },
      lastName: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      companyName: { type: "string" },
      address1: { type: "string" },
      city: { type: "string" },
      state: { type: "string" },
      postalCode: { type: "string" },
      country: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      customFields: { type: "array", items: { type: "object" } },
      source: { type: "string" }
    }, required: ["email"] }
  },

  // ════════════ SOCIAL MEDIA POSTING (FULL) ════════════
  {
    name: "ghl_get_social_accounts",
    description: "Get all connected social media accounts (Facebook, Instagram, LinkedIn, Twitter/X, TikTok, GMB) and their groups.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "ghl_get_social_post",
    description: "Get details of a specific social media post by post ID.",
    input_schema: { type: "object", properties: {
      postId: { type: "string" }
    }, required: ["postId"] }
  },
  {
    name: "ghl_create_social_post",
    description: "Create and schedule a new social media post across one or more platforms (Facebook, Instagram, LinkedIn, Twitter/X, TikTok, GMB).",
    input_schema: { type: "object", properties: {
      accountIds: { type: "array", items: { type: "string" }, description: "List of social account IDs to post to" },
      body: { type: "string", description: "Post content/caption text" },
      scheduleDate: { type: "string", description: "ISO datetime to schedule. Leave empty to post immediately." },
      mediaUrls: { type: "array", items: { type: "string" }, description: "Optional image/video URLs to attach" },
      tags: { type: "array", items: { type: "string" }, description: "Optional hashtags" }
    }, required: ["accountIds", "body"] }
  },
  {
    name: "ghl_edit_social_post",
    description: "Edit/update an existing social media post — change content, reschedule, or modify media.",
    input_schema: { type: "object", properties: {
      postId: { type: "string" },
      body: { type: "string", description: "Updated post content" },
      scheduleDate: { type: "string", description: "New scheduled ISO datetime" },
      mediaUrls: { type: "array", items: { type: "string" } }
    }, required: ["postId"] }
  },
  {
    name: "ghl_get_social_statistics",
    description: "Get analytics/statistics for connected social media accounts — likes, reach, impressions, followers.",
    input_schema: { type: "object", properties: {
      accountIds: { type: "array", items: { type: "string" }, description: "Social account IDs to get stats for" },
      startDate: { type: "number", description: "Unix timestamp ms" },
      endDate: { type: "number", description: "Unix timestamp ms" }
    }, required: ["accountIds"] }
  },

  // ════════════ BLOGS (FULL) ════════════
  {
    name: "ghl_get_blogs",
    description: "Get all blog sites set up in the account.",
    input_schema: { type: "object", properties: {
      skip: { type: "number" },
      limit: { type: "number" }
    }}
  },
  {
    name: "ghl_get_blog_posts",
    description: "Get blog posts for a specific blog site, with optional filters.",
    input_schema: { type: "object", properties: {
      blogId: { type: "string", description: "Blog site ID" },
      status: { type: "string", enum: ["DRAFT", "PUBLISHED", "SCHEDULED", "ARCHIVED"] },
      limit: { type: "number" },
      offset: { type: "number" },
      searchTerm: { type: "string" }
    }, required: ["blogId"] }
  },
  {
    name: "ghl_create_blog_post",
    description: "Create a new blog post. Can save as draft or publish immediately.",
    input_schema: { type: "object", properties: {
      blogId: { type: "string", description: "Blog site ID to publish to" },
      title: { type: "string" },
      description: { type: "string", description: "Blog post full HTML/text content" },
      imageUrl: { type: "string", description: "Featured image URL" },
      status: { type: "string", enum: ["DRAFT", "PUBLISHED", "SCHEDULED"], description: "Publication status" },
      publishedAt: { type: "string", description: "ISO datetime for scheduled posts" },
      categories: { type: "array", items: { type: "string" }, description: "Category IDs" },
      tags: { type: "array", items: { type: "string" } },
      author: { type: "string", description: "Author ID" },
      urlSlug: { type: "string", description: "URL slug (must be unique — use check-slug first)" },
      metaTitle: { type: "string" },
      metaDescription: { type: "string" }
    }, required: ["blogId", "title", "description", "urlSlug"] }
  },
  {
    name: "ghl_update_blog_post",
    description: "Update an existing blog post — edit content, change status, reschedule.",
    input_schema: { type: "object", properties: {
      blogId: { type: "string" },
      postId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      imageUrl: { type: "string" },
      status: { type: "string", enum: ["DRAFT", "PUBLISHED", "SCHEDULED", "ARCHIVED"] },
      publishedAt: { type: "string" },
      categories: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      urlSlug: { type: "string" },
      metaTitle: { type: "string" },
      metaDescription: { type: "string" }
    }, required: ["blogId", "postId"] }
  },
  {
    name: "ghl_check_blog_slug",
    description: "Check if a URL slug is available before creating a blog post. Returns true if available.",
    input_schema: { type: "object", properties: {
      blogId: { type: "string" },
      urlSlug: { type: "string" }
    }, required: ["blogId", "urlSlug"] }
  },
  {
    name: "ghl_get_blog_categories",
    description: "Get all blog categories for the account.",
    input_schema: { type: "object", properties: {
      limit: { type: "number" },
      skip: { type: "number" }
    }}
  },
  {
    name: "ghl_get_blog_authors",
    description: "Get all blog authors configured in the account.",
    input_schema: { type: "object", properties: {
      limit: { type: "number" },
      skip: { type: "number" }
    }}
  },

  // PDF READER
  {
    name: "read_pdf_from_url",
    description: "Fetch and extract full text content from a PDF at a given URL. Use this whenever a contact has a PDF link in their custom fields or any URL ending in .pdf is found. After reading, always generate a structured summary then ask the agent: Save as Internal Comment or Contact Note?",
    input_schema: { type: "object", properties: {
      url: { type: "string", description: "Direct URL to the PDF file" },
      contactId: { type: "string", description: "The contact ID this PDF belongs to" },
      contactName: { type: "string", description: "The contact name for labelling the summary" }
    }, required: ["url"] }
  },

  // INTERNAL COMMENT
  {
    name: "ghl_create_internal_comment",
    description: "Add an internal comment to a contact conversation activity feed. Internal comments are ONLY visible to team members, the contact never sees them. Use when agent chooses Internal Comment as save destination for a PDF summary.",
    input_schema: { type: "object", properties: {
      contactId: { type: "string", description: "Contact ID to add the comment to" },
      message: { type: "string", description: "The internal comment content" }
    }, required: ["contactId", "message"] }
  },

  // EMAIL TEMPLATES
  {
    name: "ghl_get_email_templates",
    description: "Get all email templates saved in the account. Useful for referencing templates before sending campaigns.",
    input_schema: { type: "object", properties: {
      limit: { type: "number" },
      skip: { type: "number" },
      type: { type: "string", description: "Filter by template type: html, builder, blank, custom" },
      search: { type: "string", description: "Search by template name" }
    }}
  },
  {
    name: "ghl_create_email_template",
    description: "Create a new email template in the account.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "Template name" },
      type: { type: "string", enum: ["html", "builder", "blank", "custom"], description: "Template type" },
      subject: { type: "string", description: "Email subject line" },
      body: { type: "string", description: "HTML email body content" },
      previewText: { type: "string", description: "Preview/snippet text shown in inbox" }
    }, required: ["name", "type"] }
  }
];

// ── GHL API executor ──────────────────────────────────────────────
async function executeGHLTool(toolName, input, locationId, apiToken) {
  const BASE = "https://services.leadconnectorhq.com";
  const h = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    Version: "2021-07-28"
  };
  const h2 = { ...h, Version: "2023-02-21" };

  try {
    switch (toolName) {

      // ── CONTACTS ──
      case "ghl_get_contacts": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.query) p.set("query", input.query);
        if (input.skip) p.set("skip", String(input.skip));
        if (input.tags?.length) input.tags.forEach(t => p.append("tags[]", t));
        const r = await fetch(`${BASE}/contacts/?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_contact": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}`, { headers: h });
        return await r.json();
      }
      case "ghl_create_contact": {
        const r = await fetch(`${BASE}/contacts/`, { method: "POST", headers: h, body: JSON.stringify({ ...input, locationId }) });
        return await r.json();
      }
      case "ghl_update_contact": {
        const { contactId, ...body } = input;
        const r = await fetch(`${BASE}/contacts/${contactId}`, { method: "PUT", headers: h, body: JSON.stringify(body) });
        return await r.json();
      }
      case "ghl_delete_contact": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}`, { method: "DELETE", headers: h });
        return await r.json();
      }
      case "ghl_add_tags": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/tags`, { method: "POST", headers: h, body: JSON.stringify({ tags: input.tags }) });
        return await r.json();
      }
      case "ghl_remove_tags": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/tags`, { method: "DELETE", headers: h, body: JSON.stringify({ tags: input.tags }) });
        return await r.json();
      }
      case "ghl_get_contact_notes": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/notes`, { headers: h });
        return await r.json();
      }
      case "ghl_create_contact_note": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/notes`, { method: "POST", headers: h, body: JSON.stringify({ body: input.body }) });
        return await r.json();
      }
      case "ghl_get_contact_tasks": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/tasks`, { headers: h });
        return await r.json();
      }
      case "ghl_create_task": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/tasks`, { method: "POST", headers: h,
          body: JSON.stringify({ title: input.title, dueDate: input.dueDate || new Date(Date.now()+86400000).toISOString(), description: input.description || "", completed: false, assignedTo: input.assignedTo }) });
        return await r.json();
      }
      case "ghl_update_task": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/tasks/${input.taskId}`, { method: "PUT", headers: h,
          body: JSON.stringify({ title: input.title, dueDate: input.dueDate, completed: input.completed }) });
        return await r.json();
      }
      case "ghl_get_contact_appointments": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/appointments`, { headers: h });
        return await r.json();
      }

      // ── CONVERSATIONS ──
      case "ghl_search_conversations": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.contactId) p.set("contactId", input.contactId);
        if (input.query) p.set("query", input.query);
        if (input.status) p.set("status", input.status);
        if (input.assignedTo) p.set("assignedTo", input.assignedTo);
        const r = await fetch(`${BASE}/conversations/search?${p}`, { headers: h2 });
        return await r.json();
      }
      case "ghl_get_conversation": {
        const r = await fetch(`${BASE}/conversations/${input.conversationId}`, { headers: h2 });
        return await r.json();
      }
      case "ghl_get_messages": {
        const p = new URLSearchParams({ limit: String(input.limit || 20) });
        if (input.lastMessageId) p.set("lastMessageId", input.lastMessageId);
        const r = await fetch(`${BASE}/conversations/${input.conversationId}/messages?${p}`, { headers: h2 });
        return await r.json();
      }
      case "ghl_send_message": {
        const body = {
          type: input.type,
          message: input.message,
          locationId,
          ...(input.conversationId && { conversationId: input.conversationId }),
          ...(input.contactId && { contactId: input.contactId }),
          ...(input.subject && { subject: input.subject }),
          ...(input.html && { html: input.html })
        };
        const r = await fetch(`${BASE}/conversations/messages`, { method: "POST", headers: h2, body: JSON.stringify(body) });
        return await r.json();
      }
      case "ghl_create_conversation": {
        const r = await fetch(`${BASE}/conversations/`, { method: "POST", headers: h2,
          body: JSON.stringify({ contactId: input.contactId, locationId, userId: input.userId }) });
        return await r.json();
      }
      case "ghl_update_conversation": {
        const { conversationId, ...body } = input;
        const r = await fetch(`${BASE}/conversations/${conversationId}`, { method: "PUT", headers: h2, body: JSON.stringify({ ...body, locationId }) });
        return await r.json();
      }

      // ── OPPORTUNITIES ──
      case "ghl_get_pipelines": {
        const r = await fetch(`${BASE}/opportunities/pipelines?locationId=${locationId}`, { headers: h });
        return await r.json();
      }
      case "ghl_search_opportunities": {
        const p = new URLSearchParams({ location_id: locationId, limit: String(input.limit || 20) });
        if (input.pipelineId) p.set("pipeline_id", input.pipelineId);
        if (input.pipelineStageId) p.set("pipeline_stage_id", input.pipelineStageId);
        if (input.contactId) p.set("contact_id", input.contactId);
        if (input.status && input.status !== "all") p.set("status", input.status);
        if (input.assignedTo) p.set("assigned_to", input.assignedTo);
        if (input.query) p.set("query", input.query);
        const r = await fetch(`${BASE}/opportunities/search?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_opportunity": {
        const r = await fetch(`${BASE}/opportunities/${input.opportunityId}`, { headers: h });
        return await r.json();
      }
      case "ghl_create_opportunity": {
        const r = await fetch(`${BASE}/opportunities/`, { method: "POST", headers: h, body: JSON.stringify({ ...input, locationId }) });
        return await r.json();
      }
      case "ghl_update_opportunity": {
        const { opportunityId, ...body } = input;
        const r = await fetch(`${BASE}/opportunities/${opportunityId}`, { method: "PUT", headers: h, body: JSON.stringify(body) });
        return await r.json();
      }
      case "ghl_delete_opportunity": {
        const r = await fetch(`${BASE}/opportunities/${input.opportunityId}`, { method: "DELETE", headers: h });
        return await r.json();
      }

      // ── CALENDARS ──
      case "ghl_get_calendars": {
        const p = new URLSearchParams({ locationId });
        if (input.showActive !== undefined) p.set("showActive", String(input.showActive));
        const r = await fetch(`${BASE}/calendars/?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_calendar_slots": {
        const p = new URLSearchParams({ startDate: String(input.startDate), endDate: String(input.endDate) });
        if (input.timezone) p.set("timezone", input.timezone);
        const r = await fetch(`${BASE}/calendars/${input.calendarId}/free-slots?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_appointments": {
        const p = new URLSearchParams({ locationId });
        if (input.calendarId) p.set("calendarId", input.calendarId);
        if (input.startTime) p.set("startTime", String(input.startTime));
        if (input.endTime) p.set("endTime", String(input.endTime));
        if (input.userId) p.set("userId", input.userId);
        const r = await fetch(`${BASE}/calendars/events?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_create_appointment": {
        const r = await fetch(`${BASE}/calendars/events/appointments`, { method: "POST", headers: h,
          body: JSON.stringify({ ...input, locationId }) });
        return await r.json();
      }
      case "ghl_update_appointment": {
        const { appointmentId, ...body } = input;
        const r = await fetch(`${BASE}/calendars/events/appointments/${appointmentId}`, { method: "PUT", headers: h, body: JSON.stringify(body) });
        return await r.json();
      }
      case "ghl_delete_appointment": {
        const r = await fetch(`${BASE}/calendars/events/${input.appointmentId}`, { method: "DELETE", headers: h });
        return await r.json();
      }

      // ── WORKFLOWS ──
      case "ghl_get_workflows": {
        const r = await fetch(`${BASE}/workflows/?locationId=${locationId}`, { headers: h });
        return await r.json();
      }
      case "ghl_add_contact_to_workflow": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/workflow/${input.workflowId}`, { method: "POST", headers: h,
          body: JSON.stringify({ eventStartTime: input.eventStartTime }) });
        return await r.json();
      }
      case "ghl_remove_contact_from_workflow": {
        const r = await fetch(`${BASE}/contacts/${input.contactId}/workflow/${input.workflowId}`, { method: "DELETE", headers: h });
        return await r.json();
      }

      // ── CAMPAIGNS ──
      case "ghl_get_campaigns": {
        const p = new URLSearchParams({ locationId });
        if (input.status) p.set("status", input.status);
        const r = await fetch(`${BASE}/campaigns/?${p}`, { headers: h });
        return await r.json();
      }

      // ── FORMS & SURVEYS ──
      case "ghl_get_forms": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.skip) p.set("skip", String(input.skip));
        if (input.type) p.set("type", input.type);
        const r = await fetch(`${BASE}/forms/?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_form_submissions": {
        const p = new URLSearchParams({ locationId, formId: input.formId, limit: String(input.limit || 20) });
        if (input.startAt) p.set("startAt", String(input.startAt));
        if (input.endAt) p.set("endAt", String(input.endAt));
        const r = await fetch(`${BASE}/forms/submissions?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_surveys": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.skip) p.set("skip", String(input.skip));
        const r = await fetch(`${BASE}/surveys/?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_survey_submissions": {
        const p = new URLSearchParams({ locationId, surveyId: input.surveyId, limit: String(input.limit || 20) });
        if (input.startAt) p.set("startAt", String(input.startAt));
        if (input.endAt) p.set("endAt", String(input.endAt));
        const r = await fetch(`${BASE}/surveys/submissions?${p}`, { headers: h });
        return await r.json();
      }

      // ── USERS ──
      case "ghl_get_users": {
        const r = await fetch(`${BASE}/users/?locationId=${locationId}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_user": {
        const r = await fetch(`${BASE}/users/${input.userId}`, { headers: h });
        return await r.json();
      }

      // ── LOCATION ──
      case "ghl_get_location": {
        const r = await fetch(`${BASE}/locations/${locationId}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_custom_fields": {
        const p = new URLSearchParams({ locationId });
        if (input.model && input.model !== "all") p.set("model", input.model);
        const r = await fetch(`${BASE}/locations/customFields?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_tags": {
        const r = await fetch(`${BASE}/locations/${locationId}/tags`, { headers: h });
        return await r.json();
      }

      // ── PAYMENTS ──
      case "ghl_get_orders": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.contactId) p.set("altId", input.contactId);
        if (input.offset) p.set("offset", String(input.offset));
        if (input.status) p.set("paymentStatus", input.status);
        const r = await fetch(`${BASE}/payments/orders?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_order": {
        const r = await fetch(`${BASE}/payments/orders/${input.orderId}?locationId=${locationId}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_transactions": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.contactId) p.set("contactId", input.contactId);
        if (input.offset) p.set("offset", String(input.offset));
        const r = await fetch(`${BASE}/payments/transactions?${p}`, { headers: h });
        return await r.json();
      }

      // ── INVOICES ──
      case "ghl_get_invoices": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.contactId) p.set("contactId", input.contactId);
        if (input.status) p.set("status", input.status);
        const r = await fetch(`${BASE}/invoices/?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_invoice": {
        const r = await fetch(`${BASE}/invoices/${input.invoiceId}`, { headers: h });
        return await r.json();
      }
      case "ghl_send_invoice": {
        const r = await fetch(`${BASE}/invoices/${input.invoiceId}/send`, { method: "POST", headers: h, body: JSON.stringify({}) });
        return await r.json();
      }
      case "ghl_void_invoice": {
        const r = await fetch(`${BASE}/invoices/${input.invoiceId}/void`, { method: "POST", headers: h, body: JSON.stringify({}) });
        return await r.json();
      }

      // ── SOCIAL PLANNER ──
      case "ghl_get_social_posts": {
        const p = new URLSearchParams({ locationId, limit: String(input.limit || 20) });
        if (input.startDate) p.set("startDate", String(input.startDate));
        if (input.endDate) p.set("endDate", String(input.endDate));
        const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts?${p}`, { headers: h });
        return await r.json();
      }

      // ── TRIGGER LINKS ──
      case "ghl_get_trigger_links": {
        const r = await fetch(`${BASE}/links/?locationId=${locationId}`, { headers: h });
        return await r.json();
      }

      // ── CONTACTS UPSERT ──
      case "ghl_upsert_contact": {
        const r = await fetch(`${BASE}/contacts/upsert`, {
          method: "POST", headers: h,
          body: JSON.stringify({ ...input, locationId })
        });
        return await r.json();
      }

      // ── SOCIAL MEDIA POSTING (FULL) ──
      case "ghl_get_social_accounts": {
        const r = await fetch(`${BASE}/social-media-posting/oauth/${locationId}/accounts`, { headers: h });
        return await r.json();
      }
      case "ghl_get_social_post": {
        const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts/${input.postId}`, { headers: h });
        return await r.json();
      }
      case "ghl_create_social_post": {
        const body = {
          locationId,
          accountIds: input.accountIds,
          body: input.body,
          ...(input.scheduleDate && { scheduleDate: input.scheduleDate }),
          ...(input.mediaUrls?.length && { mediaUrls: input.mediaUrls }),
          ...(input.tags?.length && { tags: input.tags })
        };
        const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts`, {
          method: "POST", headers: h, body: JSON.stringify(body)
        });
        return await r.json();
      }
      case "ghl_edit_social_post": {
        const { postId, ...body } = input;
        const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts/${postId}`, {
          method: "PUT", headers: h, body: JSON.stringify({ ...body, locationId })
        });
        return await r.json();
      }
      case "ghl_get_social_statistics": {
        const body = {
          locationId,
          accountIds: input.accountIds,
          ...(input.startDate && { startDate: input.startDate }),
          ...(input.endDate && { endDate: input.endDate })
        };
        const r = await fetch(`${BASE}/social-media-posting/${locationId}/analytics`, {
          method: "POST", headers: h, body: JSON.stringify(body)
        });
        return await r.json();
      }

      // ── BLOGS (FULL) ──
      case "ghl_get_blogs": {
        const p = new URLSearchParams({ locationId });
        if (input.skip) p.set("skip", String(input.skip));
        if (input.limit) p.set("limit", String(input.limit || 10));
        const r = await fetch(`${BASE}/blogs/?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_blog_posts": {
        const p = new URLSearchParams({ locationId, blogId: input.blogId });
        if (input.status) p.set("status", input.status);
        if (input.limit) p.set("limit", String(input.limit || 10));
        if (input.offset) p.set("offset", String(input.offset));
        if (input.searchTerm) p.set("searchTerm", input.searchTerm);
        const r = await fetch(`${BASE}/blogs/posts?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_create_blog_post": {
        const r = await fetch(`${BASE}/blogs/posts`, {
          method: "POST", headers: h,
          body: JSON.stringify({ ...input, locationId })
        });
        return await r.json();
      }
      case "ghl_update_blog_post": {
        const { postId, blogId, ...body } = input;
        const r = await fetch(`${BASE}/blogs/posts/${postId}`, {
          method: "PUT", headers: h,
          body: JSON.stringify({ ...body, locationId, blogId })
        });
        return await r.json();
      }
      case "ghl_check_blog_slug": {
        const p = new URLSearchParams({ locationId, blogId: input.blogId, urlSlug: input.urlSlug });
        const r = await fetch(`${BASE}/blogs/posts/url-slug-exists?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_blog_categories": {
        const p = new URLSearchParams({ locationId });
        if (input.limit) p.set("limit", String(input.limit || 10));
        if (input.skip) p.set("skip", String(input.skip));
        const r = await fetch(`${BASE}/blogs/categories?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_get_blog_authors": {
        const p = new URLSearchParams({ locationId });
        if (input.limit) p.set("limit", String(input.limit || 10));
        if (input.skip) p.set("skip", String(input.skip));
        const r = await fetch(`${BASE}/blogs/authors?${p}`, { headers: h });
        return await r.json();
      }

      // ── EMAIL TEMPLATES ──
      case "ghl_get_email_templates": {
        const p = new URLSearchParams({ locationId });
        if (input.limit) p.set("limit", String(input.limit || 10));
        if (input.skip) p.set("skip", String(input.skip));
        if (input.type) p.set("type", input.type);
        if (input.search) p.set("search", input.search);
        const r = await fetch(`${BASE}/emails/templates?${p}`, { headers: h });
        return await r.json();
      }
      case "ghl_create_email_template": {
        const r = await fetch(`${BASE}/emails/templates`, {
          method: "POST", headers: h,
          body: JSON.stringify({ ...input, locationId })
        });
        return await r.json();
      }

      // ── PDF READER ──
      case "read_pdf_from_url": {
        const pdfResult = await fetchPdfText(input.url);
        if (pdfResult.error) return pdfResult;
        return {
          success: true,
          text: pdfResult.text,
          charCount: pdfResult.charCount,
          truncated: pdfResult.truncated || false,
          contactId: input.contactId || null,
          contactName: input.contactName || null,
          sourceUrl: input.url
        };
      }

      // ── INTERNAL COMMENT ──
      case "ghl_create_internal_comment": {
        // GHL internal comments go via the conversations messages endpoint
        // First get or create the conversation for this contact
        const convSearch = await fetch(
          `${BASE}/conversations/search?locationId=${locationId}&contactId=${input.contactId}`,
          { headers: h2 }
        );
        const convData = await convSearch.json();
        let conversationId = convData.conversations?.[0]?.id;

        // Create conversation if none exists
        if (!conversationId) {
          const newConv = await fetch(`${BASE}/conversations/`, {
            method: "POST", headers: h2,
            body: JSON.stringify({ contactId: input.contactId, locationId })
          });
          const newConvData = await newConv.json();
          conversationId = newConvData.conversation?.id || newConvData.id;
        }

        if (!conversationId) {
          return { error: "Could not find or create conversation for this contact" };
        }

        // Post as TYPE_ACTIVITY (internal note visible only to team)
        const r = await fetch(`${BASE}/conversations/messages`, {
          method: "POST", headers: h2,
          body: JSON.stringify({
            type: "TYPE_ACTIVITY_CONTACT",
            locationId,
            conversationId,
            contactId: input.contactId,
            message: input.message
          })
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

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  const agent = await verifyAgent(event.headers.authorization);
  if (!agent) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "Unauthorized" }) };

  const path = event.path.replace("/.netlify/functions/chat", "").replace("/api/chat", "");

  if (event.httpMethod === "GET" && path.includes("sessions")) {
    const subAccountId = event.queryStringParameters?.subAccountId;
    let query = supabase.from("sessions").select("id, title, created_at, last_active, message_count, sub_account_id")
      .eq("agent_id", agent.id).order("last_active", { ascending: false });
    if (subAccountId) query = query.eq("sub_account_id", subAccountId);
    const { data } = await query;
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sessions: data || [] }) };
  }

  if (event.httpMethod === "POST" && path.includes("session")) {
    const { subAccountId, title } = JSON.parse(event.body || "{}");
    const { data: assignment } = await supabase.from("agent_sub_accounts")
      .select("id").eq("agent_id", agent.id).eq("sub_account_id", subAccountId).single();
    if (!assignment) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Not assigned to this sub-account" }) };
    const { data: session, error } = await supabase.from("sessions")
      .insert({ agent_id: agent.id, sub_account_id: subAccountId, title: title || "New Chat" }).select().single();
    if (error) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: cors, body: JSON.stringify({ session }) };
  }

  if (event.httpMethod === "GET" && path.includes("history")) {
    const sessionId = event.queryStringParameters?.sessionId;
    const session = await getSessionContext(sessionId, agent.id);
    if (!session) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Session not found" }) };
    const { data } = await supabase.from("messages").select("role, content, created_at")
      .eq("session_id", sessionId).order("created_at", { ascending: true }).limit(100);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ messages: data || [], session }) };
  }

  if (event.httpMethod === "POST") {
    const { message, sessionId, history = [] } = JSON.parse(event.body || "{}");
    if (!message || !sessionId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "message and sessionId required" }) };

    const session = await getSessionContext(sessionId, agent.id);
    if (!session) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Session not found or access denied" }) };

    const { location_id, api_token, name: subAccountName } = session.sub_accounts;

    await supabase.from("messages").insert({ session_id: sessionId, role: "user", content: message });

    const SYSTEM = `You are the B-E-S-Team AI Assistant — a smart, professional CRM assistant built exclusively for B-E-S-Team.

You are currently working with the B-E-S-Team CRM account: "${subAccountName}".

IMPORTANT RULES:
- Never mention "GoHighLevel", "GHL", "HighLevel" or any third-party platform name under any circumstances
- Always refer to the CRM as "B-E-S-Team CRM"
- Always refer to the system as "B-E-S-Team platform"
- If asked what CRM or software powers this, say it is a proprietary B-E-S-Team platform
- Be concise, action-oriented, and confirm what you've done after each action

YOU HAVE FULL ACCESS TO THESE B-E-S-TEAM CRM CAPABILITIES:

CONTACTS: search, get, create, update, delete, upsert (create-or-update), add/remove tags, notes, tasks, appointments
CONVERSATIONS: search conversations, read full message threads (SMS/Email/WhatsApp/FB/IG), send messages on any channel, create & update conversations
OPPORTUNITIES: full pipeline management — search, create, update, delete opportunities across all stages
CALENDARS: list calendars, check free slots, view appointments, create/update/delete appointments
WORKFLOWS: list workflows, add or remove contacts from automations
CAMPAIGNS: list all campaigns
FORMS & SURVEYS: list forms/surveys, get submissions
USERS: list team members, get user details
PAYMENTS: list orders, get order details, list transactions
INVOICES: list, view, send, void invoices
SOCIAL MEDIA: list connected accounts, get/create/edit posts, get analytics/statistics
BLOGS: list blog sites, get/create/update blog posts, manage categories and authors, check URL slugs
EMAIL TEMPLATES: list and create email templates
LOCATION: get account info, custom fields, tags, trigger links

TOOL USAGE GUIDELINES:
- For conversations: use ghl_search_conversations first to find the thread, then ghl_get_messages to read messages
- For new contacts where you are unsure if they exist: use ghl_upsert_contact to avoid duplicates
- For blog posts: always use ghl_check_blog_slug before creating to ensure the slug is available
- For social posts: use ghl_get_social_accounts first to get account IDs, then ghl_create_social_post
- Always confirm completed actions clearly to the agent

PDF SUMMARY WORKFLOW — follow this EXACTLY whenever a PDF is involved:
STEP 1: When reading a contact and you find any custom field containing a URL that ends in .pdf or looks like a document link, automatically call read_pdf_from_url with that URL.
STEP 2: After successfully reading the PDF, generate a structured summary with these sections:
  - **Document Type** (what kind of document is it?)
  - **Key Information** (main facts, figures, names, dates)
  - **Important Points** (bullet list of critical details)
  - **Action Items** (anything that requires follow-up)
STEP 3: Present the summary clearly to the agent, then ALWAYS ask exactly this:
  "Where would you like me to save this summary?
  **A) Internal Comment** — visible to team only, saved to the contact activity feed
  **B) Contact Note** — saved to the contact's notes tab"
STEP 4: Wait for the agent's reply (A or B, or "internal"/"note", or similar).
STEP 5a: If agent chooses Internal Comment → call ghl_create_internal_comment with the full summary
STEP 5b: If agent chooses Contact Note → call ghl_create_contact_note with the full summary
STEP 6: Confirm where it was saved with a brief message.

INTERNAL COMMENT vs CONTACT NOTE:
- Internal Comment: goes into the contact's conversation/activity feed. Only team members see it. Good for operational notes, analysis, private observations.
- Contact Note: goes into the Notes tab on the contact record. Good for reference information, background context, summaries.

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

    if (history.length === 0) {
      const title = message.slice(0, 50) + (message.length > 50 ? "…" : "");
      await supabase.from("sessions").update({ title }).eq("id", sessionId);
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ reply: finalText }) };
  }

  return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Not found" }) };
};
