import { createHash, randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from './database';

const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';

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

    try {
      const result = await pool.query(
        `SELECT family_id, user_id, role, permissions
         FROM family_members
         WHERE user_id = $1`,
        [String(decoded.id)]
      );
      const membership = result.rows[0];
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
