import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, PUT, DELETE, OPTIONS"
};

async function verifyAdmin(authHeader) {
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
  if (error || !user) return null;
  const { data: agent } = await supabase.from("agents").select("*").eq("id", user.id).single();
  return agent?.role === "admin" && agent?.is_active ? agent : null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  const admin = await verifyAdmin(event.headers.authorization);
  if (!admin) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Admin access required" }) };

  const path = event.path.replace(/.*\/admin/, "");
  const body = event.httpMethod !== "GET" ? JSON.parse(event.body || "{}") : {};

  try {
    // ════════════════════════════════════════
    // SUB-ACCOUNTS
    // ════════════════════════════════════════

    // GET /admin/sub-accounts
    if (event.httpMethod === "GET" && path === "/sub-accounts") {
      const { data } = await supabase.from("sub_accounts").select("*").order("created_at", { ascending: false });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sub_accounts: data || [] }) };
    }

    // POST /admin/sub-accounts — create
    if (event.httpMethod === "POST" && path === "/sub-accounts") {
      const { name, location_id, api_token } = body;
      if (!name || !location_id || !api_token)
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "name, location_id, api_token required" }) };
      const { data, error } = await supabase.from("sub_accounts")
        .insert({ name, location_id, api_token, created_by: admin.id }).select().single();
      if (error) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sub_account: data }) };
    }

    // PUT /admin/sub-accounts/:id — update
    if (event.httpMethod === "PUT" && path.startsWith("/sub-accounts/")) {
      const id = path.split("/")[2];
      const { name, location_id, api_token, is_active } = body;
      const { data, error } = await supabase.from("sub_accounts")
        .update({ name, location_id, api_token, is_active }).eq("id", id).select().single();
      if (error) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sub_account: data }) };
    }

    // DELETE /admin/sub-accounts/:id
    if (event.httpMethod === "DELETE" && path.startsWith("/sub-accounts/")) {
      const id = path.split("/")[2];
      await supabase.from("sub_accounts").delete().eq("id", id);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
    }

    // ════════════════════════════════════════
    // AGENTS
    // ════════════════════════════════════════

    // GET /admin/agents
    if (event.httpMethod === "GET" && path === "/agents") {
      const { data } = await supabase.from("agents")
        .select("*, agent_sub_accounts(sub_account_id, sub_accounts(id, name))")
        .order("created_at", { ascending: false });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ agents: data || [] }) };
    }

    // POST /admin/agents — create agent (creates Supabase auth user too)
    if (event.httpMethod === "POST" && path === "/agents") {
      const { full_name, email, password, role = "agent", sub_account_ids = [] } = body;
      if (!full_name || !email)
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "full_name and email required" }) };

      // Create auth user
      const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
        email, password: password || undefined,
        email_confirm: true,
        user_metadata: { full_name, role }
      });
      if (authErr) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: authErr.message }) };

      // Update agent profile (trigger already created it)
      await supabase.from("agents").update({ full_name, role, created_by: admin.id }).eq("id", authData.user.id);

      // Assign sub-accounts
      if (sub_account_ids.length > 0) {
        const assignments = sub_account_ids.map(sid => ({
          agent_id: authData.user.id, sub_account_id: sid, assigned_by: admin.id
        }));
        await supabase.from("agent_sub_accounts").insert(assignments);
      }

      // If no password, send magic link
      if (!password) {
        await supabaseAnon.auth.signInWithOtp({ email, options: { emailRedirectTo: process.env.APP_URL + "/chat.html" } });
      }

      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, agent_id: authData.user.id }) };
    }

    // PUT /admin/agents/:id — update agent
    if (event.httpMethod === "PUT" && path.startsWith("/agents/")) {
      const id = path.split("/")[2];
      const { full_name, role, is_active, sub_account_ids } = body;

      await supabase.from("agents").update({ full_name, role, is_active }).eq("id", id);

      // Re-sync sub-account assignments if provided
      if (Array.isArray(sub_account_ids)) {
        await supabase.from("agent_sub_accounts").delete().eq("agent_id", id);
        if (sub_account_ids.length > 0) {
          const assignments = sub_account_ids.map(sid => ({
            agent_id: id, sub_account_id: sid, assigned_by: admin.id
          }));
          await supabase.from("agent_sub_accounts").insert(assignments);
        }
      }

      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
    }

    // DELETE /admin/agents/:id
    if (event.httpMethod === "DELETE" && path.startsWith("/agents/")) {
      const id = path.split("/")[2];
      await supabase.auth.admin.deleteUser(id);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true }) };
    }

    // ════════════════════════════════════════
    // STATS
    // ════════════════════════════════════════
    if (event.httpMethod === "GET" && path === "/stats") {
      const [{ count: agentCount }, { count: subCount }, { count: sessionCount }, { count: msgCount }] = await Promise.all([
        supabase.from("agents").select("*", { count: "exact", head: true }).eq("role", "agent"),
        supabase.from("sub_accounts").select("*", { count: "exact", head: true }),
        supabase.from("sessions").select("*", { count: "exact", head: true }),
        supabase.from("messages").select("*", { count: "exact", head: true })
      ]);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ agents: agentCount, sub_accounts: subCount, sessions: sessionCount, messages: msgCount }) };
    }

    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Not found" }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
