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
alter table payments add constraint payments_rail_check check (rail in ('solana', 'paypal', 'cash', 'card'));
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

-- Staff till devices: sessions with role 'staff', tied to a shop instead of a wallet, paired with a
-- single-use code the owner creates.
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
alter table sessions add column if not exists role text not null default 'owner';
alter table sessions add column if not exists merchant_id uuid references merchants(id);
alter table sessions add column if not exists label text;
alter table sessions alter column wallet drop not null;
alter table sessions drop constraint if exists sessions_role_check;
alter table sessions add constraint sessions_role_check check (
  (role = 'owner' and wallet is not null) or (role = 'staff' and merchant_id is not null));
create table if not exists staff_invites (
  code_hash text primary key,
  merchant_id uuid not null references merchants(id),
  label text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- End-of-day reports, written at the shop's closing time (or on demand).
alter table merchants add column if not exists close_time text not null default '17:30';
alter table merchants drop constraint if exists merchants_close_time_check;
alter table merchants add constraint merchants_close_time_check check (close_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
create table if not exists daily_reports (
  merchant_id uuid not null references merchants(id),
  day date not null,
  summary jsonb not null,
  text text not null,
  narrative text,
  created_at timestamptz not null default now(),
  primary key (merchant_id, day)
);

-- One-time CSV download links (the session token never goes in a URL).
create table if not exists export_tokens (
  token_hash text primary key,
  merchant_id uuid not null references merchants(id),
  from_day date not null,
  to_day date not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Seeker bonus applied to a sale's points (the shop's bonus_multiplier, for Seeker owners).
alter table payments add column if not exists points_bonus boolean not null default false;
alter table merchants drop constraint if exists merchants_bonus_multiplier_check;
alter table merchants add constraint merchants_bonus_multiplier_check check (bonus_multiplier between 1 and 3);

-- Quick-sale items: the shop's menu, tapped into a basket on the till.
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null check (length(name) between 1 and 40),
  price bigint not null check (price > 0),
  position int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists items_merchant_idx on items (merchant_id) where not archived;
-- What a sale was made of, priced as at the sale: [{"id", "name", "price", "qty"}]. Null for keypad sales.
alter table payments add column if not exists items jsonb;

-- Cash and card-reader sales: recorded so the day's books are complete. No money moves through Tilltide.
alter table payments drop constraint if exists payments_rail_check;
alter table payments add constraint payments_rail_check check (rail in ('solana', 'paypal', 'cash', 'card'));
-- 'void': a recorded sale the owner cancelled (typed by mistake). Only cash and card sales can be voided.
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check check (status in ('pending', 'paid', 'failed', 'expired', 'void'));
alter table payments add column if not exists voided_at timestamptz;

-- An icon for each menu item (a key from ITEM_ICONS in services/items.ts; the app maps it to a glyph and colour).
alter table items add column if not exists icon text not null default 'other';

-- Customers' points accounts that Tilltide paid to open (it pays the account rent). Used to stop a
-- wallet closing its account to pocket the rent and having it reopened, again and again.
create table if not exists points_accounts (
  wallet text primary key,
  merchant_id uuid not null references merchants(id),
  created_at timestamptz not null default now()
);
create index if not exists points_accounts_created_idx on points_accounts (created_at);

-- Changing where takings go needs the till wallet's signature (a session alone isn't enough).
alter table merchants add column if not exists owner_wallet_pending text;
alter table merchants add column if not exists owner_wallet_nonce text;
alter table merchants add column if not exists owner_wallet_nonce_at timestamptz;
-- How many Claude notes a day's report has had: rewrites can refresh the note, up to a small cap.
alter table daily_reports add column if not exists narrative_count int not null default 0;
