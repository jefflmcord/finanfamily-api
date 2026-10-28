import { createHash, randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from './database';

const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const DEFAULT_SUPPORT_PHONE = '(41) 0000-0000';
export const INTERNAL_ADMIN_EMAIL = 'jeffersonluismattosocordeiro@gmail.com';

export async function getTenantAccessStatus(familyId: string | number): Promise<{
  blocked: boolean;
  contactPhone: string;
}> {
  const result = await pool.query(
    `SELECT f.blocked_at,
            (SELECT value FROM system_settings WHERE key = 'tenant_support_phone') AS contact_phone
     FROM families f
     WHERE f.id::text = $1`,
    [String(familyId)]
  );
  return {
    blocked: Boolean(result.rows[0]?.blocked_at),
    contactPhone: result.rows[0]?.contact_phone || DEFAULT_SUPPORT_PHONE,
  };
}

export const FAMILY_PERMISSIONS = [
  'family_read',
  'transactions_create',
  'transactions_edit',
  'transactions_delete',
  'transactions_settle',
  'accounts_manage',
  'cards_manage',
  'categories_manage',
  'goals_manage',
  'provisions_manage',
  'members_manage',
] as const;

export type FamilyPermission = typeof FAMILY_PERMISSIONS[number];

export interface FamilyAccess {
  userId: string;
  familyId: string;
  role: 'OWNER' | 'MEMBER';
  permissions: Partial<Record<FamilyPermission, boolean>>;
}

declare global {
  namespace Express {
    interface Request {
      familyAccess?: FamilyAccess;
    }
  }
}

export async function initializeAccessControl(): Promise<void> {
  const defaultPermissions = JSON.stringify(
    Object.fromEntries(FAMILY_PERMISSIONS.map(permission => [
      permission,
      permission !== 'members_manage',
    ]))
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS family_members (
      family_id TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      invited_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (family_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS family_invitations (
      token_hash TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      email TEXT NOT NULL,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      invited_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ
    )
  `);
  await pool.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12, 2)');
  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'BOLETO'
  `);
  await pool.query(`
    ALTER TABLE categories
      ADD COLUMN IF NOT EXISTS budget_amount NUMERIC(12, 2)
      CHECK (budget_amount IS NULL OR budget_amount > 0)
  `);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS birth_date DATE,
      ADD COLUMN IF NOT EXISTS bio VARCHAR(280),
      ADD COLUMN IF NOT EXISTS reset_token TEXT,
      ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE families
      ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'TRIAL',
      ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS subscription_ends_at DATE,
      ADD COLUMN IF NOT EXISTS admin_notes TEXT,
      ADD COLUMN IF NOT EXISTS enabled_modules JSONB NOT NULL DEFAULT '["financeiro","mercado","contratos"]'::jsonb
  `);
  await pool.query(`
    ALTER TABLE families
      ALTER COLUMN registered_at SET DEFAULT NOW(),
      ALTER COLUMN trial_ends_at SET DEFAULT (NOW() + INTERVAL '10 days')
  `);
  await pool.query(`
    UPDATE families
    SET trial_ends_at = COALESCE(registered_at, NOW()) + INTERVAL '10 days'
    WHERE trial_ends_at IS NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_leads (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(180) NOT NULL UNIQUE,
      whatsapp VARCHAR(40) NOT NULL,
      source VARCHAR(80) NOT NULL DEFAULT 'EBOOK_10_PASSOS',
      status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED')),
      notes TEXT,
      download_count INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS annual_provisions (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      title VARCHAR(120) NOT NULL,
      expense_type TEXT NOT NULL CHECK (expense_type IN ('IPTU', 'IPVA', 'LICENCIAMENTO', 'OTHER')),
      target_amount NUMERIC(12, 2) NOT NULL CHECK (target_amount > 0),
      saved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
      due_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAID')),
      actual_amount NUMERIC(12, 2) CHECK (actual_amount IS NULL OR actual_amount > 0),
      paid_date DATE,
      renewed_from_id BIGINT UNIQUE REFERENCES annual_provisions(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS annual_provision_contributions (
      id BIGSERIAL PRIMARY KEY,
      provision_id BIGINT NOT NULL REFERENCES annual_provisions(id) ON DELETE CASCADE,
      family_id TEXT NOT NULL,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      contribution_date DATE NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS annual_provisions_family_due_idx
      ON annual_provisions (family_id, status, due_date)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS annual_provision_contributions_provision_date_idx
      ON annual_provision_contributions (provision_id, contribution_date DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_lists (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      name VARCHAR(140) NOT NULL,
      store_name VARCHAR(120),
      budget_limit NUMERIC(12, 2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COMPLETED')),
      completed_at TIMESTAMPTZ,
      total_spent NUMERIC(12, 2) NOT NULL DEFAULT 0,
      linked_transaction_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_list_items (
      id BIGSERIAL PRIMARY KEY,
      list_id BIGINT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
      family_id TEXT NOT NULL,
      name VARCHAR(140) NOT NULL,
      aisle_category VARCHAR(60) NOT NULL DEFAULT 'Mercearia',
      quantity NUMERIC(10, 3) NOT NULL DEFAULT 1,
      unit VARCHAR(20) NOT NULL DEFAULT 'un',
      unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      last_paid_price NUMERIC(12, 2),
      is_checked BOOLEAN NOT NULL DEFAULT FALSE,
      notes VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_price_history (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      normalized_name VARCHAR(140) NOT NULL,
      display_name VARCHAR(140) NOT NULL,
      aisle_category VARCHAR(60) NOT NULL DEFAULT 'Mercearia',
      unit VARCHAR(20) NOT NULL DEFAULT 'un',
      last_price NUMERIC(12, 2) NOT NULL,
      previous_price NUMERIC(12, 2),
      min_price NUMERIC(12, 2) NOT NULL,
      max_price NUMERIC(12, 2) NOT NULL,
      last_store VARCHAR(120),
      purchase_count INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (family_id, normalized_name)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS shopping_lists_family_status_idx
      ON shopping_lists (family_id, status, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS shopping_list_items_list_idx
      ON shopping_list_items (list_id, aisle_category, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS shopping_price_history_family_idx
      ON shopping_price_history (family_id, updated_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS household_contracts (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      title VARCHAR(140) NOT NULL,
      provider VARCHAR(120),
      contract_group VARCHAR(60) NOT NULL DEFAULT 'Streaming & Digital',
      billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
      amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
      billing_day INT NOT NULL DEFAULT 10 CHECK (billing_day BETWEEN 1 AND 31),
      renewal_date DATE,
      payment_method TEXT NOT NULL DEFAULT 'CARD',
      credit_card_id TEXT,
      account_id TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELED')),
      cancellation_url VARCHAR(300),
      support_phone VARCHAR(60),
      notes VARCHAR(300),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS household_warranties (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      product_name VARCHAR(140) NOT NULL,
      brand_model VARCHAR(120),
      room_category VARCHAR(60) NOT NULL DEFAULT 'Cozinha & Eletros',
      store_name VARCHAR(120),
      purchase_date DATE NOT NULL,
      purchase_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      warranty_months INT NOT NULL DEFAULT 12,
      extended_warranty_months INT NOT NULL DEFAULT 0,
      warranty_expires_at DATE NOT NULL,
      invoice_number VARCHAR(80),
      serial_number VARCHAR(80),
      support_contact VARCHAR(140),
      notes VARCHAR(300),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS household_contracts_family_idx
      ON household_contracts (family_id, status, billing_day ASC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS household_warranties_family_idx
      ON household_warranties (family_id, warranty_expires_at ASC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS family_vehicles (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      nickname VARCHAR(100) NOT NULL,
      vehicle_type VARCHAR(30) NOT NULL DEFAULT 'CAR',
      brand_model VARCHAR(120) NOT NULL,
      manufacture_year INT,
      model_year INT,
      license_plate VARCHAR(20),
      fuel_type VARCHAR(40) NOT NULL DEFAULT 'FLEX',
      current_odometer INT NOT NULL DEFAULT 0,
      fipe_estimated_value NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ipva_estimated_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ipva_due_month INT NOT NULL DEFAULT 1 CHECK (ipva_due_month BETWEEN 1 AND 12),
      insurance_provider VARCHAR(120),
      insurance_policy_number VARCHAR(80),
      insurance_renewal_date DATE,
      insurance_annual_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      insurance_assistance_phone VARCHAR(60),
      next_revision_km INT,
      next_revision_date DATE,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SOLD', 'INACTIVE')),
      notes VARCHAR(300),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicle_records (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      vehicle_id BIGINT NOT NULL REFERENCES family_vehicles(id) ON DELETE CASCADE,
      record_type VARCHAR(30) NOT NULL DEFAULT 'FUEL',
      title VARCHAR(140) NOT NULL,
      service_category VARCHAR(60) NOT NULL DEFAULT 'Abastecimento',
      record_date DATE NOT NULL,
      odometer_km INT,
      liters NUMERIC(10, 3),
      price_per_liter NUMERIC(10, 3),
      fuel_efficiency_kml NUMERIC(10, 2),
      amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
      provider_name VARCHAR(120),
      next_service_km INT,
      next_service_date DATE,
      financial_transaction_id TEXT,
      notes VARCHAR(300),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS family_vehicles_family_idx
      ON family_vehicles (family_id, status, id ASC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS vehicle_records_family_vehicle_idx
      ON vehicle_records (family_id, vehicle_id, record_date DESC, id DESC)
  `);
  await pool.query(`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS account_type VARCHAR(30) NOT NULL DEFAULT 'BANK',
      ADD COLUMN IF NOT EXISTS benefit_category VARCHAR(40),
      ADD COLUMN IF NOT EXISTS monthly_recharge_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS recharge_day INT
  `);
  await pool.query(`
    UPDATE family_members
    SET permissions = jsonb_set(COALESCE(permissions, '{}'::jsonb), '{provisions_manage}', 'false'::jsonb, true)
    WHERE NOT COALESCE(permissions ? 'provisions_manage', false)
  `);
  await pool.query(
    `INSERT INTO system_settings (key, value)
     VALUES
       ('tenant_support_phone', $1),
       ('global_broadcast_message', ''),
       ('global_broadcast_type', 'INFO')
     ON CONFLICT (key) DO NOTHING`,
    [DEFAULT_SUPPORT_PHONE]
  );
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('family_budgets') IS NOT NULL THEN
        EXECUTE $migration$
          UPDATE categories c
          SET budget_amount = latest.amount
          FROM (
            SELECT DISTINCT ON (family_id, category_id) family_id, category_id, amount
            FROM family_budgets
            ORDER BY family_id, category_id, updated_at DESC, year DESC, month DESC
          ) latest
          WHERE c.id::text = latest.category_id
            AND c.family_id::text = latest.family_id
            AND c.flow_type = 'EXPENSE'
            AND c.budget_amount IS NULL
        $migration$;
        EXECUTE 'DROP TABLE family_budgets';
      END IF;
    END $$
  `);
  await pool.query(`
    UPDATE transactions
    SET payment_method = 'CARD'
    WHERE credit_card_id IS NOT NULL AND payment_method <> 'CARD'
  `);
  await pool.query(`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS bank_name TEXT,
      ADD COLUMN IF NOT EXISTS agency TEXT,
      ADD COLUMN IF NOT EXISTS account_number TEXT,
      ADD COLUMN IF NOT EXISTS pix_key TEXT,
      ADD COLUMN IF NOT EXISTS initial_balance NUMERIC(12, 2)
  `);
  await pool.query('UPDATE accounts SET initial_balance = balance WHERE initial_balance IS NULL');
  await pool.query('ALTER TABLE accounts ALTER COLUMN initial_balance SET DEFAULT 0');
  await pool.query('ALTER TABLE accounts ALTER COLUMN initial_balance SET NOT NULL');
  await pool.query('UPDATE accounts SET bank_name = name WHERE bank_name IS NULL');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS family_invitations_family_email_idx
      ON family_invitations (family_id, email)
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_lower_email_idx ON users (LOWER(email))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_id_text_idx ON users ((id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS families_id_text_idx ON families ((id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS family_members_user_id_idx ON family_members (user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS family_members_family_id_idx ON family_members (family_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS accounts_family_id_idx ON accounts ((family_id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS categories_family_id_idx ON categories ((family_id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS credit_cards_family_id_idx ON credit_cards ((family_id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS transactions_family_due_idx ON transactions ((family_id::text), due_date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS transactions_category_id_idx ON transactions (category_id)`);
  await pool.query(
    `INSERT INTO family_members (family_id, user_id, role, permissions)
     SELECT ranked.family_id, ranked.user_id,
       CASE WHEN ranked.member_number = 1 THEN 'OWNER' ELSE 'MEMBER' END,
       $1::jsonb
     FROM (
       SELECT family_id::text AS family_id, id::text AS user_id,
         ROW_NUMBER() OVER (PARTITION BY family_id ORDER BY id) AS member_number
       FROM users
       WHERE family_id IS NOT NULL
     ) ranked
     ON CONFLICT (user_id) DO NOTHING`,
    [defaultPermissions]
  );
  await pool.query(
    `UPDATE family_members
     SET permissions = jsonb_set(permissions, '{members_manage}', 'false'::jsonb, true)
     WHERE role = 'MEMBER'`
  );
}

interface CachedMembershipRow {
  family_id: string;
  user_id: string;
  role: 'OWNER' | 'MEMBER';
  permissions: Partial<Record<FamilyPermission, boolean>>;
  blocked_at: string | Date | null;
  email: string;
  contact_phone: string | null;
  expiresAt: number;
}

const authMembershipCache = new Map<string, CachedMembershipRow>();
const AUTH_CACHE_TTL_MS = 4000;

export function invalidateAuthMembershipCache(userId?: string): void {
  if (userId) {
    authMembershipCache.delete(String(userId));
  } else {
    authMembershipCache.clear();
  }
}

export function authenticateFamilyMember(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Acesso negado. Token ausente.' });
    return;
  }

  jwt.verify(token, JWT_SECRET, async (error, decoded) => {
    if (error || !decoded || typeof decoded === 'string' || !('id' in decoded)) {
      res.status(403).json({ error: 'Token inválido ou expirado.' });
      return;
    }

    const userIdKey = String(decoded.id);
    const now = Date.now();
    const cached = authMembershipCache.get(userIdKey);

    try {
      let membership: CachedMembershipRow | undefined = cached && cached.expiresAt > now ? cached : undefined;
      if (!membership) {
        const result = await pool.query(
          `SELECT fm.family_id, fm.user_id, fm.role, fm.permissions,
                  f.blocked_at, u.email,
                  (SELECT value FROM system_settings WHERE key = 'tenant_support_phone') AS contact_phone
           FROM family_members fm
           JOIN families f ON f.id::text = fm.family_id
           JOIN users u ON u.id::text = fm.user_id
           WHERE fm.user_id = $1`,
          [userIdKey]
        );
        const row = result.rows[0];
        if (row) {
          membership = {
            family_id: String(row.family_id),
            user_id: String(row.user_id),
            role: row.role,
            permissions: row.permissions || {},
            blocked_at: row.blocked_at || null,
            email: String(row.email || ''),
            contact_phone: row.contact_phone || null,
            expiresAt: now + AUTH_CACHE_TTL_MS,
          };
          authMembershipCache.set(userIdKey, membership);
        }
      }

      if (!membership) {
        res.status(403).json({ error: 'Este usuário não está vinculado a uma família ativa.' });
        return;
      }

      req.familyAccess = {
        userId: String(membership.user_id),
        familyId: String(membership.family_id),
        role: membership.role,
        permissions: membership.permissions || {},
      };
      if (membership.blocked_at) {
        const isInternalAdmin = String(membership.email).toLowerCase() === INTERNAL_ADMIN_EMAIL;
        if (!isInternalAdmin || !req.originalUrl.startsWith('/api/internal/')) {
          res.status(403).json({
            code: 'TENANT_BLOCKED',
            error: 'Seu acesso está temporariamente indisponível.',
            contact_phone: membership.contact_phone || DEFAULT_SUPPORT_PHONE,
          });
          return;
        }
      }
      next();
    } catch (dbError) {
      next(dbError);
    }
  });
}

export function requireFamilyPermission(permission: FamilyPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const access = req.familyAccess;
    if (!access) {
      res.status(401).json({ error: 'Acesso não autenticado.' });
      return;
    }
    if (access.role === 'OWNER' || access.permissions[permission] === true) {
      next();
      return;
    }
    res.status(403).json({ error: 'Você não tem permissão para realizar esta ação.' });
  };
}

export function createInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
