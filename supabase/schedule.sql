-- Bill Break — schedule the reminder function to run automatically.
-- Run this ONCE in Supabase → SQL Editor, AFTER you have deployed the
-- send-reminders edge function.
--
-- This uses pg_cron (to run on a timer) + pg_net (to call the function over
-- HTTP). Both are available on Supabase's free tier — enable them first under
-- Database → Extensions (search "pg_cron" and "pg_net" and toggle them on).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace these two values:
--   <PROJECT_REF>  → your project ref (Settings → General, e.g. abcxyz123)
--   <ANON_KEY>     → your anon public key (Settings → API)
-- The function itself checks each ledger's frequency, so it's safe (and correct)
-- to *invoke* it once a day at, say, 14:00 UTC. It only emails ledgers that are
-- actually "due", so a daily invocation supports daily/weekly/monthly reminders.

select cron.schedule(
  'billbreak-daily-reminders',
  '0 14 * * *',                       -- every day at 14:00 UTC — change if you like
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To change the time later:  select cron.unschedule('billbreak-daily-reminders'); then re-run above.
-- To see scheduled jobs:      select * from cron.job;
-- To see run history:         select * from cron.job_run_details order by start_time desc limit 20;
