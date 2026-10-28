import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './database';
import familyRouter, { publicFamilyRouter, seedDefaultFamilyResources } from './familyRoutes';
import annualProvisionsRouter from './annualProvisions';
import shoppingRouter from './shoppingRoutes';
import householdContractsRouter from './householdContractsRoutes';
import vehiclesRouter from './vehiclesRoutes';
import {
  authenticateFamilyMember,
  FAMILY_PERMISSIONS,
  getTenantAccessStatus,
  hashInvitationToken,
  requireFamilyPermission,
} from './accessControl';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function addMonthsToDate(dateValue: string, monthOffset: number): string {
  const [year, month, day] = dateValue.slice(0, 10).split('-').map(Number);
  const targetMonth = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  const lastDayOfMonth = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  targetMonth.setUTCDate(Math.min(day, lastDayOfMonth));
  return targetMonth.toISOString().split('T')[0];
}

// Rota raiz para teste de status e aquecimento de conexão
router.get('/', (req: Request, res: Response) => {
  if (req.query.warmup) {
    pool.query('SELECT 1').catch(() => {});
  }
  return res.status(200).json({ status: 'online', message: 'API FinanFamily a funcionar perfeitamente!' });
});

// Função auxiliar para garantir que a categoria "Investimento" existe para a família
async function ensureInvestmentCategory(client: any, familyId: string | number) {
  let catRes = await client.query(
    `SELECT id FROM categories WHERE family_id = $1 AND LOWER(name) = 'investimento' FOR UPDATE`,
    [familyId]
  );
  if (catRes.rows.length > 0) {
    await client.query(
      "UPDATE categories SET flow_type = 'EXPENSE' WHERE id = $1",
      [catRes.rows[0].id]
    );
    return catRes.rows[0].id;
  }
  const newCat = await client.query(
    `INSERT INTO categories (family_id, name, flow_type) VALUES ($1, 'Investimento', 'EXPENSE') RETURNING id`,
    [familyId]
  );
  return newCat.rows[0].id;
}

// 1. LOGIN TRADICIONAL
router.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e palavra-passe são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    if (user.family_id) {
      const tenantStatus = await getTenantAccessStatus(user.family_id);
      if (tenantStatus.blocked) {
        return res.status(403).json({
          code: 'TENANT_BLOCKED',
          error: 'Seu acesso está temporariamente indisponível.',
          contact_phone: tenantStatus.contactPhone,
        });
      }
    }

    const token = jwt.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(200).json({ token, user: safeUser });
  } catch (err: any) {
    console.error('Erro no login:', err);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// 2. GOOGLE OAUTH
router.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Token do Google não fornecido.' });

  const client = await pool.connect();
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID || undefined,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Falha ao ler dados do Google.' });
    }

    const { email, name, sub: googleId, picture: avatarUrl } = payload;
    const cleanEmail = email.toLowerCase();
    const invitationToken = typeof req.body.invitation_token === 'string' ? req.body.invitation_token : '';
    await client.query('BEGIN');
    const invitationResult = invitationToken
      ? await client.query(
          `SELECT token_hash, family_id, email, permissions, invited_by
           FROM family_invitations
           WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
           FOR UPDATE`,
          [hashInvitationToken(invitationToken)]
        )
      : { rows: [] };
    const invitation = invitationResult.rows[0];
    if (invitationToken && (!invitation || invitation.email !== cleanEmail)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'O convite não é válido para esta conta Google ou expirou.' });
    }

    const existingUserResult = await client.query(
      'SELECT id, name, email, family_id, avatar_url, google_id FROM users WHERE LOWER(email) = $1 FOR UPDATE',
      [cleanEmail]
    );
    let user = existingUserResult.rows[0];
    if (user && invitation && user.family_id && String(user.family_id) !== String(invitation.family_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta conta já pertence a outra família. Ainda não é possível vincular uma conta a múltiplas famílias.' });
    }

    if (user) {
      if (!user.google_id || !user.avatar_url) {
        const updateResult = await client.query(
          `UPDATE users
           SET google_id = COALESCE(google_id, $1), avatar_url = COALESCE($2, avatar_url), email_verified = TRUE
           WHERE id = $3
           RETURNING id, name, email, family_id, avatar_url, google_id`,
          [googleId, avatarUrl || null, user.id]
        );
        user = updateResult.rows[0];
      }

      if (user.family_id) {
        const tenantStatusResult = await client.query(
          `SELECT f.blocked_at,
                  (SELECT value FROM system_settings WHERE key = 'tenant_support_phone') AS contact_phone
           FROM families f
           WHERE f.id::text = $1`,
          [String(user.family_id)]
        );
        const tenantStatus = tenantStatusResult.rows[0];
        if (tenantStatus?.blocked_at) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            code: 'TENANT_BLOCKED',
            error: 'Seu acesso está temporariamente indisponível.',
            contact_phone: tenantStatus.contact_phone || '(41) 0000-0000',
          });
        }
      }

      if (invitation) {
        if (!user.family_id) {
          const familyUpdate = await client.query(
            'UPDATE users SET family_id = $1 WHERE id = $2 RETURNING id, name, email, family_id, avatar_url, google_id',
            [invitation.family_id, user.id]
          );
          user = familyUpdate.rows[0];
        }
        const membershipResult = await client.query(
          'SELECT family_id, role FROM family_members WHERE user_id = $1 FOR UPDATE',
          [String(user.id)]
        );
        const membership = membershipResult.rows[0];
        if (membership && String(membership.family_id) !== String(invitation.family_id)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Esta conta já está vinculada a outra família.' });
        }
        if (!membership) {
          await client.query(
            `INSERT INTO family_members (family_id, user_id, role, permissions, invited_by)
             VALUES ($1, $2, 'MEMBER', $3::jsonb, $4)`,
            [String(invitation.family_id), String(user.id), JSON.stringify(invitation.permissions), String(invitation.invited_by)]
          );
        }
      }
    } else if (invitation) {
      const userRes = await client.query(
        `INSERT INTO users (name, email, google_id, avatar_url, family_id, email_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, name, email, family_id, avatar_url`,
        [name || 'Utilizador', cleanEmail, googleId, avatarUrl || null, invitation.family_id]
      );
      user = userRes.rows[0];
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role, permissions, invited_by)
         VALUES ($1, $2, 'MEMBER', $3::jsonb, $4)`,
        [String(invitation.family_id), String(user.id), JSON.stringify(invitation.permissions), String(invitation.invited_by)]
      );
    } else {
      const familyRes = await client.query(
        `INSERT INTO families (name, registered_at, plan_type, trial_ends_at)
         VALUES ($1, NOW(), 'TRIAL', NOW() + INTERVAL '10 days')
         RETURNING id`,
        [`Família de ${name || 'Utilizador'}`]
      );
      const familyId = familyRes.rows[0].id;
      await seedDefaultFamilyResources(client, familyId);
      const userRes = await client.query(
        `INSERT INTO users (name, email, google_id, avatar_url, family_id, email_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, name, email, family_id, avatar_url`,
        [name || 'Utilizador', cleanEmail, googleId, avatarUrl || null, familyId]
      );
      user = userRes.rows[0];
      const ownerPermissions = Object.fromEntries(FAMILY_PERMISSIONS.map(permission => [permission, true]));
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role, permissions)
         VALUES ($1, $2, 'OWNER', $3::jsonb)`,
        [String(familyId), String(user.id), JSON.stringify(ownerPermissions)]
      );
    }

    const leadMatch = await client.query(
      `UPDATE marketing_leads
       SET status = 'CONVERTED', updated_at = NOW()
       WHERE LOWER(email) = $1
       RETURNING whatsapp`,
      [cleanEmail]
    );
    if (leadMatch.rows[0]?.whatsapp) {
      await client.query(
        `UPDATE users SET phone = COALESCE(NULLIF(phone, ''), $1) WHERE id = $2`,
        [leadMatch.rows[0].whatsapp, user.id]
      );
    }

    if (invitation) {
      await client.query(
        'UPDATE family_invitations SET accepted_at = NOW() WHERE token_hash = $1',
        [invitation.token_hash]
      );
    }
    await client.query('COMMIT');

    const token = jwt.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(200).json({ token, user: safeUser });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Erro no Google Auth:', err);
    return res.status(500).json({ error: 'Erro ao autenticar com o Google.' });
  } finally {
    client.release();
  }
});

