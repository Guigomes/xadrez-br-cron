import { createClient, SupabaseClient } from '@supabase/supabase-js';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws') as typeof WebSocket;

export function createSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // @ts-expect-error ws is compatible at runtime even though types differ slightly
    realtime: { transport: ws },
  });
}
