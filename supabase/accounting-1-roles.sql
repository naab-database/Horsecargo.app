-- =====================================================================
--  HORSE CARGO — Accounting module · step 1 of 2
--  Adds the two finance roles. Run this FIRST, on its own, then run
--  accounting-2.sql. (Postgres cannot use a new enum value in the same
--  transaction that creates it.)
-- =====================================================================
alter type public.app_role add value if not exists 'accountant';
alter type public.app_role add value if not exists 'finance_manager';
