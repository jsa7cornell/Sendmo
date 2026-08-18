import { createClient } from '@supabase/supabase-js';
import { fetchWithRefreshRetry } from './authFetch';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true, // required for magic link redirect to work
  },
  global: {
    // Refresh-token calls that 429/500 would otherwise destroy the stored
    // session (auth-js treats them as non-retryable). See authFetch.ts.
    fetch: fetchWithRefreshRetry,
  },
});
