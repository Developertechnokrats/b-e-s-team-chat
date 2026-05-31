# B-E-S-Team AI Chat Widget

> Increase Your Profit By Refining Your Processes — powered by Claude AI + GoHighLevel CRM

---

## What This Does

A fully branded AI chat widget that:
- Lives on your website or Netlify URL
- Lets customers (or your team) chat with Claude AI
- Claude can read/write GoHighLevel CRM in real-time (contacts, pipelines, appointments, tasks, SMS)
- All conversations saved to Supabase

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/JS (no framework, fast) |
| Backend | Netlify Functions (serverless Node.js) |
| AI | Anthropic Claude (claude-sonnet-4-5) |
| CRM | GoHighLevel API (direct HTTP, no MCP server needed) |
| Database | Supabase (PostgreSQL) |

---

## STEP 1 — Set Up Supabase

### 1.1 Create Project
1. Go to [https://supabase.com](https://supabase.com) → **New Project**
2. Name it: `best-team-chat`
3. Choose a strong database password (save it!)
4. Region: Choose closest to your users (e.g. `ap-southeast-1` for India)
5. Click **Create new project** — wait ~2 minutes

### 1.2 Run the Database Schema
1. In your Supabase project → click **SQL Editor** (left sidebar)
2. Click **New Query**
3. Open the file `supabase/migrations/001_initial_schema.sql` from this repo
4. Paste the entire contents into the SQL editor
5. Click **Run** (green button)
6. You should see: `Success. No rows returned`

### 1.3 Get Your Keys
1. Go to **Project Settings** → **API** (left sidebar)
2. Copy these three values:
   - **Project URL** → this is your `SUPABASE_URL`
   - **anon / public key** → this is your `VITE_SUPABASE_ANON_KEY` and `SUPABASE_ANON_KEY`
   - **service_role / secret key** → this is your `SUPABASE_SERVICE_ROLE_KEY` ⚠️ Keep secret!

---

## STEP 2 — Get Anthropic API Key

1. Go to [https://console.anthropic.com](https://console.anthropic.com)
2. Sign up / log in
3. Go to **API Keys** → **Create Key**
4. Copy the key → this is your `ANTHROPIC_API_KEY`
5. Add billing (the model used is claude-sonnet-4-5, ~$3/million tokens)

---

## STEP 3 — Push to GitHub

Your repo is already configured. Run these commands:

```bash
# Clone or navigate to this project folder
cd best-team-chat

# Install dependencies
npm install

# Initialize git (if not already)
git init
git add .
git commit -m "Initial B-E-S-Team chat widget"

# Add your GitHub remote
git remote add origin https://github.com/Developertechnokrats/best-team-chat.git

# Push
git branch -M main
git push -u origin main
```

---

## STEP 4 — Deploy on Netlify

### 4.1 Connect GitHub to Netlify
1. Go to [https://app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project**
2. Click **GitHub** → Authorize Netlify
3. Select the repo: `Developertechnokrats/best-team-chat`
4. Build settings (should auto-detect):
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
5. Click **Deploy site**

### 4.2 Add Environment Variables
**This is the most important step.** In Netlify:
1. Go to your site → **Site configuration** → **Environment variables**
2. Click **Add a variable** for each of these:

| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `GHL_PRIVATE_TOKEN` | `pit-86c2bf94-ed6c-4fa4-bea4-2ada8bdd23d2` |
| `GHL_LOCATION_ID` | `ZgiU6Echl1RVM5JsesdN` |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service role key |
| `VITE_SUPABASE_URL` | Your Supabase Project URL (same as above) |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon key (same as above) |

3. After adding all variables → **Trigger deploy** → **Deploy site**

### 4.3 Verify Deployment
1. Visit your Netlify URL (e.g. `https://best-team-chat.netlify.app`)
2. You should see the B-E-S-Team chat interface
3. Type "Show my pipelines" — Claude should respond with your GHL data

---

## STEP 5 — Embed the Widget on Any Website

Add this single line to any webpage to show the floating chat bubble:

```html
<!-- B-E-S-Team AI Chat Widget -->
<script>
  (function() {
    var iframe = document.createElement('iframe');
    iframe.src = 'https://YOUR-NETLIFY-SITE.netlify.app/widget.html';
    iframe.style.cssText = 'position:fixed;bottom:0;right:0;width:420px;height:640px;border:none;z-index:9999;background:transparent;';
    iframe.allow = 'microphone';
    document.body.appendChild(iframe);
  })();
</script>
```

Replace `YOUR-NETLIFY-SITE` with your actual Netlify subdomain.

---

## GHL Capabilities

Claude can perform these actions directly in your GoHighLevel account:

| Action | What Claude Does |
|--------|-----------------|
| `ghl_get_contacts` | Search contacts by name/email/phone |
| `ghl_create_contact` | Add new contact with tags |
| `ghl_get_pipelines` | List all pipelines and stages |
| `ghl_create_opportunity` | Add deal to pipeline |
| `ghl_get_opportunities` | View open/won/lost deals |
| `ghl_create_task` | Create follow-up task for contact |
| `ghl_get_calendars` | List available booking calendars |
| `ghl_create_appointment` | Book appointment |
| `ghl_send_sms` | Send SMS to contact |
| `ghl_add_tags` | Tag/segment contacts |

---

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Fill in all values in .env

# Run locally (requires Netlify CLI)
npm install -g netlify-cli
netlify dev
# Opens at http://localhost:8888
```

---

## Folder Structure

```
best-team-chat/
├── netlify/
│   └── functions/
│       ├── chat.mjs        ← Main AI + GHL logic
│       └── history.mjs     ← Load chat history
├── public/
│   └── logo.webp           ← B-E-S-Team logo
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql
├── index.html              ← Main chat UI
├── widget.html             ← Embeddable floating bubble
├── vite.config.js
├── netlify.toml
├── package.json
└── .env.example
```

---

## Troubleshooting

**"Internal server error" from chat function**
→ Check Netlify function logs: Site → Functions → chat → View logs
→ Most likely a missing environment variable

**GHL returns 401**
→ Your GHL token may have expired. Generate a new Private Token in GHL → Settings → Private Integrations

**Chat history not loading**
→ Verify Supabase URL and keys are correct in Netlify env vars
→ Check that you ran the SQL migration in Supabase

**Widget not appearing on embedded site**
→ Make sure to replace `YOUR-NETLIFY-SITE` with actual URL
→ Check browser console for CORS errors

---

## Support

Built for B-E-S-Team by Technokrats
Email: argha.bhattacharya@technokrats.in