router.use(publicFamilyRouter);
router.use('/api', authenticateFamilyMember);
router.use(familyRouter);
router.use('/api/annual-provisions', annualProvisionsRouter);
router.use('/api/shopping', shoppingRouter);
router.use('/api/household', householdContractsRouter);
router.use('/api/vehicles', vehiclesRouter);

// 3. CONTAS BANCÁRIAS E VALES / BENEFÍCIOS (CAJU, ALELO, TICKET, FLASH, VR)
router.get('/api/accounts', requireFamilyPermission('family_read'), async (req: Request, res: Response): Promise<any> => {
  const family_id = req.familyAccess!.familyId;

  try {
    const result = await pool.query(
      `SELECT id, name, bank_name, agency, account_number, pix_key,
              initial_balance, balance,
              COALESCE(account_type, 'BANK') AS account_type,
              benefit_category,
              COALESCE(monthly_recharge_amount, 0) AS monthly_recharge_amount,
              recharge_day
       FROM accounts
       WHERE family_id = $1
       ORDER BY CASE WHEN COALESCE(account_type, 'BANK') = 'BANK' THEN 0 ELSE 1 END, name ASC`,
      [String(family_id)]
    );
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/accounts', requireFamilyPermission('accounts_manage'), async (req: Request, res: Response): Promise<any> => {
  const {
    bank_name,
    agency,
    account_number,
    pix_key,
    initial_balance,
    account_type = 'BANK',
    benefit_category = null,
    monthly_recharge_amount = 0,
    recharge_day = null,
  } = req.body;
  const safeType = account_type === 'BENEFIT_CARD' ? 'BENEFIT_CARD' : 'BANK';
  const normalizedBank = typeof bank_name === 'string' ? bank_name.trim() : '';
  const rawAccount = typeof account_number === 'string' ? account_number.trim() : '';
  const normalizedAccount = safeType === 'BENEFIT_CARD' ? (rawAccount || 'Vale/Benefício') : rawAccount;
  const openingBalance = Math.round(Number(initial_balance) * 100) / 100;
  const parsedRecharge = Math.max(0, Math.round(Number(monthly_recharge_amount || 0) * 100) / 100);
  const parsedRechargeDay =
    recharge_day !== null && recharge_day !== '' && Number(recharge_day) >= 1 && Number(recharge_day) <= 31
      ? Math.round(Number(recharge_day))
      : null;

  if (!normalizedBank || !normalizedAccount || !Number.isFinite(openingBalance)) {
    return res.status(400).json({ error: 'Informe um nome/banco e saldo inicial válidos.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO accounts (
         family_id, name, bank_name, agency, account_number, pix_key,
         initial_balance, balance, account_type, benefit_category,
         monthly_recharge_amount, recharge_day
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11)
       RETURNING id, name, bank_name, agency, account_number, pix_key,
                 initial_balance, balance, account_type, benefit_category,
                 monthly_recharge_amount, recharge_day`,
      [
        req.familyAccess!.familyId,
        `${normalizedBank} • ${normalizedAccount}`,
        normalizedBank,
        typeof agency === 'string' ? agency.trim() || null : null,
        normalizedAccount,
        typeof pix_key === 'string' ? pix_key.trim() || null : null,
        openingBalance,
        safeType,
        typeof benefit_category === 'string' && benefit_category.trim() ? benefit_category.trim() : null,
        parsedRecharge,
        parsedRechargeDay,
      ]
    );
    return res.status(201).json({
      message: safeType === 'BENEFIT_CARD' ? 'Cartão de benefício/vale cadastrado.' : 'Conta bancária cadastrada.',
      account: result.rows[0],
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/api/accounts/:id', requireFamilyPermission('accounts_manage'), async (req: Request, res: Response): Promise<any> => {
  const {
    bank_name,
    agency,
    account_number,
    pix_key,
    initial_balance,
    account_type = 'BANK',
    benefit_category = null,
    monthly_recharge_amount = 0,
    recharge_day = null,
  } = req.body;
  const safeType = account_type === 'BENEFIT_CARD' ? 'BENEFIT_CARD' : 'BANK';
  const normalizedBank = typeof bank_name === 'string' ? bank_name.trim() : '';
  const rawAccount = typeof account_number === 'string' ? account_number.trim() : '';
  const normalizedAccount = safeType === 'BENEFIT_CARD' ? (rawAccount || 'Vale/Benefício') : rawAccount;
  const openingBalance = Math.round(Number(initial_balance) * 100) / 100;
  const parsedRecharge = Math.max(0, Math.round(Number(monthly_recharge_amount || 0) * 100) / 100);
  const parsedRechargeDay =
    recharge_day !== null && recharge_day !== '' && Number(recharge_day) >= 1 && Number(recharge_day) <= 31
      ? Math.round(Number(recharge_day))
      : null;

  if (!normalizedBank || !normalizedAccount || !Number.isFinite(openingBalance)) {
    return res.status(400).json({ error: 'Informe um nome/banco e saldo inicial válidos.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      'SELECT id, balance, initial_balance FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [req.params.id, req.familyAccess!.familyId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conta ou benefício não encontrado.' });
    }

    const balanceAdjustment = openingBalance - Number(current.initial_balance);
    const result = await client.query(
      `UPDATE accounts
       SET name = $1, bank_name = $2, agency = $3, account_number = $4,
           pix_key = $5, initial_balance = $6, balance = balance + $7,
           account_type = $8, benefit_category = $9,
           monthly_recharge_amount = $10, recharge_day = $11
       WHERE id = $12 AND family_id = $13
       RETURNING id, name, bank_name, agency, account_number, pix_key,
                 initial_balance, balance, account_type, benefit_category,
                 monthly_recharge_amount, recharge_day`,
      [
        `${normalizedBank} • ${normalizedAccount}`,
        normalizedBank,
        typeof agency === 'string' ? agency.trim() || null : null,
        normalizedAccount,
        typeof pix_key === 'string' ? pix_key.trim() || null : null,
        openingBalance,
        balanceAdjustment,
        safeType,
        typeof benefit_category === 'string' && benefit_category.trim() ? benefit_category.trim() : null,
        parsedRecharge,
        parsedRechargeDay,
        req.params.id,
        req.familyAccess!.familyId,
      ]
    );
    await client.query('COMMIT');
    return res.json({ message: 'Cadastro atualizado com sucesso.', account: result.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3.1 RECARREGAR SALDO DO VALE / BENEFÍCIO (CRÉDITO MENSAL EM 1 CLIQUE)
router.post('/api/accounts/:id/recharge', requireFamilyPermission('accounts_manage'), async (req: Request, res: Response): Promise<any> => {
  const familyId = String(req.familyAccess!.familyId);
  const accountId = req.params.id;
  const rawAmount = req.body?.amount;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const accRes = await client.query(
      'SELECT * FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [accountId, familyId]
    );
    if (accRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Benefício/Vale não encontrado.' });
    }
    const acc = accRes.rows[0];
    const rechargeValue =
      rawAmount !== undefined && Number(rawAmount) > 0
        ? Math.round(Number(rawAmount) * 100) / 100
        : Math.round(Number(acc.monthly_recharge_amount || 0) * 100) / 100;

    if (!Number.isFinite(rechargeValue) || rechargeValue <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Informe um valor de recarga maior que zero.' });
    }

    const updatedAcc = await client.query(
      `UPDATE accounts
       SET balance = balance + $1
       WHERE id = $2 AND family_id = $3
       RETURNING id, name, bank_name, agency, account_number, pix_key,
                 initial_balance, balance, account_type, benefit_category,
                 monthly_recharge_amount, recharge_day`,
      [rechargeValue, accountId, familyId]
    );

    await client.query('COMMIT');
    return res.json({
      message: `Recarga de R$ ${rechargeValue.toFixed(2).replace('.', ',')} creditada no saldo de ${acc.bank_name}!`,
      account: updatedAcc.rows[0],
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/api/accounts/:id', requireFamilyPermission('accounts_manage'), async (req: Request, res: Response): Promise<any> => {
  try {
    const accountResult = await pool.query(
      'SELECT id FROM accounts WHERE id = $1 AND family_id = $2',
      [req.params.id, req.familyAccess!.familyId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conta bancária não encontrada.' });
    }

    const transactionResult = await pool.query(
      'SELECT 1 FROM transactions WHERE account_id = $1 AND family_id = $2 LIMIT 1',
      [req.params.id, req.familyAccess!.familyId]
    );
    if (transactionResult.rows.length > 0) {
      return res.status(409).json({ error: 'Não é possível excluir uma conta vinculada a lançamentos.' });
    }

    await pool.query(
      'DELETE FROM accounts WHERE id = $1 AND family_id = $2',
      [req.params.id, req.familyAccess!.familyId]
    );
    return res.json({ message: 'Conta bancária excluída.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. CATEGORIAS
router.get('/api/categories', requireFamilyPermission('family_read'), async (req: Request, res: Response): Promise<any> => {
  const family_id = String(req.familyAccess!.familyId);

  try {
    const result = await pool.query(
      `SELECT c.*, COUNT(t.id)::int AS transaction_count
       FROM categories c
       LEFT JOIN transactions t ON t.category_id = c.id
       WHERE c.family_id::text = $1
       GROUP BY c.id
       ORDER BY c.name ASC`,
      [family_id]
    );
    let rows = result.rows;
    if (!rows.some(c => String(c.name || '').toLowerCase() === 'investimento')) {
      const invRes = await pool.query(
        `INSERT INTO categories (family_id, name, flow_type)
         VALUES ($1, 'Investimento', 'EXPENSE')
         RETURNING *`,
        [family_id]
      );
      if (invRes.rows[0]) {
        rows = [...rows, { ...invRes.rows[0], transaction_count: 0 }].sort((a, b) =>
          String(a.name).localeCompare(String(b.name), 'pt-BR')
        );
      }
    }
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/categories', requireFamilyPermission('categories_manage'), async (req: Request, res: Response): Promise<any> => {
  const { name, type = 'VARIABLE', flow_type = 'EXPENSE', color = '#10b981' } = req.body;
  const budgetAmount = req.body.budget_amount === '' || req.body.budget_amount === null || req.body.budget_amount === undefined
    ? null
    : Number(req.body.budget_amount);
  const family_id = req.familyAccess!.familyId;
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!family_id || !normalizedName) {
    return res.status(400).json({ error: 'family_id e name são obrigatórios.' });
  }
  if (!['EXPENSE', 'INCOME'].includes(flow_type) || !['FIXED', 'VARIABLE'].includes(type)) {
    return res.status(400).json({ error: 'Tipo e fluxo da categoria são inválidos.' });
  }
  if (budgetAmount !== null && (!Number.isFinite(budgetAmount) || budgetAmount <= 0 || flow_type !== 'EXPENSE')) {
    return res.status(400).json({ error: 'O orçamento deve ser maior que zero e só pode ser definido para categorias de despesa.' });
  }
  if (normalizedName.toLocaleLowerCase('pt-BR') === 'investimento') {
    return res.status(409).json({ error: 'A categoria Investimento já é pré-cadastrada e reservada.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO categories (family_id, name, type, flow_type, color, budget_amount)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [family_id, normalizedName, type, flow_type, color, budgetAmount]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/api/categories/:id', requireFamilyPermission('categories_manage'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { name, type, flow_type, color } = req.body;
  const hasBudgetAmount = Object.prototype.hasOwnProperty.call(req.body, 'budget_amount');
  const budgetAmount = req.body.budget_amount === '' || req.body.budget_amount === null || req.body.budget_amount === undefined
    ? null
    : Number(req.body.budget_amount);
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!normalizedName || !['FIXED', 'VARIABLE'].includes(type) ||
      !['EXPENSE', 'INCOME'].includes(flow_type) || typeof color !== 'string') {
    return res.status(400).json({ error: 'Nome, natureza, fluxo e cor da categoria são obrigatórios.' });
  }
  if (hasBudgetAmount && budgetAmount !== null &&
      (!Number.isFinite(budgetAmount) || budgetAmount <= 0 || flow_type !== 'EXPENSE')) {
    return res.status(400).json({ error: 'O orçamento deve ser maior que zero e só pode ser definido para categorias de despesa.' });
  }
  if (normalizedName.toLocaleLowerCase('pt-BR') === 'investimento') {
    return res.status(409).json({ error: 'A categoria Investimento é reservada e não pode ser renomeada.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const categoryResult = await client.query(
      'SELECT id, name, flow_type, budget_amount FROM categories WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [id, req.familyAccess!.familyId]
    );
    const category = categoryResult.rows[0];
    if (!category) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoria não encontrada.' });
    }
    if (String(category.name).toLocaleLowerCase('pt-BR') === 'investimento') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A categoria Investimento é reservada e não pode ser editada.' });
    }

    const linkedResult = await client.query(
      'SELECT EXISTS (SELECT 1 FROM transactions WHERE category_id = $1) AS has_transactions',
      [id]
    );
    if (linkedResult.rows[0].has_transactions && flow_type !== category.flow_type) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'O fluxo não pode ser alterado enquanto houver lançamentos vinculados à categoria.'
      });
    }

    const nextBudgetAmount = flow_type === 'INCOME'
      ? null
      : hasBudgetAmount
        ? budgetAmount
        : category.budget_amount;
    const result = await client.query(
      `UPDATE categories
       SET name = $1, type = $2, flow_type = $3, color = $4, budget_amount = $5
       WHERE id = $6 AND family_id = $7 RETURNING *`,
      [normalizedName, type, flow_type, color, nextBudgetAmount, id, req.familyAccess!.familyId]
    );
    await client.query('COMMIT');
    return res.json(result.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/api/categories/:id', requireFamilyPermission('categories_manage'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const categoryResult = await client.query(
      'SELECT id, name FROM categories WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [id, req.familyAccess!.familyId]
    );
    const category = categoryResult.rows[0];
    if (!category) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoria não encontrada.' });
    }
    if (String(category.name).toLocaleLowerCase('pt-BR') === 'investimento') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A categoria Investimento é reservada e não pode ser excluída.' });
    }

    const linkedResult = await client.query(
      'SELECT COUNT(*)::int AS transaction_count FROM transactions WHERE category_id = $1',
      [id]
    );
    const transactionCount = linkedResult.rows[0].transaction_count;
    if (transactionCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Esta categoria possui ${transactionCount} lançamento(s) vinculado(s) e não pode ser excluída.`
      });
    }

    await client.query('DELETE FROM categories WHERE id = $1 AND family_id = $2', [id, req.familyAccess!.familyId]);
    await client.query('COMMIT');
    return res.json({ message: 'Categoria excluída com sucesso.' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5. CARTÕES DE CRÉDITO
router.get('/api/credit-cards', requireFamilyPermission('family_read'), async (req: Request, res: Response): Promise<any> => {
  const family_id = req.familyAccess!.familyId;

  try {
    const result = await pool.query(`SELECT * FROM credit_cards WHERE family_id = $1 ORDER BY name ASC`, [String(family_id)]);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/credit-cards', requireFamilyPermission('cards_manage'), async (req: Request, res: Response): Promise<any> => {
  const { name, brand, total_limit, closing_day, due_day } = req.body;
  const family_id = req.familyAccess!.familyId;
  const parsedLimit = Number(total_limit) || 0;

  if (!family_id || !name || !brand || parsedLimit <= 0) {
    return res.status(400).json({ error: 'family_id, name, brand e total_limit são obrigatórios.' });
  }

  try {
    const query = `
      INSERT INTO credit_cards (family_id, name, brand, total_limit, closing_day, due_day)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
    `;
    const result = await pool.query(query, [family_id, name, brand, parsedLimit, Number(closing_day) || 1, Number(due_day) || 10]);
    return res.status(201).json(result.rows[0]);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/api/credit-cards/:id', requireFamilyPermission('cards_manage'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { name, brand, total_limit, closing_day, due_day } = req.body;
  const parsedLimit = Number(total_limit);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return res.status(400).json({ error: 'Informe um limite válido maior que zero.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cardResult = await client.query(
      'SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [id, req.familyAccess!.familyId]
    );
    if (cardResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cartão não encontrado.' });
    }

    const pendingResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM transactions WHERE credit_card_id = $1 AND status IS DISTINCT FROM 'PAID') AS has_pending_transactions",
      [id]
    );
    const hasPendingTransactions = pendingResult.rows[0].has_pending_transactions;

    if (hasPendingTransactions) {
      const fields = Object.keys(req.body);
      if (fields.some((field) => field !== 'total_limit')) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'O cartão possui lançamentos pendentes. Apenas o limite pode ser alterado.'
        });
      }

      const result = await client.query(
        'UPDATE credit_cards SET total_limit = $1 WHERE id = $2 AND family_id = $3 RETURNING *',
        [parsedLimit, id, req.familyAccess!.familyId]
      );
      await client.query('COMMIT');
      return res.json(result.rows[0]);
    }

    const parsedClosingDay = Number(closing_day);
    const parsedDueDay = Number(due_day);
    if (
      typeof name !== 'string' || !name.trim() ||
      typeof brand !== 'string' || !brand.trim() ||
      !Number.isInteger(parsedClosingDay) || parsedClosingDay < 1 || parsedClosingDay > 31 ||
      !Number.isInteger(parsedDueDay) || parsedDueDay < 1 || parsedDueDay > 31
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Informe identificação, bandeira, fechamento e vencimento válidos.' });
    }

    const result = await client.query(
      `UPDATE credit_cards
       SET name = $1, brand = $2, total_limit = $3, closing_day = $4, due_day = $5
       WHERE id = $6 AND family_id = $7 RETURNING *`,
      [name.trim(), brand.trim(), parsedLimit, parsedClosingDay, parsedDueDay, id, req.familyAccess!.familyId]
    );
    await client.query('COMMIT');
    return res.json(result.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/api/credit-cards/:id', requireFamilyPermission('cards_manage'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cardResult = await client.query(
      'SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [id, req.familyAccess!.familyId]
    );
    if (cardResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cartão não encontrado.' });
    }

    const pendingResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM transactions WHERE credit_card_id = $1 AND status IS DISTINCT FROM 'PAID') AS has_pending_transactions",
      [id]
    );
    if (pendingResult.rows[0].has_pending_transactions) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'O cartão possui lançamentos pendentes e não pode ser excluído.'
      });
    }

    await client.query(
      "UPDATE transactions SET credit_card_id = NULL WHERE credit_card_id = $1 AND family_id = $2 AND status = 'PAID'",
      [id, req.familyAccess!.familyId]
    );
    await client.query('DELETE FROM credit_cards WHERE id = $1 AND family_id = $2', [id, req.familyAccess!.familyId]);
    await client.query('COMMIT');
    return res.json({ message: 'Cartão de crédito removido com sucesso.' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 6. TRANSAÇÕES / CONTAS A PAGAR E RECEBER
router.get('/api/transactions', requireFamilyPermission('family_read'), async (req: Request, res: Response): Promise<any> => {
  const family_id = req.familyAccess!.familyId;

  try {
    const result = await pool.query(
      `SELECT t.*, c.name AS category_name, a.name AS account_name, cc.name AS credit_card_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN credit_cards cc ON t.credit_card_id = cc.id
       WHERE t.family_id = $1 ORDER BY t.due_date DESC`,
      [String(family_id)]
    );
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/transactions', requireFamilyPermission('transactions_create'), async (req: Request, res: Response): Promise<any> => {
  const {
    account_id,
    credit_card_id,
    category_id,
    description,
    amount,
    transaction_date,
    due_date,
    type,
    status = 'PENDING',
    total_installments = 1,
    start_installment = 1,
    recurrence_months = 1,
    payment_method = 'BOLETO'
  } = req.body;
  const family_id = req.familyAccess!.familyId;

  const transactionAmount = Number(amount);
  if (!family_id || !description || !Number.isFinite(transactionAmount) || transactionAmount <= 0 ||
      !transaction_date || !due_date || !type) {
    return res.status(400).json({ error: 'family_id, description, amount, transaction_date, due_date e type são obrigatórios.' });
  }
  const isBenefitCardPayment = payment_method === 'BENEFIT_CARD' && Boolean(account_id);
  const canSettle = req.familyAccess!.role === 'OWNER' || req.familyAccess!.permissions?.transactions_settle === true;
  const settleImmediately =
    (isBenefitCardPayment || Boolean(req.body.settle_immediately)) &&
    Boolean(account_id) &&
    payment_method !== 'CARD' &&
    canSettle;
  const resolvedInitialStatus = settleImmediately ? 'PAID' : status;
  if (resolvedInitialStatus !== 'PENDING' && !settleImmediately) {
    return res.status(400).json({ error: 'Novos lançamentos devem começar pendentes. Use a ação de baixa para registrar o pagamento.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (account_id && payment_method !== 'CARD') {
      const accountCheck = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [account_id, family_id]
      );
      if (accountCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A conta selecionada não pertence a esta família.' });
      }
    }
    if (category_id) {
      const categoryResult = await client.query(
        'SELECT id FROM categories WHERE id = $1 AND family_id = $2 AND flow_type = $3 FOR SHARE',
        [category_id, family_id, type]
      );
      if (categoryResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A categoria selecionada não pertence a esta família ou ao tipo do lançamento.' });
      }
    }

    if (payment_method === 'CARD' && credit_card_id) {
      const cardResult = await client.query(
        'SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [credit_card_id, family_id]
      );
      if (cardResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'O cartão selecionado não pertence a esta família.' });
      }
    }

    const totalInst = Number(total_installments);
    const startInst = Number(start_installment);
    const recurrenceMonths = Number(recurrence_months);
    if (!Number.isInteger(totalInst) || totalInst < 1 || !Number.isInteger(startInst) || startInst < 1 || startInst > totalInst) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'O total de parcelas e a parcela inicial devem formar um intervalo válido.' });
    }
    if (!Number.isInteger(recurrenceMonths) || recurrenceMonths < 1 || recurrenceMonths > 120 ||
        (recurrenceMonths > 1 && (totalInst !== 1 || startInst !== 1))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A recorrência deve ter entre 1 e 120 meses e não pode ser combinada com parcelamento.' });
    }
    const isRecurring = recurrenceMonths > 1;
    const installmentAmount = Math.round((transactionAmount / totalInst) * 100) / 100;
    const creationCount = isRecurring ? recurrenceMonths : totalInst - startInst + 1;

    let parentId: string | null = null;
    const createdTransactions = [];

    for (let occurrence = 0; occurrence < creationCount; occurrence++) {
      const installmentNumber = isRecurring ? 1 : startInst + occurrence;
      const formattedDueDate = addMonthsToDate(due_date, occurrence);
      const formattedTransactionDate = isRecurring
        ? addMonthsToDate(transaction_date, occurrence)
        : transaction_date;
      const transactionDescription = !isRecurring && totalInst > 1
        ? `${description} (${installmentNumber}/${totalInst})`
        : description;

      const itemAmount = isRecurring ? transactionAmount : installmentAmount;
      const itemStatus = settleImmediately && occurrence === 0 ? 'PAID' : 'PENDING';

      const result = await client.query(
        `INSERT INTO transactions (
          family_id, account_id, credit_card_id, category_id,
          description, amount, paid_amount, payment_date, type, status, transaction_date, due_date,
          installment_number, total_installments, parent_transaction_id, payment_method
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *;`,
        [
          family_id,
          payment_method === 'CARD' ? null : (account_id || null),
          payment_method === 'CARD' ? (credit_card_id || null) : null,
          category_id || null,
          transactionDescription,
          itemAmount,
          itemStatus === 'PAID' ? itemAmount : null,
          itemStatus === 'PAID' ? formattedTransactionDate : null,
          type,
          itemStatus,
          formattedTransactionDate,
          formattedDueDate,
          isRecurring ? 1 : installmentNumber,
          isRecurring ? 1 : totalInst,
          isRecurring ? null : parentId,
          payment_method
        ]
      );

      if (itemStatus === 'PAID' && account_id) {
        const balanceDelta = type === 'INCOME' ? itemAmount : -itemAmount;
        await client.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3',
          [balanceDelta, account_id, family_id]
        );
      }

      if (!isRecurring && occurrence === 0) {
        parentId = result.rows[0].id;
      }
      createdTransactions.push(result.rows[0]);
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: isRecurring
        ? `${createdTransactions.length} lançamentos mensais criados com sucesso!`
        : 'Lançamento(s) criado(s) com sucesso!',
      transactions: createdTransactions
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 6.1 IMPORTAÇÃO EM LOTE DE EXTRATOS / FATURAS (OFX, CSV, PDF, PRINT)
router.post('/api/transactions/batch', requireFamilyPermission('transactions_create'), async (req: Request, res: Response): Promise<any> => {
  const family_id = req.familyAccess!.familyId;
  const canSettle = req.familyAccess!.role === 'OWNER' || req.familyAccess!.permissions?.transactions_settle === true;
  const targetType = req.body?.target_type === 'CARD' ? 'CARD' : 'ACCOUNT';
  const accountId = req.body?.account_id ? String(req.body.account_id) : null;
  const creditCardId = req.body?.credit_card_id ? String(req.body.credit_card_id) : null;
  const settleImmediately = Boolean(req.body?.settle_immediately) && targetType === 'ACCOUNT' && canSettle;
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (rawItems.length === 0 || rawItems.length > 300) {
    return res.status(400).json({ error: 'Selecione entre 1 e 300 lançamentos para importar por vez.' });
  }
  if (targetType === 'ACCOUNT' && !accountId) {
    return res.status(400).json({ error: 'Selecione a conta bancária de destino para importar.' });
  }
  if (targetType === 'CARD' && !creditCardId) {
    return res.status(400).json({ error: 'Selecione o cartão de crédito de destino para importar.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (targetType === 'ACCOUNT' && accountId) {
      const accCheck = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [accountId, family_id]
      );
      if (accCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A conta bancária selecionada não pertence a esta família.' });
      }
    }

    if (targetType === 'CARD' && creditCardId) {
      const cardCheck = await client.query(
        'SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [creditCardId, family_id]
      );
      if (cardCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'O cartão selecionado não pertence a esta família.' });
      }
    }

    const categoriesRes = await client.query(
      'SELECT id, flow_type FROM categories WHERE family_id = $1',
      [family_id]
    );
    const validCategories = new Map<string, string>(
      categoriesRes.rows.map(row => [String(row.id), String(row.flow_type)])
    );

    const createdTransactions = [];
    let netBalanceAdjustment = 0;

    for (const rawItem of rawItems) {
      const description = typeof rawItem?.description === 'string' ? rawItem.description.trim().slice(0, 180) : '';
      const amount = Math.round(Math.abs(Number(rawItem?.amount)) * 100) / 100;
      const type = rawItem?.type === 'INCOME' && targetType === 'ACCOUNT' ? 'INCOME' : 'EXPENSE';
      const txDate = typeof rawItem?.transaction_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawItem.transaction_date)
        ? rawItem.transaction_date
        : new Date().toISOString().split('T')[0];
      const dueDate = typeof rawItem?.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawItem.due_date)
        ? rawItem.due_date
        : txDate;
      const requestedCatId = rawItem?.category_id ? String(rawItem.category_id) : null;
      const categoryId = requestedCatId && validCategories.get(requestedCatId) === type ? requestedCatId : null;

      if (!description || !Number.isFinite(amount) || amount <= 0) {
        continue;
      }

      const status = settleImmediately ? 'PAID' : 'PENDING';
      const paidAmount = settleImmediately ? amount : null;
      const paymentMethod = targetType === 'CARD'
        ? 'CARD'
        : typeof rawItem?.payment_method === 'string' && rawItem.payment_method
          ? rawItem.payment_method
          : 'PIX';

      const insertRes = await client.query(
        `INSERT INTO transactions (
           family_id, account_id, credit_card_id, category_id,
           description, amount, paid_amount, type, status,
           transaction_date, due_date, installment_number, total_installments, payment_method
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 1, $12)
         RETURNING *`,
        [
          family_id,
          targetType === 'ACCOUNT' ? accountId : null,
          targetType === 'CARD' ? creditCardId : null,
          categoryId,
          description,
          amount,
          paidAmount,
          type,
          status,
          txDate,
          dueDate,
          paymentMethod,
        ]
      );

      createdTransactions.push(insertRes.rows[0]);
      if (settleImmediately) {
        netBalanceAdjustment += type === 'INCOME' ? amount : -amount;
      }
    }

    if (createdTransactions.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum lançamento válido foi encontrado para importar.' });
    }

    if (settleImmediately && accountId && netBalanceAdjustment !== 0) {
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3',
        [Math.round(netBalanceAdjustment * 100) / 100, accountId, family_id]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: `${createdTransactions.length} lançamento(s) importado(s) com sucesso!`,
      imported_count: createdTransactions.length,
      transactions: createdTransactions,
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Erro na importação em lote:', err);
    return res.status(500).json({ error: 'Não foi possível concluir a importação em lote.' });
  } finally {
    client.release();
  }
});

