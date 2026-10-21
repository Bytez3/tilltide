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
