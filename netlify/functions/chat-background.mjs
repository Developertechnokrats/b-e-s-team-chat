// ─────────────────────────────────────────────────────────────────
// B-E-S-Team Chat — Background Function
// Runs up to 15 minutes — no timeout pressure
// Stores result in Supabase, frontend polls for it
// ─────────────────────────────────────────────────────────────────
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function verifyAgent(token) {
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
// Detect GHL document viewer URLs and try to get the raw document
function detectDocumentType(url) {
  const u = url.toLowerCase();
  // GHL document viewer patterns
  if (u.includes("/document-viewer/")) return "ghl_viewer";
  if (u.includes("leadconnectorhq.com") && u.includes("/proposals/")) return "ghl_proposal";
  if (u.includes("leadconnectorhq.com") && u.includes("/documents/")) return "ghl_document";
  if (u.includes(".pdf")) return "pdf";
  return "unknown";
}

// Decode GHL viewer URL slug to document ID and fetch via API
async function resolveGHLViewerUrl(url, apiToken, locationId) {
  try {
    // Extract slug from URL: /document-viewer/YTQyNXRvc2xnN3pi
    const slugMatch = url.match(/\/document-viewer\/([A-Za-z0-9+/=_-]+)/);
    if (!slugMatch) return null;

    const slug = slugMatch[1];

    // Decode base64 to get document ID
    let documentId;
    try {
      documentId = Buffer.from(slug, "base64").toString("utf8").trim();
    } catch (e) {
      documentId = slug; // use as-is if not base64
    }

    console.log("Decoded document ID:", documentId);

    const BASE = "https://services.leadconnectorhq.com";
    const headers = {
      Authorization: "Bearer " + apiToken,
      "Content-Type": "application/json",
      Version: "2021-07-28"
    };

    // Try GHL Proposals API
    const proposalRes = await fetch(`${BASE}/proposals/${documentId}?locationId=${locationId}`, { headers });
    if (proposalRes.ok) {
      const proposal = await proposalRes.json();
      // Extract all text fields from the proposal
      let text = "";
      if (proposal.name) text += "Document: " + proposal.name + "\n\n";
      if (proposal.status) text += "Status: " + proposal.status + "\n";
      if (proposal.createdAt) text += "Created: " + proposal.createdAt + "\n\n";

      // Walk through proposal sections/pages for content
      const blocks = proposal.pages || proposal.sections || proposal.blocks || proposal.content || [];
      function extractText(obj) {
        if (!obj) return;
        if (typeof obj === "string") { text += obj + "\n"; return; }
        if (Array.isArray(obj)) { obj.forEach(extractText); return; }
        if (typeof obj === "object") {
          const textFields = ["text", "content", "value", "label", "description", "title", "html", "body"];
          textFields.forEach(f => { if (obj[f] && typeof obj[f] === "string") text += obj[f] + "\n"; });
          Object.values(obj).forEach(v => { if (typeof v === "object") extractText(v); });
        }
      }
      extractText(blocks);
      // Also check top-level fields
      extractText(proposal.document);
      extractText(proposal.data);

      // Strip HTML tags from any HTML content
      text = text.replace(/<[^>]+>/g, " ").replace(/\s{3,}/g, "\n").trim();

      if (text.length > 100) {
        return { docText: text, documentId, docName: proposal.name || "Document" };
      }
    }

    // Try Documents API (different endpoint)
    const docRes = await fetch(`${BASE}/documents/${documentId}?locationId=${locationId}`, { headers });
    if (docRes.ok) {
      const doc = await docRes.json();
      let text = "";
      if (doc.name || doc.title) text += "Document: " + (doc.name || doc.title) + "\n\n";
      if (doc.status) text += "Status: " + doc.status + "\n\n";
      function extractText2(obj) {
        if (!obj) return;
        if (typeof obj === "string" && obj.length > 1) { text += obj + "\n"; return; }
        if (Array.isArray(obj)) { obj.forEach(extractText2); return; }
        if (typeof obj === "object") {
          const textFields = ["text", "content", "value", "label", "description", "title", "html", "body", "name"];
          textFields.forEach(f => { if (obj[f] && typeof obj[f] === "string") text += obj[f] + "\n"; });
          Object.values(obj).forEach(v => { if (typeof v === "object") extractText2(v); });
        }
      }
      extractText2(doc);
      text = text.replace(/<[^>]+>/g, " ").replace(/\s{3,}/g, "\n").trim();
      if (text.length > 100) {
        return { docText: text, documentId, docName: doc.name || doc.title || "Document" };
      }
    }

    // Try to get a PDF download URL from the document
    const pdfRes = await fetch(`${BASE}/proposals/${documentId}/pdf?locationId=${locationId}`, { headers });
    if (pdfRes.ok) {
      const pdfData = await pdfRes.json();
      const pdfUrl = pdfData.url || pdfData.downloadUrl || pdfData.pdfUrl;
      if (pdfUrl) return { pdfUrl };
    }

    return { documentId, notFound: true };
  } catch (err) {
    console.error("resolveGHLViewerUrl error:", err.message);
    return null;
  }
}

async function fetchPdfText(url, apiToken, locationId) {
  try {
    const docType = detectDocumentType(url);

    // Handle viewer-style URLs — the URL IS the PDF, just needs browser headers
    if (docType === "ghl_viewer" || docType === "ghl_proposal" || docType === "ghl_document") {
      // Fall through — fetch the URL directly with browser headers below
      // No need to decode or call GHL API — it's an external PDF served from S3
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/pdf,application/octet-stream,*/*;q=0.9",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": new URL(url).origin + "/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin"
      }
    });
    if (!response.ok) return { error: "Failed to fetch PDF: HTTP " + response.status };
    const contentType = response.headers.get("content-type") || "";
    const urlLower = url.toLowerCase();
    const isPdf = contentType.includes("pdf") || urlLower.includes(".pdf") ||
                  contentType.includes("octet-stream") || docType === "ghl_viewer";

    // If it's HTML, try extracting text from it
    if (contentType.includes("html") && !isPdf) {
      const html = await response.text();
      const textContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ").replace(/\s{3,}/g, "\n").trim();
      if (textContent.length > 200) {
        return { text: textContent.slice(0, 15000), charCount: textContent.length, truncated: false, source: "html" };
      }
      return { error: "URL is an HTML page with no extractable text content." };
    }

    if (!isPdf) return { error: "URL does not appear to be a PDF (content-type: " + contentType + ")" };

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder("latin1");
    const raw = decoder.decode(bytes);
    let text = "";

    let btIdx = 0;
    while (true) {
      const btPos = raw.indexOf("BT", btIdx);
      if (btPos === -1) break;
      const etPos = raw.indexOf("ET", btPos + 2);
      if (etPos === -1) break;
      const block = raw.slice(btPos + 2, etPos);
      btIdx = etPos + 2;
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
          } else { i++; }
        } else { i++; }
      }
    }

    text = text.replace(/[ \t]{3,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 50) {
      return { error: "Could not extract readable text. PDF may be image/scanned. Please use a text-based PDF." };
    }
    return { text: text.slice(0, 15000), charCount: text.length, truncated: text.length > 15000 };
  } catch (err) {
    return { error: "PDF fetch error: " + err.message };
  }
}

// ── All GHL Tools (same as chat.mjs) ─────────────────────────────
const GHL_TOOLS = [
  { name: "ghl_get_contacts", description: "Search and list contacts in the CRM. Filter by name, email, phone, or tags.", input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, skip: { type: "number" }, tags: { type: "array", items: { type: "string" } } } } },
  { name: "ghl_get_contact", description: "Get full details of a single contact by their contact ID.", input_schema: { type: "object", properties: { contactId: { type: "string" } }, required: ["contactId"] } },
  { name: "ghl_create_contact", description: "Create a new contact in the CRM.", input_schema: { type: "object", properties: { firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, address1: { type: "string" }, city: { type: "string" }, state: { type: "string" }, postalCode: { type: "string" }, country: { type: "string" }, companyName: { type: "string" }, website: { type: "string" }, tags: { type: "array", items: { type: "string" } }, source: { type: "string" }, customFields: { type: "array", items: { type: "object" } } }, required: ["firstName"] } },
  { name: "ghl_update_contact", description: "Update an existing contact's details.", input_schema: { type: "object", properties: { contactId: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, companyName: { type: "string" }, tags: { type: "array", items: { type: "string" } }, customFields: { type: "array", items: { type: "object" } } }, required: ["contactId"] } },
  { name: "ghl_delete_contact", description: "Delete a contact permanently.", input_schema: { type: "object", properties: { contactId: { type: "string" } }, required: ["contactId"] } },
  { name: "ghl_upsert_contact", description: "Create or update a contact based on email/phone match. Prevents duplicates.", input_schema: { type: "object", properties: { firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, companyName: { type: "string" }, tags: { type: "array", items: { type: "string" } }, customFields: { type: "array", items: { type: "object" } } }, required: ["email"] } },
  { name: "ghl_add_tags", description: "Add tags to a contact.", input_schema: { type: "object", properties: { contactId: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["contactId", "tags"] } },
  { name: "ghl_remove_tags", description: "Remove tags from a contact.", input_schema: { type: "object", properties: { contactId: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["contactId", "tags"] } },
  { name: "ghl_get_contact_notes", description: "Get all notes for a contact.", input_schema: { type: "object", properties: { contactId: { type: "string" } }, required: ["contactId"] } },
  { name: "ghl_create_contact_note", description: "Add a note to a contact record.", input_schema: { type: "object", properties: { contactId: { type: "string" }, body: { type: "string" } }, required: ["contactId", "body"] } },
  { name: "ghl_get_contact_tasks", description: "Get all tasks for a contact.", input_schema: { type: "object", properties: { contactId: { type: "string" } }, required: ["contactId"] } },
  { name: "ghl_create_task", description: "Create a task for a contact.", input_schema: { type: "object", properties: { contactId: { type: "string" }, title: { type: "string" }, dueDate: { type: "string" }, description: { type: "string" }, assignedTo: { type: "string" } }, required: ["contactId", "title"] } },
  { name: "ghl_update_task", description: "Update or complete a task.", input_schema: { type: "object", properties: { contactId: { type: "string" }, taskId: { type: "string" }, title: { type: "string" }, dueDate: { type: "string" }, completed: { type: "boolean" } }, required: ["contactId", "taskId"] } },
  { name: "ghl_get_contact_appointments", description: "Get all appointments for a contact.", input_schema: { type: "object", properties: { contactId: { type: "string" } }, required: ["contactId"] } },
  { name: "ghl_search_conversations", description: "Search and list conversations.", input_schema: { type: "object", properties: { contactId: { type: "string" }, query: { type: "string" }, limit: { type: "number" }, status: { type: "string" }, assignedTo: { type: "string" } } } },
  { name: "ghl_get_conversation", description: "Get full details of a conversation.", input_schema: { type: "object", properties: { conversationId: { type: "string" } }, required: ["conversationId"] } },
  { name: "ghl_get_messages", description: "Get all messages in a conversation thread.", input_schema: { type: "object", properties: { conversationId: { type: "string" }, limit: { type: "number" }, lastMessageId: { type: "string" } }, required: ["conversationId"] } },
  { name: "ghl_send_message", description: "Send a message to a contact via SMS, Email, WhatsApp, FB, IG.", input_schema: { type: "object", properties: { conversationId: { type: "string" }, contactId: { type: "string" }, type: { type: "string", enum: ["SMS", "Email", "WhatsApp", "IG", "FB", "Custom"] }, message: { type: "string" }, subject: { type: "string" }, html: { type: "string" } }, required: ["type", "message"] } },
  { name: "ghl_create_conversation", description: "Create a new conversation thread with a contact.", input_schema: { type: "object", properties: { contactId: { type: "string" }, userId: { type: "string" } }, required: ["contactId"] } },
  { name: "ghl_update_conversation", description: "Update conversation status — mark as read, starred, or assign to user.", input_schema: { type: "object", properties: { conversationId: { type: "string" }, unreadCount: { type: "number" }, starred: { type: "boolean" }, assignedTo: { type: "string" } }, required: ["conversationId"] } },
  { name: "ghl_create_internal_comment", description: "Add an internal comment to a contact activity feed. Only visible to team members, never to the contact.", input_schema: { type: "object", properties: { contactId: { type: "string" }, message: { type: "string" } }, required: ["contactId", "message"] } },
  { name: "ghl_get_pipelines", description: "Get all sales pipelines and stages.", input_schema: { type: "object", properties: {} } },
  { name: "ghl_search_opportunities", description: "Search opportunities/deals across pipelines.", input_schema: { type: "object", properties: { pipelineId: { type: "string" }, pipelineStageId: { type: "string" }, contactId: { type: "string" }, status: { type: "string" }, assignedTo: { type: "string" }, query: { type: "string" }, limit: { type: "number" } } } },
  { name: "ghl_get_opportunity", description: "Get full details of a specific opportunity.", input_schema: { type: "object", properties: { opportunityId: { type: "string" } }, required: ["opportunityId"] } },
  { name: "ghl_create_opportunity", description: "Create a new deal/opportunity in a pipeline.", input_schema: { type: "object", properties: { name: { type: "string" }, pipelineId: { type: "string" }, pipelineStageId: { type: "string" }, contactId: { type: "string" }, monetaryValue: { type: "number" }, status: { type: "string" }, assignedTo: { type: "string" } }, required: ["name", "pipelineId", "pipelineStageId", "contactId"] } },
  { name: "ghl_update_opportunity", description: "Update an opportunity — move stage, change value, update status.", input_schema: { type: "object", properties: { opportunityId: { type: "string" }, name: { type: "string" }, pipelineStageId: { type: "string" }, status: { type: "string" }, monetaryValue: { type: "number" }, assignedTo: { type: "string" } }, required: ["opportunityId"] } },
  { name: "ghl_delete_opportunity", description: "Delete an opportunity permanently.", input_schema: { type: "object", properties: { opportunityId: { type: "string" } }, required: ["opportunityId"] } },
  { name: "ghl_get_calendars", description: "List all available booking calendars.", input_schema: { type: "object", properties: { showActive: { type: "boolean" } } } },
  { name: "ghl_get_calendar_slots", description: "Get available time slots for a calendar.", input_schema: { type: "object", properties: { calendarId: { type: "string" }, startDate: { type: "number" }, endDate: { type: "number" }, timezone: { type: "string" } }, required: ["calendarId", "startDate", "endDate"] } },
  { name: "ghl_get_appointments", description: "Get appointments within a date range.", input_schema: { type: "object", properties: { calendarId: { type: "string" }, startTime: { type: "number" }, endTime: { type: "number" }, userId: { type: "string" } } } },
  { name: "ghl_create_appointment", description: "Book an appointment for a contact.", input_schema: { type: "object", properties: { calendarId: { type: "string" }, contactId: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, title: { type: "string" }, appointmentStatus: { type: "string" }, assignedUserId: { type: "string" }, notes: { type: "string" } }, required: ["calendarId", "contactId", "startTime"] } },
  { name: "ghl_update_appointment", description: "Update an existing appointment.", input_schema: { type: "object", properties: { appointmentId: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, title: { type: "string" }, appointmentStatus: { type: "string" }, notes: { type: "string" } }, required: ["appointmentId"] } },
  { name: "ghl_delete_appointment", description: "Cancel/delete an appointment.", input_schema: { type: "object", properties: { appointmentId: { type: "string" } }, required: ["appointmentId"] } },
  { name: "ghl_get_workflows", description: "List all automation workflows.", input_schema: { type: "object", properties: {} } },
  { name: "ghl_add_contact_to_workflow", description: "Add a contact to an automation workflow.", input_schema: { type: "object", properties: { workflowId: { type: "string" }, contactId: { type: "string" }, eventStartTime: { type: "string" } }, required: ["workflowId", "contactId"] } },
  { name: "ghl_remove_contact_from_workflow", description: "Remove a contact from a workflow.", input_schema: { type: "object", properties: { workflowId: { type: "string" }, contactId: { type: "string" } }, required: ["workflowId", "contactId"] } },
  { name: "ghl_get_campaigns", description: "List all campaigns.", input_schema: { type: "object", properties: { status: { type: "string" } } } },
  { name: "ghl_get_forms", description: "List all forms.", input_schema: { type: "object", properties: { skip: { type: "number" }, limit: { type: "number" }, type: { type: "string" } } } },
  { name: "ghl_get_form_submissions", description: "Get submissions for a form.", input_schema: { type: "object", properties: { formId: { type: "string" }, startAt: { type: "number" }, endAt: { type: "number" }, limit: { type: "number" } }, required: ["formId"] } },
  { name: "ghl_get_surveys", description: "List all surveys.", input_schema: { type: "object", properties: { skip: { type: "number" }, limit: { type: "number" } } } },
  { name: "ghl_get_survey_submissions", description: "Get submissions for a survey.", input_schema: { type: "object", properties: { surveyId: { type: "string" }, startAt: { type: "number" }, endAt: { type: "number" }, limit: { type: "number" } }, required: ["surveyId"] } },
  { name: "ghl_get_users", description: "Get all team members.", input_schema: { type: "object", properties: {} } },
  { name: "ghl_get_user", description: "Get details of a specific user.", input_schema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "ghl_get_location", description: "Get details about the current account.", input_schema: { type: "object", properties: {} } },
  { name: "ghl_get_custom_fields", description: "Get all custom field definitions.", input_schema: { type: "object", properties: { model: { type: "string" } } } },
  { name: "ghl_get_tags", description: "Get all tags used in the account.", input_schema: { type: "object", properties: {} } },
  { name: "ghl_get_orders", description: "List payment orders.", input_schema: { type: "object", properties: { contactId: { type: "string" }, limit: { type: "number" }, offset: { type: "number" }, status: { type: "string" } } } },
  { name: "ghl_get_order", description: "Get a specific order by ID.", input_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] } },
  { name: "ghl_get_transactions", description: "List payment transactions.", input_schema: { type: "object", properties: { contactId: { type: "string" }, limit: { type: "number" }, offset: { type: "number" } } } },
  { name: "ghl_get_invoices", description: "List invoices.", input_schema: { type: "object", properties: { contactId: { type: "string" }, status: { type: "string" }, limit: { type: "number" } } } },
  { name: "ghl_get_invoice", description: "Get a specific invoice.", input_schema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] } },
  { name: "ghl_send_invoice", description: "Send an invoice to a contact.", input_schema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] } },
  { name: "ghl_void_invoice", description: "Void/cancel an invoice.", input_schema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] } },
  { name: "ghl_get_social_accounts", description: "Get all connected social media accounts.", input_schema: { type: "object", properties: {} } },
  { name: "ghl_get_social_post", description: "Get a specific social media post.", input_schema: { type: "object", properties: { postId: { type: "string" } }, required: ["postId"] } },
  { name: "ghl_get_social_posts", description: "Get scheduled/published social media posts.", input_schema: { type: "object", properties: { startDate: { type: "number" }, endDate: { type: "number" }, limit: { type: "number" } } } },
  { name: "ghl_create_social_post", description: "Create and schedule a social media post.", input_schema: { type: "object", properties: { accountIds: { type: "array", items: { type: "string" } }, body: { type: "string" }, scheduleDate: { type: "string" }, mediaUrls: { type: "array", items: { type: "string" } } }, required: ["accountIds", "body"] } },
  { name: "ghl_edit_social_post", description: "Edit an existing social media post.", input_schema: { type: "object", properties: { postId: { type: "string" }, body: { type: "string" }, scheduleDate: { type: "string" }, mediaUrls: { type: "array", items: { type: "string" } } }, required: ["postId"] } },
  { name: "ghl_get_social_statistics", description: "Get social media analytics.", input_schema: { type: "object", properties: { accountIds: { type: "array", items: { type: "string" } }, startDate: { type: "number" }, endDate: { type: "number" } }, required: ["accountIds"] } },
  { name: "ghl_get_blogs", description: "Get all blog sites.", input_schema: { type: "object", properties: { skip: { type: "number" }, limit: { type: "number" } } } },
  { name: "ghl_get_blog_posts", description: "Get blog posts for a blog site.", input_schema: { type: "object", properties: { blogId: { type: "string" }, status: { type: "string" }, limit: { type: "number" }, offset: { type: "number" }, searchTerm: { type: "string" } }, required: ["blogId"] } },
  { name: "ghl_create_blog_post", description: "Create a new blog post.", input_schema: { type: "object", properties: { blogId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, imageUrl: { type: "string" }, status: { type: "string" }, publishedAt: { type: "string" }, categories: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } }, urlSlug: { type: "string" }, metaTitle: { type: "string" }, metaDescription: { type: "string" } }, required: ["blogId", "title", "description", "urlSlug"] } },
  { name: "ghl_update_blog_post", description: "Update an existing blog post.", input_schema: { type: "object", properties: { blogId: { type: "string" }, postId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, urlSlug: { type: "string" } }, required: ["blogId", "postId"] } },
  { name: "ghl_check_blog_slug", description: "Check if a URL slug is available.", input_schema: { type: "object", properties: { blogId: { type: "string" }, urlSlug: { type: "string" } }, required: ["blogId", "urlSlug"] } },
  { name: "ghl_get_blog_categories", description: "Get all blog categories.", input_schema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "ghl_get_blog_authors", description: "Get all blog authors.", input_schema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "ghl_get_email_templates", description: "Get all email templates.", input_schema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" }, type: { type: "string" }, search: { type: "string" } } } },
  { name: "ghl_create_email_template", description: "Create a new email template.", input_schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, previewText: { type: "string" } }, required: ["name", "type"] } },
  { name: "ghl_get_trigger_links", description: "Get all trigger links.", input_schema: { type: "object", properties: {} } },
  { name: "read_pdf_from_url", description: "Fetch and extract text from a PDF URL. Use when a contact has a PDF link in custom fields. After reading, generate a structured summary then ask the agent: Save as Internal Comment or Contact Note?", input_schema: { type: "object", properties: { url: { type: "string" }, contactId: { type: "string" }, contactName: { type: "string" } }, required: ["url"] } }
];

// ── GHL executor (identical logic to chat.mjs) ────────────────────
async function executeGHLTool(toolName, input, locationId, apiToken) {
  const BASE = "https://services.leadconnectorhq.com";
  const h = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json", Version: "2021-07-28" };
  const h2 = { ...h, Version: "2023-02-21" };
  try {
    switch (toolName) {
      case "read_pdf_from_url": {
        const r = await fetchPdfText(input.url, apiToken, locationId);
        if (r.error === "VIEWER_PAGE") {
          return {
            success: false,
            isViewerPage: true,
            viewerUrl: r.viewerUrl,
            documentId: r.documentId || null,
            message: r.message
          };
        }
        if (r.error) return r;
        return { success: true, text: r.text, charCount: r.charCount, truncated: r.truncated || false, source: r.source || "pdf", docName: r.docName || null, contactId: input.contactId || null, contactName: input.contactName || null };
      }
      case "ghl_get_contacts": { const p = new URLSearchParams({ locationId, limit: String(input.limit||20) }); if (input.query) p.set("query", input.query); if (input.skip) p.set("skip", String(input.skip)); const r = await fetch(`${BASE}/contacts/?${p}`, { headers: h }); return await r.json(); }
      case "ghl_get_contact": { const r = await fetch(`${BASE}/contacts/${input.contactId}`, { headers: h }); return await r.json(); }
      case "ghl_create_contact": { const r = await fetch(`${BASE}/contacts/`, { method:"POST", headers:h, body:JSON.stringify({...input,locationId}) }); return await r.json(); }
      case "ghl_update_contact": { const {contactId,...body}=input; const r = await fetch(`${BASE}/contacts/${contactId}`, { method:"PUT", headers:h, body:JSON.stringify(body) }); return await r.json(); }
      case "ghl_delete_contact": { const r = await fetch(`${BASE}/contacts/${input.contactId}`, { method:"DELETE", headers:h }); return await r.json(); }
      case "ghl_upsert_contact": { const r = await fetch(`${BASE}/contacts/upsert`, { method:"POST", headers:h, body:JSON.stringify({...input,locationId}) }); return await r.json(); }
      case "ghl_add_tags": { const r = await fetch(`${BASE}/contacts/${input.contactId}/tags`, { method:"POST", headers:h, body:JSON.stringify({tags:input.tags}) }); return await r.json(); }
      case "ghl_remove_tags": { const r = await fetch(`${BASE}/contacts/${input.contactId}/tags`, { method:"DELETE", headers:h, body:JSON.stringify({tags:input.tags}) }); return await r.json(); }
      case "ghl_get_contact_notes": { const r = await fetch(`${BASE}/contacts/${input.contactId}/notes`, { headers:h }); return await r.json(); }
      case "ghl_create_contact_note": { const r = await fetch(`${BASE}/contacts/${input.contactId}/notes`, { method:"POST", headers:h, body:JSON.stringify({body:input.body}) }); return await r.json(); }
      case "ghl_get_contact_tasks": { const r = await fetch(`${BASE}/contacts/${input.contactId}/tasks`, { headers:h }); return await r.json(); }
      case "ghl_create_task": { const r = await fetch(`${BASE}/contacts/${input.contactId}/tasks`, { method:"POST", headers:h, body:JSON.stringify({title:input.title,dueDate:input.dueDate||new Date(Date.now()+86400000).toISOString(),description:input.description||"",completed:false,assignedTo:input.assignedTo}) }); return await r.json(); }
      case "ghl_update_task": { const r = await fetch(`${BASE}/contacts/${input.contactId}/tasks/${input.taskId}`, { method:"PUT", headers:h, body:JSON.stringify({title:input.title,dueDate:input.dueDate,completed:input.completed}) }); return await r.json(); }
      case "ghl_get_contact_appointments": { const r = await fetch(`${BASE}/contacts/${input.contactId}/appointments`, { headers:h }); return await r.json(); }
      case "ghl_search_conversations": { const p = new URLSearchParams({locationId,limit:String(input.limit||20)}); if(input.contactId) p.set("contactId",input.contactId); if(input.query) p.set("query",input.query); if(input.status) p.set("status",input.status); if(input.assignedTo) p.set("assignedTo",input.assignedTo); const r = await fetch(`${BASE}/conversations/search?${p}`, {headers:h2}); return await r.json(); }
      case "ghl_get_conversation": { const r = await fetch(`${BASE}/conversations/${input.conversationId}`, {headers:h2}); return await r.json(); }
      case "ghl_get_messages": { const p = new URLSearchParams({limit:String(input.limit||20)}); if(input.lastMessageId) p.set("lastMessageId",input.lastMessageId); const r = await fetch(`${BASE}/conversations/${input.conversationId}/messages?${p}`, {headers:h2}); return await r.json(); }
      case "ghl_send_message": { const body={type:input.type,message:input.message,locationId,...(input.conversationId&&{conversationId:input.conversationId}),...(input.contactId&&{contactId:input.contactId}),...(input.subject&&{subject:input.subject}),...(input.html&&{html:input.html})}; const r = await fetch(`${BASE}/conversations/messages`, {method:"POST",headers:h2,body:JSON.stringify(body)}); return await r.json(); }
      case "ghl_create_conversation": { const r = await fetch(`${BASE}/conversations/`, {method:"POST",headers:h2,body:JSON.stringify({contactId:input.contactId,locationId,userId:input.userId})}); return await r.json(); }
      case "ghl_update_conversation": { const {conversationId,...body}=input; const r = await fetch(`${BASE}/conversations/${conversationId}`, {method:"PUT",headers:h2,body:JSON.stringify({...body,locationId})}); return await r.json(); }
      case "ghl_create_internal_comment": {
        const cs = await fetch(`${BASE}/conversations/search?locationId=${locationId}&contactId=${input.contactId}`, {headers:h2});
        const cd = await cs.json();
        let conversationId = cd.conversations?.[0]?.id;
        if (!conversationId) {
          const nc = await fetch(`${BASE}/conversations/`, {method:"POST",headers:h2,body:JSON.stringify({contactId:input.contactId,locationId})});
          const nd = await nc.json();
          conversationId = nd.conversation?.id || nd.id;
        }
        if (!conversationId) return { error: "Could not find or create conversation" };
        const r = await fetch(`${BASE}/conversations/messages`, {method:"POST",headers:h2,body:JSON.stringify({type:"TYPE_ACTIVITY_CONTACT",locationId,conversationId,contactId:input.contactId,message:input.message})});
        return await r.json();
      }
      case "ghl_get_pipelines": { const r = await fetch(`${BASE}/opportunities/pipelines?locationId=${locationId}`, {headers:h}); return await r.json(); }
      case "ghl_search_opportunities": { const p = new URLSearchParams({location_id:locationId,limit:String(input.limit||20)}); if(input.pipelineId) p.set("pipeline_id",input.pipelineId); if(input.contactId) p.set("contact_id",input.contactId); if(input.status&&input.status!=="all") p.set("status",input.status); if(input.assignedTo) p.set("assigned_to",input.assignedTo); if(input.query) p.set("query",input.query); const r = await fetch(`${BASE}/opportunities/search?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_opportunity": { const r = await fetch(`${BASE}/opportunities/${input.opportunityId}`, {headers:h}); return await r.json(); }
      case "ghl_create_opportunity": { const r = await fetch(`${BASE}/opportunities/`, {method:"POST",headers:h,body:JSON.stringify({...input,locationId})}); return await r.json(); }
      case "ghl_update_opportunity": { const {opportunityId,...body}=input; const r = await fetch(`${BASE}/opportunities/${opportunityId}`, {method:"PUT",headers:h,body:JSON.stringify(body)}); return await r.json(); }
      case "ghl_delete_opportunity": { const r = await fetch(`${BASE}/opportunities/${input.opportunityId}`, {method:"DELETE",headers:h}); return await r.json(); }
      case "ghl_get_calendars": { const p = new URLSearchParams({locationId}); if(input.showActive!==undefined) p.set("showActive",String(input.showActive)); const r = await fetch(`${BASE}/calendars/?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_calendar_slots": { const p = new URLSearchParams({startDate:String(input.startDate),endDate:String(input.endDate)}); if(input.timezone) p.set("timezone",input.timezone); const r = await fetch(`${BASE}/calendars/${input.calendarId}/free-slots?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_appointments": { const p = new URLSearchParams({locationId}); if(input.calendarId) p.set("calendarId",input.calendarId); if(input.startTime) p.set("startTime",String(input.startTime)); if(input.endTime) p.set("endTime",String(input.endTime)); const r = await fetch(`${BASE}/calendars/events?${p}`, {headers:h}); return await r.json(); }
      case "ghl_create_appointment": { const r = await fetch(`${BASE}/calendars/events/appointments`, {method:"POST",headers:h,body:JSON.stringify({...input,locationId})}); return await r.json(); }
      case "ghl_update_appointment": { const {appointmentId,...body}=input; const r = await fetch(`${BASE}/calendars/events/appointments/${appointmentId}`, {method:"PUT",headers:h,body:JSON.stringify(body)}); return await r.json(); }
      case "ghl_delete_appointment": { const r = await fetch(`${BASE}/calendars/events/${input.appointmentId}`, {method:"DELETE",headers:h}); return await r.json(); }
      case "ghl_get_workflows": { const r = await fetch(`${BASE}/workflows/?locationId=${locationId}`, {headers:h}); return await r.json(); }
      case "ghl_add_contact_to_workflow": { const r = await fetch(`${BASE}/contacts/${input.contactId}/workflow/${input.workflowId}`, {method:"POST",headers:h,body:JSON.stringify({eventStartTime:input.eventStartTime})}); return await r.json(); }
      case "ghl_remove_contact_from_workflow": { const r = await fetch(`${BASE}/contacts/${input.contactId}/workflow/${input.workflowId}`, {method:"DELETE",headers:h}); return await r.json(); }
      case "ghl_get_campaigns": { const p = new URLSearchParams({locationId}); if(input.status) p.set("status",input.status); const r = await fetch(`${BASE}/campaigns/?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_forms": { const p = new URLSearchParams({locationId,limit:String(input.limit||20)}); if(input.skip) p.set("skip",String(input.skip)); const r = await fetch(`${BASE}/forms/?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_form_submissions": { const p = new URLSearchParams({locationId,formId:input.formId,limit:String(input.limit||20)}); if(input.startAt) p.set("startAt",String(input.startAt)); const r = await fetch(`${BASE}/forms/submissions?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_surveys": { const p = new URLSearchParams({locationId,limit:String(input.limit||20)}); const r = await fetch(`${BASE}/surveys/?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_survey_submissions": { const p = new URLSearchParams({locationId,surveyId:input.surveyId,limit:String(input.limit||20)}); const r = await fetch(`${BASE}/surveys/submissions?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_users": { const r = await fetch(`${BASE}/users/?locationId=${locationId}`, {headers:h}); return await r.json(); }
      case "ghl_get_user": { const r = await fetch(`${BASE}/users/${input.userId}`, {headers:h}); return await r.json(); }
      case "ghl_get_location": { const r = await fetch(`${BASE}/locations/${locationId}`, {headers:h}); return await r.json(); }
      case "ghl_get_custom_fields": { const p = new URLSearchParams({locationId}); if(input.model&&input.model!=="all") p.set("model",input.model); const r = await fetch(`${BASE}/locations/customFields?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_tags": { const r = await fetch(`${BASE}/locations/${locationId}/tags`, {headers:h}); return await r.json(); }
      case "ghl_get_orders": { const p = new URLSearchParams({locationId,limit:String(input.limit||20)}); if(input.contactId) p.set("altId",input.contactId); const r = await fetch(`${BASE}/payments/orders?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_order": { const r = await fetch(`${BASE}/payments/orders/${input.orderId}?locationId=${locationId}`, {headers:h}); return await r.json(); }
      case "ghl_get_transactions": { const p = new URLSearchParams({locationId,limit:String(input.limit||20)}); if(input.contactId) p.set("contactId",input.contactId); const r = await fetch(`${BASE}/payments/transactions?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_invoices": { const p = new URLSearchParams({locationId,limit:String(input.limit||20)}); if(input.contactId) p.set("contactId",input.contactId); if(input.status) p.set("status",input.status); const r = await fetch(`${BASE}/invoices/?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_invoice": { const r = await fetch(`${BASE}/invoices/${input.invoiceId}`, {headers:h}); return await r.json(); }
      case "ghl_send_invoice": { const r = await fetch(`${BASE}/invoices/${input.invoiceId}/send`, {method:"POST",headers:h,body:JSON.stringify({})}); return await r.json(); }
      case "ghl_void_invoice": { const r = await fetch(`${BASE}/invoices/${input.invoiceId}/void`, {method:"POST",headers:h,body:JSON.stringify({})}); return await r.json(); }
      case "ghl_get_social_accounts": { const r = await fetch(`${BASE}/social-media-posting/oauth/${locationId}/accounts`, {headers:h}); return await r.json(); }
      case "ghl_get_social_post": { const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts/${input.postId}`, {headers:h}); return await r.json(); }
      case "ghl_get_social_posts": { const p = new URLSearchParams({locationId,limit:String(input.limit||20)}); if(input.startDate) p.set("startDate",String(input.startDate)); if(input.endDate) p.set("endDate",String(input.endDate)); const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts?${p}`, {headers:h}); return await r.json(); }
      case "ghl_create_social_post": { const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts`, {method:"POST",headers:h,body:JSON.stringify({locationId,accountIds:input.accountIds,body:input.body,...(input.scheduleDate&&{scheduleDate:input.scheduleDate}),...(input.mediaUrls?.length&&{mediaUrls:input.mediaUrls})})}); return await r.json(); }
      case "ghl_edit_social_post": { const {postId,...body}=input; const r = await fetch(`${BASE}/social-media-posting/${locationId}/posts/${postId}`, {method:"PUT",headers:h,body:JSON.stringify({...body,locationId})}); return await r.json(); }
      case "ghl_get_social_statistics": { const r = await fetch(`${BASE}/social-media-posting/${locationId}/analytics`, {method:"POST",headers:h,body:JSON.stringify({locationId,accountIds:input.accountIds,...(input.startDate&&{startDate:input.startDate}),...(input.endDate&&{endDate:input.endDate})})}); return await r.json(); }
      case "ghl_get_blogs": { const p = new URLSearchParams({locationId}); if(input.limit) p.set("limit",String(input.limit||10)); const r = await fetch(`${BASE}/blogs/?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_blog_posts": { const p = new URLSearchParams({locationId,blogId:input.blogId}); if(input.status) p.set("status",input.status); if(input.limit) p.set("limit",String(input.limit||10)); const r = await fetch(`${BASE}/blogs/posts?${p}`, {headers:h}); return await r.json(); }
      case "ghl_create_blog_post": { const r = await fetch(`${BASE}/blogs/posts`, {method:"POST",headers:h,body:JSON.stringify({...input,locationId})}); return await r.json(); }
      case "ghl_update_blog_post": { const {postId,blogId,...body}=input; const r = await fetch(`${BASE}/blogs/posts/${postId}`, {method:"PUT",headers:h,body:JSON.stringify({...body,locationId,blogId})}); return await r.json(); }
      case "ghl_check_blog_slug": { const p = new URLSearchParams({locationId,blogId:input.blogId,urlSlug:input.urlSlug}); const r = await fetch(`${BASE}/blogs/posts/url-slug-exists?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_blog_categories": { const p = new URLSearchParams({locationId}); if(input.limit) p.set("limit",String(input.limit||10)); const r = await fetch(`${BASE}/blogs/categories?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_blog_authors": { const p = new URLSearchParams({locationId}); if(input.limit) p.set("limit",String(input.limit||10)); const r = await fetch(`${BASE}/blogs/authors?${p}`, {headers:h}); return await r.json(); }
      case "ghl_get_email_templates": { const p = new URLSearchParams({locationId}); if(input.limit) p.set("limit",String(input.limit||10)); if(input.type) p.set("type",input.type); if(input.search) p.set("search",input.search); const r = await fetch(`${BASE}/emails/templates?${p}`, {headers:h}); return await r.json(); }
      case "ghl_create_email_template": { const r = await fetch(`${BASE}/emails/templates`, {method:"POST",headers:h,body:JSON.stringify({...input,locationId})}); return await r.json(); }
      case "ghl_get_trigger_links": { const r = await fetch(`${BASE}/links/?locationId=${locationId}`, {headers:h}); return await r.json(); }
      default: return { error: "Unknown tool: " + toolName };
    }
  } catch (err) { return { error: err.message }; }
}

// ── Background handler ────────────────────────────────────────────
// Netlify background functions: respond 202 immediately, then keep running
export const handler = async (event) => {
  let jobId, sessionId, agentId;
  try {
    const { message, sessionId: sid, history = [], token } = JSON.parse(event.body || "{}");
    sessionId = sid;

    const agent = await verifyAgent(token);
    if (!agent) return;
    agentId = agent.id;

    const session = await getSessionContext(sessionId, agentId);
    if (!session) return;

    const { location_id, api_token, name: subAccountName } = session.sub_accounts;

    // Get the jobId that was pre-created by the chat-trigger function
    jobId = event.queryStringParameters?.jobId;

    // Save user message
    await supabase.from("messages").insert({ session_id: sessionId, role: "user", content: message });

    const SYSTEM = `You are the B-E-S-Team AI Assistant — a smart, professional CRM assistant built exclusively for B-E-S-Team.

You are currently working with the B-E-S-Team CRM account: "${subAccountName}".

IMPORTANT RULES:
- Never mention "GoHighLevel", "GHL", "HighLevel" or any third-party platform name
- Always refer to the CRM as "B-E-S-Team CRM" and the system as "B-E-S-Team platform"
- Be concise, action-oriented, confirm completed actions clearly

YOU HAVE FULL ACCESS TO: contacts, conversations, opportunities, pipelines, calendars, appointments, workflows, campaigns, forms, surveys, users, payments, invoices, social media, blogs, email templates, trigger links, and PDF reading.

PDF SUMMARY WORKFLOW:
- When you find a URL in a contact's custom fields, call read_pdf_from_url with that URL
- If it returns success with text: generate a structured summary (Document Type, Key Information, Important Points, Action Items) then ask "Where would you like to save this? A) Internal Comment or B) Contact Note"
- If it returns isViewerPage: true — this means the URL is a GHL document viewer page. In that case:
  1. Tell the agent clearly: "I found a document viewer link but I need the direct download URL to read it. You can get this by opening the document in GHL, clicking the download button, and sharing that direct link with me."
  2. Offer to: create a task to review the document, or note the viewer URL on the contact record
  3. Do NOT keep retrying the same viewer URL
- If text extraction worked but source is "html": summarise whatever text was found, noting it came from a web page not a PDF
- Always confirm where the summary was saved after saving

Agent name: ${agent.full_name}`;

    let loopMessages = [...history.slice(-10), { role: "user", content: message }];
    let finalText = "";

    for (let i = 0; i < 8; i++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 2048,
        system: SYSTEM,
        tools: GHL_TOOLS,
        messages: loopMessages
      });

      const textBlocks = response.content.filter(b => b.type === "text");
      if (textBlocks.length) finalText = textBlocks.map(b => b.text).join("\n");
      if (response.stop_reason === "end_turn") break;

      const toolUses = response.content.filter(b => b.type === "tool_use");
      if (!toolUses.length) break;

      const toolResults = await Promise.all(toolUses.map(async t => {
        try {
          const result = await executeGHLTool(t.name, t.input, location_id, api_token);
          return { type: "tool_result", tool_use_id: t.id, content: JSON.stringify(result) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: t.id, content: JSON.stringify({ error: e.message }) };
        }
      }));

      loopMessages = [...loopMessages, { role: "assistant", content: response.content }, { role: "user", content: toolResults }];
    }

    // Save result to Supabase so the poller can pick it up
    await supabase.from("messages").insert({ session_id: sessionId, role: "assistant", content: finalText });
    await supabase.from("job_results").upsert({ id: jobId, status: "done", reply: finalText, session_id: sessionId });

    // Auto-title session on first message
    if (history.length === 0) {
      const title = message.slice(0, 50) + (message.length > 50 ? "\u2026" : "");
      await supabase.from("sessions").update({ title }).eq("id", sessionId);
    }

  } catch (err) {
    console.error("Background function error:", err.message);
    if (jobId) {
      await supabase.from("job_results").upsert({
        id: jobId, status: "error",
        reply: "Sorry, I ran into an error: " + err.message + ". Please try again.",
        session_id: sessionId
      });
    }
  }
};
