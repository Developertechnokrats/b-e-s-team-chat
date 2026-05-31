# B-E-S-Team AI Chat v2 — Multi-Account + Agent Login

> Full multi-tenant CRM chat system with admin panel, agent login, and GoHighLevel multi-sub-account support.

---

## What's New in v2

| Feature | Details |
|---------|---------|
| Agent Login | Email/password OR magic link via Supabase Auth |
| Session Isolation | Agents can only see their own chat history |
| Multiple Sessions | Each agent can create many chat threads |
| Admin Panel | Add/edit sub-accounts and agents from a UI |
| Multi Sub-Account | Assign agents to 1+ GHL accounts; switch via dropdown |
| Role-Based Access | `admin` role unlocks the Admin Panel |

---

## Pages

| URL | Purpose |
|-----|---------|
| `/` or `/index.html` | Agent login page |
| `/chat.html` | Chat interface (agents only) |
| `/admin.html` | Admin panel (admin role only) |

---

## STEP 1 — Supabase Setup

### 1.1 Create Project
1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Name: `best-team-v2` | Region: `ap-southeast-1` (India-closest) | Set a strong DB password
3. Wait ~2 min for provisioning

### 1.2 Run the Schema
1. **SQL Editor** (left sidebar) → **New Query**
2. Open `supabase/migrations/001_schema.sql` from this project
3. Paste the full contents → click **Run**
4. You should see: `Success. No rows returned`

### 1.3 Enable Email Auth
1. **Authentication** → **Providers** → **Email** → make sure it's **Enabled**
2. (Optional) Disable "Confirm email" for testing: **Auth** → **Settings** → turn off "Enable email confirmations"
3. For magic links to work in production, set your **Site URL**: **Auth** → **URL Configuration** → Site URL = `https://your-site.netlify.app`
   Also add to **Redirect URLs**: `https://your-site.netlify.app/chat.html`

### 1.4 Get Your Keys
**Project Settings** → **API**:
- `SUPABASE_URL` = Project URL (e.g. `https://abcdef.supabase.co`)
- `SUPABASE_ANON_KEY` = `anon` / `public` key
- `SUPABASE_SERVICE_ROLE_KEY` = `service_role` key ⚠️ Never expose this in frontend

### 1.5 Create Your Admin Account
1. **Authentication** → **Users** → **Add User**
2. Enter your email + password → **Create User**
3. Then run this SQL to make yourself admin (replace the email):

```sql
UPDATE public.agents
SET role = 'admin'
WHERE email = 'argha.bhattacharya@technokrats.in';
```

---

## STEP 2 — Get Anthropic API Key

1. [console.anthropic.com](https://console.anthropic.com) → **API Keys** → **Create Key**
2. Copy key → this is your `ANTHROPIC_API_KEY`

---

## STEP 3 — Push to GitHub

```bash
cd best-team-v2
git init
git add .
git commit -m "feat: v2 multi-account agent system"
git remote add origin https://github.com/Developertechnokrats/best-team-v2.git
git branch -M main
git push -u origin main
```

---

## STEP 4 — Deploy on Netlify

### 4.1 Create Site
1. [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import from GitHub**
2. Select repo: `Developertechnokrats/best-team-v2`
3. Build settings:
   - **Build command:** `echo 'Static site, no build'`
   - **Publish directory:** `public`
4. Click **Deploy site**

### 4.2 Add Environment Variables
**Site configuration** → **Environment variables** → add each:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service role key |
| `APP_URL` | `https://your-site.netlify.app` (your actual Netlify URL) |

### 4.3 Redeploy
After adding env vars → **Deploys** → **Trigger deploy** → **Deploy site**

---

## STEP 5 — First Login & Setup

1. Visit `https://your-site.netlify.app`
2. Log in with the admin email/password you created in Supabase
3. You'll be redirected to the **Admin Panel** automatically

### In Admin Panel:
1. **Sub-Accounts tab** → **Add Sub-Account**
   - Name: e.g. `Main Business`
   - Location ID: `ZgiU6Echl1RVM5JsesdN`
   - API Token: `pit-86c2bf94-ed6c-4fa4-bea4-2ada8bdd23d2`
   - Repeat for each additional GHL sub-account

2. **Agents tab** → **Create Agent**
   - Enter name + email
   - Leave password blank → they get a magic link email
   - OR set a password for them
   - Select which sub-accounts to assign
   - Click **Create Agent**

3. Agent receives email → clicks link → logs in → sees only their assigned sub-accounts → starts chatting

---

## STEP 6 — Embed Widget on Any Site (Optional)

```html
<iframe
  src="https://your-site.netlify.app"
  style="position:fixed;bottom:0;right:0;width:420px;height:640px;border:none;z-index:9999;"
></iframe>
```

---

## Architecture

```
Browser (Agent)
    │
    ▼
Netlify (Static HTML)  ←── /index.html (login)
    │                        /chat.html (chat UI)
    │                        /admin.html (admin panel)
    │
    ▼
Netlify Functions
    ├── /api/auth          ← Login, magic link, JWT verify
    ├── /api/chat          ← Send message (agent-scoped)
    ├── /api/chat/sessions ← List sessions
    ├── /api/chat/session  ← Create session
    ├── /api/chat/history  ← Load session messages
    └── /api/admin/*       ← Sub-accounts + agents CRUD (admin only)
         │
         ├── Anthropic Claude API (AI responses + tool calling)
         │
         └── GoHighLevel API (per-sub-account credentials)
              ├── Contacts
              ├── Pipelines / Opportunities
              ├── Calendars / Appointments
              ├── Tasks
              └── SMS

Supabase (PostgreSQL)
    ├── agents             ← Agent profiles (linked to auth.users)
    ├── sub_accounts       ← GHL accounts with encrypted tokens
    ├── agent_sub_accounts ← Many-to-many assignments
    ├── sessions           ← Chat sessions (agent-scoped)
    └── messages           ← Messages (session-scoped)
```

---

## Security Model

- All API routes require a valid Supabase JWT (except login)
- Agents can only access sessions they own (`agent_id = auth.uid()`)
- Admin routes verify `role = 'admin'` before any operation
- GHL tokens stored in Supabase, never exposed to frontend
- Service Role key only used server-side in Netlify Functions

---

## Troubleshooting

**"Admin access required" on admin panel**
→ Make sure you ran the SQL to set your role to `admin`

**Magic link not arriving**
→ Check Supabase Auth → URL Configuration → add your Netlify URL to Site URL and Redirect URLs

**"Session not found or access denied"**
→ Agent is trying to access another agent's session (correct behavior — this is the isolation working)

**GHL returns 401**
→ Token expired. Generate a new Private Integration token in GHL → Settings → Private Integrations

**Functions timeout**
→ Netlify free tier functions have 10s timeout. Upgrade to Pro for 26s, or optimize GHL calls.

---

Built for B-E-S-Team by Technokrats
argha.bhattacharya@technokrats.in
