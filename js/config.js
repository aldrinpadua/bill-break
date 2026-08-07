// config.js — Bill Break settings.
//
// PHASE 1 (default): leave MODE = "local". The app stores everything in this
// browser. Zero setup, works on GitHub Pages immediately.
//
// PHASE 2: after you create a Supabase project (see README), set MODE = "cloud"
// and paste your project URL + anon key below. These two values are safe to
// commit publicly — they only allow access that your Row-Level-Security policies
// permit. (Never put the SERVICE ROLE key here.)

export const CONFIG = {
  MODE: "local", // "local" | "cloud"
  SUPABASE_URL: "https://YOUR-PROJECT-ref.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
};
