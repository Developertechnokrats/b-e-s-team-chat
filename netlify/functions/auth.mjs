import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  const { action, email, password, token } = JSON.parse(event.body || "{}");

  try {
    // ── Login with email+password ──
    if (action === "login") {
      const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
      if (error) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: error.message }) };

      // Get agent profile + assigned sub-accounts
      const { data: agent } = await supabase
        .from("agents").select("*").eq("id", data.user.id).single();

      if (!agent || !agent.is_active)
        return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Account disabled or not found." }) };

      const { data: assignments } = await supabase
        .from("agent_sub_accounts")
        .select("sub_account_id, sub_accounts(id, name, location_id)")
        .eq("agent_id", data.user.id);

      const subAccounts = (assignments || []).map(a => a.sub_accounts);

      return {
        statusCode: 200, headers: cors,
        body: JSON.stringify({
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          agent: { ...agent, sub_accounts: subAccounts }
        })
      };
    }

    // ── Magic link ──
    if (action === "magic_link") {
      const { error } = await supabaseAnon.auth.signInWithOtp({ email, options: { emailRedirectTo: process.env.APP_URL + "/chat.html" } });
      if (error) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ message: "Magic link sent to " + email }) };
    }

    // ── Verify JWT + get profile ──
    if (action === "me") {
      const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
      if (error || !user) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "Invalid token" }) };

      const { data: agent } = await supabase.from("agents").select("*").eq("id", user.id).single();
      if (!agent || !agent.is_active) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: "Forbidden" }) };

      const { data: assignments } = await supabase
        .from("agent_sub_accounts")
        .select("sub_account_id, sub_accounts(id, name, location_id)")
        .eq("agent_id", user.id);

      const subAccounts = (assignments || []).map(a => a.sub_accounts);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ agent: { ...agent, sub_accounts: subAccounts } }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Unknown action" }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
