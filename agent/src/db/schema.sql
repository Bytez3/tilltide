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

-- 'failed': the sweep's transaction landed but didn't add up. Never re-signable; needs a human.
alter table sweeps drop constraint if exists sweeps_status_check;
alter table sweeps add constraint sweeps_status_check check (status in ('proposed', 'submitted', 'confirmed', 'cancelled', 'failed'));

-- 'signing': the app is about to open the wallet. Locked until the transaction's blockhash expires.
alter table sweeps add column if not exists signing_valid_until bigint;
alter table sweeps drop constraint if exists sweeps_status_check;
alter table sweeps add constraint sweeps_status_check check (status in ('proposed', 'signing', 'submitted', 'confirmed', 'cancelled', 'failed'));

-- Agent usage per shop per day: enforces the daily cap and shows what Claude costs per shop.
create table if not exists agent_usage (
  merchant_id uuid not null references merchants(id),
  day date not null,
  requests integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  model text,
  primary key (merchant_id, day)
);

-- Platform fee on sweeps (part of the gross amount, paid to the treasury in the same transaction).
alter table sweeps add column if not exists fee_amount bigint not null default 0;
alter table sweeps add column if not exists fee_wallet text;

-- PayPal refunds: the agent proposes, the owner approves with a wallet signature, the server refunds.
create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  payment_id uuid not null references payments(id),
  amount bigint not null check (amount > 0),
  reason text,
  status text not null default 'proposed'
    check (status in ('proposed', 'processing', 'pending', 'completed', 'failed', 'cancelled')),
  approval_nonce text,
  paypal_refund_id text,
  error text,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);
create index if not exists refunds_payment on refunds (payment_id);

-- Refund execution: a short lease so the watcher and a request never call PayPal for the same refund
-- at once, and an attempt count so a 4xx is only trusted as "nothing moved" on the very first call.
alter table refunds add column if not exists executing_until timestamptz;
alter table refunds add column if not exists paypal_attempts integer not null default 0;

-- Points redemption: what a point is worth (in 6-decimal units) and the most of a bill points can cover.
alter table merchants add column if not exists point_value bigint not null default 10000;
alter table merchants add column if not exists redeem_max_percent integer not null default 50;
alter table merchants drop constraint if exists merchants_redeem_max_percent_check;
alter table merchants add constraint merchants_redeem_max_percent_check check (redeem_max_percent between 0 and 90);
alter table payments add column if not exists allow_points boolean not null default false;
alter table payments add column if not exists points_redeemed bigint not null default 0;
alter table payments add column if not exists discount bigint not null default 0;

-- PayPal first: each shop connects its own PayPal (partner onboarding) or names a PayPal email to be paid.
alter table merchants add column if not exists paypal_merchant_id text;
alter table merchants add column if not exists paypal_email text;
alter table merchants add column if not exists paypal_status text not null default 'none';
alter table merchants drop constraint if exists merchants_paypal_status_check;
alter table merchants add constraint merchants_paypal_status_check check (paypal_status in ('none', 'pending', 'connected'));
-- New shops default to PYUSD, PayPal's stablecoin.
alter table merchants alter column token_symbol set default 'PYUSD';
-- Tilltide's platform fee on a PayPal sale, and whose points (PayPal loyalty) a sale spends.
alter table payments add column if not exists paypal_fee bigint not null default 0;
alter table payments add column if not exists loyalty_key text;

-- PayPal customers' loyalty codes (they have no wallet to hold points): one per customer per shop.
create table if not exists loyalty_codes (
  code text primary key,
  merchant_id uuid not null references merchants(id),
  payer_key text not null,
  created_at timestamptz not null default now(),
  unique (merchant_id, payer_key)
);

-- Prices in the shop's own currency. Wallet sales store the token amount and rate they were priced at.
alter table merchants add column if not exists currency text not null default 'GBP';
alter table merchants drop constraint if exists merchants_currency_check;
alter table merchants add constraint merchants_currency_check check (currency in ('GBP', 'USD', 'EUR'));
alter table payments add column if not exists currency text not null default 'USD';
alter table payments add column if not exists token_amount bigint;
alter table payments add column if not exists fx_rate bigint not null default 1000000;
alter table refunds add column if not exists currency text not null default 'USD';
