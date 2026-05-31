-- ================================================================
-- B-E-S-Team v2 — Full Schema
-- Paste into Supabase SQL Editor and Run
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Sub-accounts (GHL locations) ────────────────────────────────
CREATE TABLE public.sub_accounts (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name          TEXT NOT NULL,
  location_id   TEXT NOT NULL UNIQUE,
  api_token     TEXT NOT NULL,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID REFERENCES auth.users(id)
);

-- ── Agent profiles (extends Supabase auth.users) ─────────────────
CREATE TABLE public.agents (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID REFERENCES auth.users(id)
);

-- ── Agent ↔ Sub-account assignments ──────────────────────────────
CREATE TABLE public.agent_sub_accounts (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  agent_id        UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  sub_account_id  UUID NOT NULL REFERENCES public.sub_accounts(id) ON DELETE CASCADE,
  assigned_at     TIMESTAMPTZ DEFAULT NOW(),
  assigned_by     UUID REFERENCES auth.users(id),
  UNIQUE(agent_id, sub_account_id)
);

-- ── Chat sessions ─────────────────────────────────────────────────
CREATE TABLE public.sessions (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  agent_id        UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  sub_account_id  UUID NOT NULL REFERENCES public.sub_accounts(id),
  title           TEXT DEFAULT 'New Chat',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_active     TIMESTAMPTZ DEFAULT NOW(),
  message_count   INT DEFAULT 0
);

-- ── Messages ──────────────────────────────────────────────────────
CREATE TABLE public.messages (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────
CREATE INDEX idx_messages_session ON public.messages(session_id);
CREATE INDEX idx_messages_created ON public.messages(created_at DESC);
CREATE INDEX idx_sessions_agent ON public.sessions(agent_id);
CREATE INDEX idx_sessions_subaccount ON public.sessions(sub_account_id);
CREATE INDEX idx_agent_subaccounts_agent ON public.agent_sub_accounts(agent_id);

-- ── RLS ───────────────────────────────────────────────────────────
ALTER TABLE public.sub_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_sub_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages          ENABLE ROW LEVEL SECURITY;

-- Service role (Netlify functions) — full access
CREATE POLICY "service_all" ON public.sub_accounts      FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_all" ON public.agents            FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_all" ON public.agent_sub_accounts FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_all" ON public.sessions          FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_all" ON public.messages          FOR ALL USING (auth.role() = 'service_role');

-- Agents can only read their own sessions/messages
CREATE POLICY "agent_own_sessions" ON public.sessions
  FOR SELECT USING (agent_id = auth.uid());
CREATE POLICY "agent_own_messages" ON public.messages
  FOR SELECT USING (
    session_id IN (SELECT id FROM public.sessions WHERE agent_id = auth.uid())
  );

-- ── Auto-update session last_active ──────────────────────────────
CREATE OR REPLACE FUNCTION update_session_activity()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.sessions
  SET last_active = NOW(), message_count = message_count + 1
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_new_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION update_session_activity();

-- ── Auto-create agent profile on signup ──────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.agents (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'role', 'agent')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