// 7. METAS / OBJETIVOS
router.get('/api/goals', requireFamilyPermission('family_read'), async (req: Request, res: Response): Promise<any> => {
  const family_id = req.familyAccess!.familyId;

  try {
    const result = await pool.query(`SELECT * FROM goals WHERE family_id = $1 ORDER BY created_at DESC`, [String(family_id)]);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/goals', requireFamilyPermission('goals_manage'), async (req: Request, res: Response): Promise<any> => {
  const { title, target_amount, months } = req.body;
  const family_id = req.familyAccess!.familyId;
  if (!family_id || !title || !target_amount || !months) {
    return res.status(400).json({ error: 'family_id, title, target_amount e months são obrigatórios.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const goalRes = await client.query(
      `INSERT INTO goals (family_id, title, target_amount, months) VALUES ($1, $2, $3, $4) RETURNING *;`,
      [family_id, title, target_amount, months]
    );

    const investmentCategoryId = await ensureInvestmentCategory(client, Number(family_id));

    const totalInst = Math.max(1, Number(months));
    const instAmount = Math.round((Number(target_amount) / totalInst) * 100) / 100;
    const today = new Date().toISOString().split('T')[0];

    let parentId: string | null = null;
    for (let i = 1; i <= totalInst; i++) {
      const [year, month, day] = today.split('-');
      const targetDate = new Date(Number(year), Number(month) - 1 + (i - 1), Number(day));
      const formattedDueDate = targetDate.toISOString().split('T')[0];

      const txDesc = `Objetivo: ${title} (${i}/${totalInst})`;

      const txRes = await client.query(
        `INSERT INTO transactions (
          family_id, category_id, description, amount, type, status, transaction_date, due_date,
          installment_number, total_installments, parent_transaction_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;`,
        [
          family_id,
          investmentCategoryId,
          txDesc,
          instAmount,
          'EXPENSE',
          'PENDING',
          today,
          formattedDueDate,
          i,
          totalInst,
          parentId
        ]
      );

      if (i === 1) {
        parentId = txRes.rows[0].id;
      }
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Objetivo criado com sucesso!', goal: goalRes.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
// --- EDITAR TRANSAÇÃO ---
router.put('/api/transactions/:id', requireFamilyPermission('transactions_edit'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { description, amount, due_date, status, category_id, account_id, payment_method } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionResult = await client.query(
      'SELECT family_id, type, status, amount, paid_amount, account_id FROM transactions WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [id, req.familyAccess!.familyId]
    );
    const transaction = transactionResult.rows[0];
    if (!transaction) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    const nextStatus = status ?? transaction.status;
    if (nextStatus !== transaction.status) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Use as ações de baixa ou estorno para alterar o status do lançamento.' });
    }
    const parsedAmount = Number(amount);
    if (typeof description !== 'string' || !description.trim() ||
        !Number.isFinite(parsedAmount) || parsedAmount <= 0 ||
        typeof due_date !== 'string' || !due_date) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Informe descrição, valor e vencimento válidos.' });
    }

    if (category_id) {
      const categoryResult = await client.query(
        'SELECT id FROM categories WHERE id = $1 AND family_id = $2 AND flow_type = $3 FOR SHARE',
        [category_id, transaction.family_id, transaction.type]
      );
      if (categoryResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A categoria selecionada não pertence a esta família ou ao tipo do lançamento.' });
      }
    }

    const nextAccountId = payment_method === 'CARD' && transaction.status !== 'PAID'
      ? null
      : account_id || transaction.account_id || null;
    const previousPaidAmount = Number(transaction.paid_amount ?? transaction.amount);
    const nextPaidAmount = transaction.status === 'PAID'
      ? Math.max(parsedAmount, previousPaidAmount + parsedAmount - Number(transaction.amount))
      : null;
    if (nextAccountId) {
      const accountResult = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [nextAccountId, req.familyAccess!.familyId]
      );
      if (accountResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A conta selecionada não pertence a esta família.' });
      }
    }

    if (transaction.status === 'PAID' &&
        (previousPaidAmount !== nextPaidAmount || String(transaction.account_id) !== String(nextAccountId))) {
      if (!transaction.account_id || !nextAccountId) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Não é possível ajustar o saldo de um lançamento pago sem uma conta vinculada.' });
      }
      const previousAccountResult = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [transaction.account_id, req.familyAccess!.familyId]
      );
      if (previousAccountResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A conta vinculada ao lançamento pago não pertence mais a esta família.' });
      }
      const balanceSign = transaction.type === 'INCOME' ? 1 : -1;
      if (String(transaction.account_id) === String(nextAccountId)) {
        await client.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3',
          [balanceSign * (Number(nextPaidAmount) - previousPaidAmount), nextAccountId, req.familyAccess!.familyId]
        );
      } else {
        await client.query(
          'UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND family_id = $3',
          [balanceSign * previousPaidAmount, transaction.account_id, req.familyAccess!.familyId]
        );
        await client.query(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3',
          [balanceSign * Number(nextPaidAmount), nextAccountId, req.familyAccess!.familyId]
        );
      }
    }

    const result = await client.query(
      `UPDATE transactions
       SET description = $1, amount = $2, due_date = $3, category_id = $4, account_id = $5, payment_method = $6, paid_amount = $7
       WHERE id = $8 AND family_id = $9 RETURNING *`,
      [
        description.trim(),
        parsedAmount,
        due_date,
        category_id || null,
        nextAccountId,
        payment_method || 'BOLETO',
        nextPaidAmount,
        id,
        req.familyAccess!.familyId
      ]
    );
    await client.query('COMMIT');
    return res.json({ message: 'Transação atualizada.', transaction: result.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- APAGAR TRANSAÇÃO (COM LÓGICA DE PARCELAS) ---
router.patch('/api/transactions/:id/pay', requireFamilyPermission('transactions_settle'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { account_id, paid_amount } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const transactionResult = await client.query(
      'SELECT id, family_id, amount, type, status, account_id FROM transactions WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [id, req.familyAccess!.familyId]
    );
    const transaction = transactionResult.rows[0];

    if (!transaction) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    if (transaction.status === 'PAID') {
      await client.query('COMMIT');
      return res.json({ message: 'Lançamento já está pago.', transaction });
    }

    const finalAmount = Number(paid_amount ?? transaction.amount);
    const validPaidAmount = Number.isFinite(finalAmount) && finalAmount > 0 &&
      (transaction.type === 'EXPENSE' ? finalAmount >= Number(transaction.amount) : finalAmount === Number(transaction.amount));
    if (!validPaidAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'O valor pago deve ser válido e não pode ser inferior ao valor do lançamento.' });
    }

    let accountId = account_id || transaction.account_id;
    if (!accountId) {
      const defaultAccountResult = await client.query(
        'SELECT id FROM accounts WHERE family_id = $1 ORDER BY name ASC LIMIT 1 FOR UPDATE',
        [transaction.family_id]
      );
      accountId = defaultAccountResult.rows[0]?.id;
    }

    if (!accountId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Selecione uma conta para registrar o pagamento.' });
    }

    const accountResult = await client.query(
      'SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [accountId, transaction.family_id]
    );
    if (accountResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A conta selecionada não pertence à família deste lançamento.' });
    }

    const balanceChange = transaction.type === 'INCOME' ? finalAmount : -finalAmount;
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3',
      [balanceChange, accountId, req.familyAccess!.familyId]
    );

    const updatedTransaction = await client.query(
      "UPDATE transactions SET status = 'PAID', account_id = $2, paid_amount = $3 WHERE id = $1 AND family_id = $4 RETURNING *",
      [id, accountId, finalAmount, req.familyAccess!.familyId]
    );

    await client.query('COMMIT');
    return res.json({ message: 'Lançamento baixado com sucesso.', transaction: updatedTransaction.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.patch('/api/transactions/:id/unpay', requireFamilyPermission('transactions_settle'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionResult = await client.query(
      'SELECT id, family_id, amount, paid_amount, type, status, account_id FROM transactions WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [id, req.familyAccess!.familyId]
    );
    const transaction = transactionResult.rows[0];
    if (!transaction) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }
    if (transaction.status !== 'PAID') {
      await client.query('COMMIT');
      return res.json({ message: 'Lançamento já está pendente.', transaction });
    }
    if (!transaction.account_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Não é possível estornar este lançamento porque ele não possui uma conta vinculada.' });
    }

    const accountResult = await client.query(
      'SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE',
      [transaction.account_id, req.familyAccess!.familyId]
    );
    if (accountResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A conta vinculada ao lançamento não pertence mais a esta família.' });
    }

    const settledAmount = Number(transaction.paid_amount ?? transaction.amount);
    const balanceChange = transaction.type === 'INCOME' ? -settledAmount : settledAmount;
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3',
      [balanceChange, transaction.account_id, req.familyAccess!.familyId]
    );
    const updatedTransaction = await client.query(
      "UPDATE transactions SET status = 'PENDING', paid_amount = NULL WHERE id = $1 AND family_id = $2 RETURNING *",
      [id, req.familyAccess!.familyId]
    );
    await client.query('COMMIT');
    return res.json({ message: 'Baixa estornada com sucesso.', transaction: updatedTransaction.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/api/transactions/:id', requireFamilyPermission('transactions_delete'), async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { scope, parent_id } = req.query; // scope pode ser 'single' (apenas esta) ou 'all' (todas da série)
  const deleteSeries = scope === 'all' && parent_id && parent_id !== 'null';
  const transactionFilter = deleteSeries
    ? 'id = $1 OR parent_transaction_id = $1 OR id = $2 OR parent_transaction_id = $2'
    : 'id = $1';
  const transactionParams = deleteSeries ? [parent_id, id] : [id];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT id FROM transactions WHERE (${transactionFilter}) AND family_id = $${transactionParams.length + 1} FOR UPDATE`,
      [...transactionParams, req.familyAccess!.familyId]
    );

    const paidTransactionBalances = await client.query(
      `SELECT account_id, family_id, type, SUM(COALESCE(paid_amount, amount)) AS amount_to_restore
       FROM transactions
       WHERE (${transactionFilter}) AND family_id = $${transactionParams.length + 1}
         AND type IN ('EXPENSE', 'INCOME') AND status = 'PAID' AND account_id IS NOT NULL
       GROUP BY account_id, family_id, type
       ORDER BY account_id`,
      [...transactionParams, req.familyAccess!.familyId]
    );

    for (const transaction of paidTransactionBalances.rows) {
      const balanceChange = transaction.type === 'INCOME'
        ? -Number(transaction.amount_to_restore)
        : Number(transaction.amount_to_restore);
      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3',
        [balanceChange, transaction.account_id, transaction.family_id]
      );
    }

    await client.query(
      `DELETE FROM transactions WHERE (${transactionFilter}) AND family_id = $${transactionParams.length + 1}`,
      [...transactionParams, req.familyAccess!.familyId]
    );
    await client.query('COMMIT');
    return res.json({ message: 'Transação apagada com sucesso.' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
export default router;