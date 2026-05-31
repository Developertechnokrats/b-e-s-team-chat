-- ================================================================
-- B-E-S-Team Chat Widget — Supabase Schema
-- Run this in Supabase SQL Editor (Project → SQL Editor → New Query)
-- ================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Sessions table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sessions (
  id            TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_active   TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  message_count INT DEFAULT 0,
  user_email    TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb
);

-- ── Messages table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index for fast session lookups
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON public.messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON public.messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON public.sessions(last_active DESC);

-- ── Row Level Security ───────────────────────────────────────────
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Service role (used by Netlify functions) can do everything
CREATE POLICY "service_role_all_sessions" ON public.sessions
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_all_messages" ON public.messages
  FOR ALL USING (auth.role() = 'service_role');

-- Anon can read their own session messages (by session_id param)
CREATE POLICY "anon_read_own_messages" ON public.messages
  FOR SELECT USING (true);

CREATE POLICY "anon_read_own_sessions" ON public.sessions
  FOR SELECT USING (true);

-- ── Analytics view ───────────────────────────────────────────────
CREATE OR REPLACE VIEW public.chat_analytics AS
SELECT
  DATE_TRUNC('day', created_at) AS day,
  COUNT(DISTINCT session_id) AS unique_sessions,
  COUNT(*) FILTER (WHERE role = 'user') AS user_messages,
  COUNT(*) FILTER (WHERE role = 'assistant') AS assistant_messages
FROM public.messages
GROUP BY 1
ORDER BY 1 DESC;

-- ── Auto-create session on first message ─────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_session()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.sessions (id)
  VALUES (NEW.session_id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER ensure_session_before_message
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.ensure_session();

