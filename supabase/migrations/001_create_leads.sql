-- Create leads table for cargo transportation requests
CREATE TABLE IF NOT EXISTS leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_city TEXT,
  to_city TEXT,
  cargo TEXT,
  weight TEXT,
  volume TEXT,
  date TEXT,
  transport_type TEXT,
  urgency TEXT,
  loading TEXT,
  name TEXT,
  phone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- Allow insert for service_role (used by backend)
CREATE POLICY "Service role can insert leads" ON leads
  FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Allow read for service_role (used by manager)
CREATE POLICY "Service role can read leads" ON leads
  FOR SELECT
  TO service_role
  USING (true);