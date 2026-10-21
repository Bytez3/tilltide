create extension if not exists pgcrypto;

create table if not exists merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  wallet text not null unique,
  owner_wallet text,
  token_symbol text not null default 'USDC' check (token_symbol in ('USDC', 'PYUSD')),
  points_per_unit numeric not null default 1 check (points_per_unit >= 0),
  bonus_multiplier numeric not null default 1 check (bonus_multiplier >= 1),
  timezone text not null default 'Europe/London',
  created_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  -- 'solana' today; leaves room for a PayPal rail alongside it.
  rail text not null default 'solana',
  reference text not null unique,
  amount bigint not null check (amount > 0),
  token_symbol text not null,
  label text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired')),
  signature text unique,
  payer text,
  failure_reason text,
  points bigint,
  points_signature text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists payments_merchant_created on payments (merchant_id, created_at desc);
create index if not exists payments_pending on payments (status) where status = 'pending';

create table if not exists sweeps (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  amount bigint not null check (amount > 0),
  token_symbol text not null,
  to_wallet text not null,
  reason text,
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'cancelled')),
  signature text unique,
  created_at timestamptz not null default now()
);

-- PayPal rail (M3). Amounts stay in 6-decimal base units so PayPal USD sums with USDC/PYUSD.
alter table payments add column if not exists paypal_order_id text unique;
alter table payments add column if not exists paypal_capture_id text;
alter table payments drop constraint if exists payments_rail_check;
alter table payments add constraint payments_rail_check check (rail in ('solana', 'paypal'));
alter table payments alter column reference drop not null;

-- Points issuance state machine (replaces sentinel values in points_signature).
alter table payments add column if not exists points_status text;
alter table payments add column if not exists points_claimed_at timestamptz;
alter table payments drop constraint if exists payments_points_status_check;
alter table payments add constraint payments_points_status_check check (points_status in ('sending', 'issued', 'none'));
update payments set points_status = 'none', points_signature = null where points_signature = 'none';
update payments set points_status = null, points_signature = null, points = null where points_signature = 'pending';
update payments set points_status = 'issued' where points_signature is not null and points_status is null;

-- Sign In With Solana: one-time nonces and session tokens (stored hashed).
create table if not exists auth_nonces (
  nonce text primary key,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  wallet text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_wallet on sessions (wallet);

-- Sweeps: 'submitted' = signed and sent, waiting for the chain. Never re-signed while submitted.
alter table sweeps add column if not exists submitted_at timestamptz;
alter table sweeps add column if not exists error text;
alter table sweeps drop constraint if exists sweeps_status_check;
alter table sweeps add constraint sweeps_status_check check (status in ('proposed', 'submitted', 'confirmed', 'cancelled'));
