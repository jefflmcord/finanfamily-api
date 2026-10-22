import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './database';
import {
  createInvitationToken,
  FAMILY_PERMISSIONS,
  hashInvitationToken,
  INTERNAL_ADMIN_EMAIL,
  invalidateAuthMembershipCache,
  requireFamilyPermission,
} from './accessControl';

const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const publicRouter = Router();
const router = Router();

const VALID_PLAN_TYPES = ['TRIAL', 'MONTHLY', 'ANNUAL', 'COURTESY'] as const;
const VALID_BROADCAST_TYPES = ['INFO', 'SUCCESS', 'WARNING'] as const;
const VALID_LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED'] as const;

const DEFAULT_FAMILY_CATEGORIES: Array<{ name: string; flow_type: 'EXPENSE' | 'INCOME' }> = [
  { name: 'Investimento', flow_type: 'EXPENSE' },
  { name: 'Moradia & Contas', flow_type: 'EXPENSE' },
  { name: 'Supermercado & Alimentação', flow_type: 'EXPENSE' },
  { name: 'Transporte & Combustível', flow_type: 'EXPENSE' },
  { name: 'Saúde & Farmácia', flow_type: 'EXPENSE' },
  { name: 'Lazer & Assinaturas', flow_type: 'EXPENSE' },
  { name: 'Salário & Pró-labore', flow_type: 'INCOME' },
  { name: 'Renda Extra', flow_type: 'INCOME' },
];

export async function seedDefaultFamilyResources(client: any, familyId: string | number): Promise<void> {
  await client.query(
    'INSERT INTO accounts (family_id, name, bank_name, balance, initial_balance) VALUES ($1, $2, $3, $4, $5)',
    [familyId, 'Conta Principal', 'Conta Principal', 0, 0]
  );
  for (const category of DEFAULT_FAMILY_CATEGORIES) {
    await client.query(
      'INSERT INTO categories (family_id, name, flow_type) VALUES ($1, $2, $3)',
      [familyId, category.name, category.flow_type]
    );
  }
}

async function isInternalAdmin(userId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM users WHERE id::text = $1 AND LOWER(email) = $2',
    [userId, INTERNAL_ADMIN_EMAIL]
  );
  return result.rows.length > 0;
}

publicRouter.post('/api/public/register', async (req: Request, res: Response): Promise<any> => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  const familyNameInput = typeof req.body?.family_name === 'string' ? req.body.family_name.trim().slice(0, 120) : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const whatsapp = typeof req.body?.whatsapp === 'string' ? req.body.whatsapp.trim().slice(0, 40) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const digitCount = whatsapp.replace(/\D/g, '').length;

  if (name.length < 2) {
    return res.status(400).json({ error: 'Informe seu nome completo.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Informe um endereço de e-mail válido.' });
  }
  if (digitCount < 8 || digitCount > 15) {
    return res.status(400).json({ error: 'Informe um WhatsApp válido com DDD.' });
  }
  if (password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingUser = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = $1 FOR UPDATE',
      [email]
    );
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Este e-mail já possui uma conta cadastrada. Use a aba "Já tenho conta" para entrar.',
      });
    }

    const familyName = familyNameInput || `Família de ${name.split(' ')[0]}`;
    const familyRes = await client.query(
      `INSERT INTO families (name, registered_at, plan_type, trial_ends_at)
       VALUES ($1, NOW(), 'TRIAL', NOW() + INTERVAL '10 days')
       RETURNING id`,
      [familyName]
    );
    const familyId = familyRes.rows[0].id;

    await seedDefaultFamilyResources(client, familyId);

    const passwordHash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, phone, password_hash, family_id, email_verified)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, name, email, phone, family_id, avatar_url`,
      [name, email, whatsapp, passwordHash, familyId]
    );
    const user = userRes.rows[0];

    const ownerPermissions = Object.fromEntries(FAMILY_PERMISSIONS.map(permission => [permission, true]));
    await client.query(
      `INSERT INTO family_members (family_id, user_id, role, permissions)
       VALUES ($1, $2, 'OWNER', $3::jsonb)`,
      [String(familyId), String(user.id), JSON.stringify(ownerPermissions)]
    );

    await client.query(
      `UPDATE marketing_leads
       SET status = 'CONVERTED',
           whatsapp = COALESCE(NULLIF($1, ''), whatsapp),
           updated_at = NOW()
       WHERE LOWER(email) = $2`,
      [whatsapp, email]
    );

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({ token, user });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Este e-mail já possui uma conta cadastrada.' });
    }
    console.error('Erro ao criar nova conta familiar:', error);
    return res.status(500).json({ error: 'Não foi possível concluir o cadastro agora. Tente novamente.' });
  } finally {
    client.release();
  }
});

publicRouter.post('/api/public/leads/ebook', async (req: Request, res: Response): Promise<any> => {
  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const name = rawName ? rawName.slice(0, 120) : 'Visitante';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const whatsapp = typeof req.body?.whatsapp === 'string' ? req.body.whatsapp.trim().slice(0, 40) : '';
  const digitCount = whatsapp.replace(/\D/g, '').length;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Informe um e-mail válido para baixar o e-book.' });
  }
  if (digitCount < 8 || digitCount > 15) {
    return res.status(400).json({ error: 'Informe um WhatsApp válido com DDD.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO marketing_leads (name, email, whatsapp, source)
       VALUES ($1, $2, $3, 'EBOOK_10_PASSOS')
       ON CONFLICT (email)
       DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> 'Visitante' THEN EXCLUDED.name ELSE marketing_leads.name END,
         whatsapp = EXCLUDED.whatsapp,
         download_count = marketing_leads.download_count + 1,
         updated_at = NOW()
       RETURNING id, name, email, whatsapp, status, download_count, created_at`,
      [name, email, whatsapp]
    );

    await pool.query(
      `UPDATE users SET phone = COALESCE(NULLIF(phone, ''), $1) WHERE LOWER(email) = $2`,
      [whatsapp, email]
    );

    return res.status(201).json({ success: true, lead: result.rows[0] });
  } catch (error: any) {
    console.error('Erro ao registrar lead do e-book:', error);
    return res.status(500).json({ error: 'Não foi possível registrar seus dados no momento.' });
  }
});

publicRouter.post('/api/public/recover-password', async (req: Request, res: Response): Promise<any> => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const whatsapp = typeof req.body?.whatsapp === 'string' ? req.body.whatsapp.trim() : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  const inputDigits = whatsapp.replace(/\D/g, '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Informe o e-mail cadastrado na sua conta.' });
  }
  if (inputDigits.length < 8) {
    return res.status(400).json({ error: 'Informe o WhatsApp cadastrado na conta com DDD.' });
  }
  if (newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: 'A nova senha deve ter entre 6 e 64 caracteres.' });
  }

  try {
    const [userRes, settingRes] = await Promise.all([
      pool.query(
        `SELECT u.id, u.email, u.phone,
                (SELECT ml.whatsapp FROM marketing_leads ml WHERE LOWER(ml.email) = LOWER(u.email) LIMIT 1) AS lead_whatsapp
         FROM users u
         WHERE LOWER(u.email) = $1
         LIMIT 1`,
        [email]
      ),
      pool.query(`SELECT value FROM system_settings WHERE key = 'tenant_support_phone'`),
    ]);

    const supportPhone = settingRes.rows[0]?.value || '(41) 0000-0000';
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Não encontramos nenhuma conta cadastrada com este e-mail.' });
    }

    const storedPhoneRaw = String(user.phone || user.lead_whatsapp || '');
    const storedDigits = storedPhoneRaw.replace(/\D/g, '');

    if (storedDigits.length < 8) {
      return res.status(409).json({
        code: 'PHONE_NOT_REGISTERED',
        contact_phone: supportPhone,
        error:
          'Esta conta ainda não possui WhatsApp vinculado para validação automática. Solicite a redefinição rápida pelo suporte abaixo.',
      });
    }

    // Compara os últimos 8 dígitos para tolerar presença/ausência do 9º dígito ou DDI 55
    const storedSuffix = storedDigits.slice(-8);
    const inputSuffix = inputDigits.slice(-8);
    if (storedSuffix !== inputSuffix) {
      return res.status(401).json({
        error: 'O WhatsApp informado não confere com o telefone cadastrado para este e-mail.',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           phone = COALESCE(NULLIF(phone, ''), $2),
           reset_token = NULL,
           reset_token_expires_at = NULL
       WHERE id = $3`,
      [passwordHash, whatsapp, user.id]
    );

    return res.json({ message: 'Sua senha foi redefinida com sucesso! Você já pode entrar.' });
  } catch (error: any) {
    console.error('Erro na recuperação de senha:', error);
    return res.status(500).json({ error: 'Não foi possível redefinir sua senha no momento.' });
  }
});

publicRouter.post('/api/forgot-password', async (req: Request, res: Response): Promise<any> => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Informe um e-mail válido.' });
  }

  try {
    const { token, tokenHash } = createInvitationToken();
    await pool.query(
      `UPDATE users
       SET reset_token = $1,
           reset_token_expires_at = NOW() + INTERVAL '2 hours'
       WHERE LOWER(email) = $2`,
      [tokenHash, email]
    );
    return res.json({
      message: 'Se o e-mail estiver cadastrado, as instruções de recuperação foram processadas.',
      reset_token_created: Boolean(token),
    });
  } catch (error: any) {
    console.error('Erro ao solicitar token de redefinição:', error);
    return res.status(500).json({ error: 'Não foi possível processar a solicitação.' });
  }
});

publicRouter.post('/api/reset-password', async (req: Request, res: Response): Promise<any> => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

  if (!token || newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: 'Token válido e senha com no mínimo 6 caracteres são obrigatórios.' });
  }

  try {
    const tokenHash = hashInvitationToken(token);
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           reset_token = NULL,
           reset_token_expires_at = NULL
       WHERE (reset_token = $2 OR reset_token = $3)
         AND (reset_token_expires_at IS NULL OR reset_token_expires_at > NOW())
       RETURNING id`,
      [passwordHash, tokenHash, token]
    );

    if (result.rows.length === 0) {
      return res.status(410).json({ error: 'Este link de recuperação expirou ou já foi utilizado.' });
    }

    return res.json({ message: 'Senha atualizada com sucesso!' });
  } catch (error: any) {
    console.error('Erro ao redefinir senha com token:', error);
    return res.status(500).json({ error: 'Não foi possível redefinir a senha.' });
  }
});

publicRouter.post('/api/family-invitations/accept', async (req: Request, res: Response): Promise<any> => {
  const { token, name, password } = req.body;
  if (typeof token !== 'string' || !token || typeof name !== 'string' ||
      typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Informe um convite válido e os dados de acesso solicitados.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invitationResult = await client.query(
      `SELECT token_hash, family_id, email, permissions, invited_by
       FROM family_invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashInvitationToken(token)]
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Este convite expirou ou já foi utilizado.' });
    }

    const existingUserResult = await client.query(
       'SELECT id, name, email, password_hash, family_id, avatar_url FROM users WHERE LOWER(email) = $1 FOR UPDATE',
      [invitation.email]
    );
    let user = existingUserResult.rows[0];
    if (user) {
       if (user.family_id && String(user.family_id) !== String(invitation.family_id)) {
         await client.query('ROLLBACK');
         return res.status(409).json({ error: 'Esta conta já está vinculada a outra família e não pode ser transferida.' });
       }
       if (!user.password_hash) {
         await client.query('ROLLBACK');
         return res.status(409).json({ error: 'Esta conta foi criada com Google. Use “Continuar com Google” para aceitar o convite.' });
       }
       if (!await bcrypt.compare(password, user.password_hash)) {
         await client.query('ROLLBACK');
         return res.status(401).json({ error: 'A senha informada não corresponde à conta existente.' });
       }
       const existingMembership = await client.query(
         'SELECT family_id FROM family_members WHERE user_id = $1 FOR UPDATE',
         [String(user.id)]
       );
       if (existingMembership.rows.length > 0) {
         await client.query('ROLLBACK');
         return res.status(409).json({ error: 'Esta conta já está vinculada a uma família.' });
       }
       if (!user.family_id) {
         const updatedUser = await client.query(
           'UPDATE users SET family_id = $1 WHERE id = $2 RETURNING id, name, email, family_id, avatar_url',
           [invitation.family_id, user.id]
         );
         user = updatedUser.rows[0];
       }
    } else {
       if (!name.trim() || password.length < 8) {
         await client.query('ROLLBACK');
         return res.status(400).json({ error: 'Informe seu nome e uma senha com pelo menos 8 caracteres.' });
       }
       const passwordHash = await bcrypt.hash(password, 10);
       const userResult = await client.query(
         `INSERT INTO users (name, email, password_hash, family_id, email_verified)
          VALUES ($1, $2, $3, $4, TRUE)
          RETURNING id, name, email, family_id, avatar_url`,
         [name.trim(), invitation.email, passwordHash, invitation.family_id]
       );
       user = userResult.rows[0];
    }

    await client.query(
       `INSERT INTO family_members (family_id, user_id, role, permissions, invited_by)
       VALUES ($1, $2, 'MEMBER', $3::jsonb, $4)`,
      [String(invitation.family_id), String(user.id), JSON.stringify(invitation.permissions), String(invitation.invited_by)]
    );
    await client.query(
      'UPDATE family_invitations SET accepted_at = NOW() WHERE token_hash = $1',
      [invitation.token_hash]
    );
    await client.query('COMMIT');

    const authToken = jwt.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(201).json({ token: authToken, user: safeUser });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Este e-mail já está vinculado a uma conta ou família.' });
    }
    console.error('Erro ao aceitar convite familiar:', error);
    return res.status(500).json({ error: 'Não foi possível aceitar o convite.' });
  } finally {
    client.release();
  }
});

publicRouter.get('/api/family-invitations/preview', async (req: Request, res: Response): Promise<any> => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.status(400).json({ error: 'Token do convite não informado.' });
  try {
    const result = await pool.query(
      `SELECT i.email, i.expires_at, f.name AS family_name,
              (u.id IS NOT NULL) AS has_account,
              (u.password_hash IS NOT NULL) AS has_password
       FROM family_invitations i
       JOIN families f ON f.id::text = i.family_id
       LEFT JOIN users u ON LOWER(u.email) = i.email
       WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW()`,
      [hashInvitationToken(token)]
    );
    if (result.rows.length === 0) {
      return res.status(410).json({ error: 'Este convite expirou ou já foi utilizado.' });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Erro ao consultar convite familiar:', error);
    return res.status(500).json({ error: 'Não foi possível validar o convite.' });
  }
});

router.get('/api/family/access', async (req: Request, res: Response): Promise<any> => {
  const access = req.familyAccess!;
  try {
    const [settingsResult, familyResult] = await Promise.all([
      pool.query(
        `SELECT key, value FROM system_settings WHERE key IN ('global_broadcast_message', 'global_broadcast_type', 'tenant_support_phone')`
      ),
      pool.query(
        `SELECT f.name,
                f.registered_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at
         FROM families f
         WHERE f.id::text = $1`,
        [String(access.familyId)]
      ),
    ]);
    const settingsMap = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));
    const familyRow = familyResult.rows[0];
    return res.json({
      familyId: access.familyId,
      role: access.role,
      permissions: access.role === 'OWNER'
        ? Object.fromEntries(FAMILY_PERMISSIONS.map(permission => [permission, true]))
        : access.permissions,
      broadcast: {
        message: settingsMap.global_broadcast_message || '',
        type: settingsMap.global_broadcast_type || 'INFO',
      },
      subscription: {
        familyName: familyRow?.name || 'Família',
        planType: familyRow?.plan_type || 'TRIAL',
        registeredAt: familyRow?.registered_at || null,
        trialEndsAt: familyRow?.trial_ends_at || null,
        subscriptionEndsAt: familyRow?.subscription_ends_at || null,
        contactPhone: settingsMap.tenant_support_phone || '(41) 0000-0000',
      },
    });
  } catch {
    return res.json({
      familyId: access.familyId,
      role: access.role,
      permissions: access.role === 'OWNER'
        ? Object.fromEntries(FAMILY_PERMISSIONS.map(permission => [permission, true]))
        : access.permissions,
      broadcast: { message: '', type: 'INFO' },
    });
  }
});

router.get('/api/family/bootstrap', async (req: Request, res: Response): Promise<any> => {
  const access = req.familyAccess!;
  const familyIdStr = String(access.familyId);
  const canRead = access.role === 'OWNER' || access.permissions?.family_read === true;

  try {
    const [
      settingsResult,
      familyResult,
      profileResult,
      accountsResult,
      categoriesResult,
      creditCardsResult,
      transactionsResult,
    ] = await Promise.all([
      pool.query(
        `SELECT key, value FROM system_settings WHERE key IN ('global_broadcast_message', 'global_broadcast_type', 'tenant_support_phone')`
      ),
      pool.query(
        `SELECT f.name,
                f.registered_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at
         FROM families f
         WHERE f.id::text = $1`,
        [familyIdStr]
      ),
      pool.query(
        `SELECT id, name, email, avatar_url, phone, birth_date, bio,
                (password_hash IS NOT NULL) AS has_password
         FROM users WHERE id::text = $1`,
        [access.userId]
      ),
      canRead
        ? pool.query(
            `SELECT id, name, bank_name, agency, account_number, pix_key, initial_balance, balance
             FROM accounts
             WHERE family_id::text = $1
             ORDER BY name ASC`,
            [familyIdStr]
          )
        : Promise.resolve({ rows: [] as any[] }),
      canRead
        ? pool.query(
            `SELECT c.*, COUNT(t.id)::int AS transaction_count
             FROM categories c
             LEFT JOIN transactions t ON t.category_id = c.id
             WHERE c.family_id::text = $1
             GROUP BY c.id
             ORDER BY c.name ASC`,
            [familyIdStr]
          )
        : Promise.resolve({ rows: [] as any[] }),
      canRead
        ? pool.query(
            `SELECT * FROM credit_cards WHERE family_id::text = $1 ORDER BY name ASC`,
            [familyIdStr]
          )
        : Promise.resolve({ rows: [] as any[] }),
      canRead
        ? pool.query(
            `SELECT t.*, c.name AS category_name, a.name AS account_name, cc.name AS credit_card_name
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id
             LEFT JOIN accounts a ON t.account_id = a.id
             LEFT JOIN credit_cards cc ON t.credit_card_id = cc.id
             WHERE t.family_id::text = $1
             ORDER BY t.due_date DESC`,
            [familyIdStr]
          )
        : Promise.resolve({ rows: [] as any[] }),
    ]);

    const settingsMap = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));
    const familyRow = familyResult.rows[0];
    let categories = categoriesResult.rows;

    if (canRead && !categories.some(c => String(c.name || '').toLowerCase() === 'investimento')) {
      try {
        const invRes = await pool.query(
          `INSERT INTO categories (family_id, name, flow_type)
           VALUES ($1, 'Investimento', 'EXPENSE')
           RETURNING *`,
          [familyIdStr]
        );
        if (invRes.rows[0]) {
          categories = [...categories, { ...invRes.rows[0], transaction_count: 0 }].sort((a, b) =>
            String(a.name).localeCompare(String(b.name), 'pt-BR')
          );
        }
      } catch {
        // Ignore race condition if inserted concurrently
      }
    }

    return res.json({
      access: {
        familyId: access.familyId,
        role: access.role,
        permissions:
          access.role === 'OWNER'
            ? Object.fromEntries(FAMILY_PERMISSIONS.map(permission => [permission, true]))
            : access.permissions,
        broadcast: {
          message: settingsMap.global_broadcast_message || '',
          type: settingsMap.global_broadcast_type || 'INFO',
        },
        subscription: {
          familyName: familyRow?.name || 'Família',
          planType: familyRow?.plan_type || 'TRIAL',
          registeredAt: familyRow?.registered_at || null,
          trialEndsAt: familyRow?.trial_ends_at || null,
          subscriptionEndsAt: familyRow?.subscription_ends_at || null,
          contactPhone: settingsMap.tenant_support_phone || '(41) 0000-0000',
        },
      },
      profile: profileResult.rows[0] || null,
      accounts: accountsResult.rows,
      categories,
      creditCards: creditCardsResult.rows,
      transactions: transactionsResult.rows,
    });
  } catch (error: any) {
    console.error('Erro no bootstrap do dashboard:', error);
    return res.status(500).json({ error: 'Não foi possível carregar os dados iniciais da família.' });
  }
});

router.get('/api/internal/tenants', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }

    const [tenantsResult, settingsResult, leadsResult] = await Promise.all([
      pool.query(
        `SELECT f.id,
                f.name,
                f.registered_at,
                f.blocked_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at,
                COALESCE(f.admin_notes, '') AS admin_notes,
                u.id AS owner_id,
                u.name AS owner_name,
                u.email AS owner_email,
                u.phone AS owner_phone,
                (SELECT COUNT(*)::int FROM family_members fm2 WHERE fm2.family_id = f.id::text) AS members_count,
                (SELECT COUNT(*)::int FROM accounts a WHERE a.family_id::text = f.id::text) AS accounts_count,
                (SELECT COUNT(*)::int FROM credit_cards cc WHERE cc.family_id::text = f.id::text) AS cards_count,
                (SELECT COUNT(*)::int FROM transactions t WHERE t.family_id::text = f.id::text) AS transactions_count,
                (SELECT MAX(t.transaction_date)::text FROM transactions t WHERE t.family_id::text = f.id::text) AS last_transaction_date
         FROM families f
         LEFT JOIN family_members fm
           ON fm.family_id = f.id::text AND fm.role = 'OWNER'
         LEFT JOIN users u ON u.id::text = fm.user_id
         ORDER BY f.registered_at DESC NULLS LAST, f.id DESC`
      ),
      pool.query(
        `SELECT key, value FROM system_settings WHERE key IN ('tenant_support_phone', 'global_broadcast_message', 'global_broadcast_type')`
      ),
      pool.query(
        `SELECT ml.id,
                ml.name,
                ml.email,
                ml.whatsapp,
                ml.source,
                ml.status,
                COALESCE(ml.notes, '') AS notes,
                ml.download_count,
                ml.created_at,
                ml.updated_at,
                u.id AS matched_user_id,
                f.id AS matched_family_id,
                f.name AS matched_family_name,
                COALESCE(f.plan_type, 'TRIAL') AS matched_plan_type
         FROM marketing_leads ml
         LEFT JOIN users u ON LOWER(u.email) = LOWER(ml.email)
         LEFT JOIN families f ON f.id::text = u.family_id::text
         ORDER BY ml.created_at DESC`
      ),
    ]);

    const settingsMap = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));

    return res.json({
      tenants: tenantsResult.rows,
      leads: leadsResult.rows,
      contactPhone: settingsMap.tenant_support_phone || '(41) 0000-0000',
      broadcastMessage: settingsMap.global_broadcast_message || '',
      broadcastType: settingsMap.global_broadcast_type || 'INFO',
    });
  } catch (error: any) {
    console.error('Erro ao carregar relatório interno de tenants:', error);
    return res.status(500).json({ error: 'Não foi possível carregar o relatório interno.' });
  }
});

router.patch('/api/internal/leads/:leadId', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }
    const leadId = String(req.params.leadId);
    const rawStatus = typeof req.body?.status === 'string' ? req.body.status.toUpperCase() : undefined;
    const status = rawStatus && (VALID_LEAD_STATUSES as readonly string[]).includes(rawStatus)
      ? rawStatus
      : undefined;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 1000) : undefined;

    const result = await pool.query(
      `UPDATE marketing_leads
       SET status = COALESCE($1, status),
           notes = COALESCE($2, notes),
           updated_at = NOW()
       WHERE id::text = $3
       RETURNING id, name, email, whatsapp, source, status, COALESCE(notes, '') AS notes, download_count, created_at, updated_at`,
      [status ?? null, notes ?? null, leadId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead não encontrado.' });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Erro ao atualizar lead comercial:', error);
    return res.status(500).json({ error: 'Não foi possível atualizar o lead.' });
  }
});

router.delete('/api/internal/leads/:leadId', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }
    const leadId = String(req.params.leadId);
    const result = await pool.query(
      `DELETE FROM marketing_leads WHERE id::text = $1 RETURNING id`,
      [leadId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead não encontrado.' });
    }
    return res.json({ message: 'Lead removido.' });
  } catch (error: any) {
    console.error('Erro ao excluir lead comercial:', error);
    return res.status(500).json({ error: 'Não foi possível excluir o lead.' });
  }
});

router.put('/api/internal/contact-phone', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }
    const contactPhone = typeof req.body?.contact_phone === 'string'
      ? req.body.contact_phone.trim()
      : '';
    const digitCount = contactPhone.replace(/\D/g, '').length;
    if (!/^[\d+().\-\s]{8,30}$/.test(contactPhone) || digitCount < 8) {
      return res.status(400).json({ error: 'Informe um telefone válido com pelo menos 8 dígitos.' });
    }
    const result = await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('tenant_support_phone', $1, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING value`,
      [contactPhone]
    );
    return res.json({ contactPhone: result.rows[0].value });
  } catch (error: any) {
    console.error('Erro ao atualizar o telefone de contato interno:', error);
    return res.status(500).json({ error: 'Não foi possível salvar o telefone de contato.' });
  }
});

router.put('/api/internal/broadcast', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const rawType = typeof req.body?.type === 'string' ? req.body.type.toUpperCase() : 'INFO';
    const type = (VALID_BROADCAST_TYPES as readonly string[]).includes(rawType) ? rawType : 'INFO';

    if (message.length > 400) {
      return res.status(400).json({ error: 'O comunicado deve ter até 400 caracteres.' });
    }

    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('global_broadcast_message', $1, NOW()),
              ('global_broadcast_type', $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [message, type]
    );

    return res.json({ broadcastMessage: message, broadcastType: type });
  } catch (error: any) {
    console.error('Erro ao salvar comunicado global:', error);
    return res.status(500).json({ error: 'Não foi possível salvar o comunicado global.' });
  }
});

router.patch('/api/internal/tenants/:familyId/status', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }
    if (typeof req.body?.blocked !== 'boolean') {
      return res.status(400).json({ error: 'Informe se o tenant deve ser bloqueado ou desbloqueado.' });
    }
    const result = await pool.query(
      `UPDATE families f
       SET blocked_at = CASE
         WHEN $2::boolean THEN COALESCE(f.blocked_at, NOW())
         ELSE NULL
       END
       WHERE f.id::text = $1
         AND NOT EXISTS (
           SELECT 1
           FROM family_members fm
           JOIN users u ON u.id::text = fm.user_id
           WHERE fm.family_id = f.id::text
             AND fm.role = 'OWNER'
             AND LOWER(u.email) = $3
         )
       RETURNING f.id, f.blocked_at`,
      [req.params.familyId, req.body.blocked, INTERNAL_ADMIN_EMAIL]
    );
    if (result.rows.length === 0) {
      const familyExists = await pool.query(
        'SELECT 1 FROM families WHERE id::text = $1',
        [req.params.familyId]
      );
      return familyExists.rows.length
        ? res.status(403).json({ error: 'O tenant da conta administrativa não pode ser bloqueado.' })
        : res.status(404).json({ error: 'Tenant não encontrado.' });
    }
    invalidateAuthMembershipCache();
    return res.json({
      id: result.rows[0].id,
      blocked_at: result.rows[0].blocked_at,
    });
  } catch (error: any) {
    console.error('Erro ao alterar o acesso do tenant:', error);
    return res.status(500).json({ error: 'Não foi possível alterar o acesso do tenant.' });
  }
});

router.patch('/api/internal/tenants/:familyId/commercial', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }

    const familyId = String(req.params.familyId);
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const currentRes = await client.query(
        `SELECT f.id,
                f.registered_at,
                f.blocked_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days', NOW() + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at,
                COALESCE(f.admin_notes, '') AS admin_notes,
                u.id AS owner_id,
                u.phone AS owner_phone
         FROM families f
         LEFT JOIN family_members fm ON fm.family_id = f.id::text AND fm.role = 'OWNER'
         LEFT JOIN users u ON u.id::text = fm.user_id
         WHERE f.id::text = $1
         FOR UPDATE OF f`,
        [familyId]
      );

      const current = currentRes.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Tenant não encontrado.' });
      }

      let nextPlanType = current.plan_type;
      if (typeof body.plan_type === 'string' && (VALID_PLAN_TYPES as readonly string[]).includes(body.plan_type)) {
        nextPlanType = body.plan_type;
      }

      let nextTrialEndsAt: string | Date = current.trial_ends_at;
      if (typeof body.extend_trial_days === 'number' && Number.isFinite(body.extend_trial_days)) {
        const baseTime = Math.max(Date.now(), new Date(current.trial_ends_at).getTime());
        nextTrialEndsAt = new Date(baseTime + body.extend_trial_days * 24 * 60 * 60 * 1000).toISOString();
      } else if (typeof body.trial_ends_at === 'string' && body.trial_ends_at.trim()) {
        const parsedTrial = new Date(body.trial_ends_at);
        if (Number.isNaN(parsedTrial.getTime())) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Data de término do teste inválida.' });
        }
        nextTrialEndsAt = parsedTrial.toISOString();
      }

      let nextSubscriptionEndsAt: string | null = current.subscription_ends_at;
      if (body.subscription_ends_at === null || body.subscription_ends_at === '') {
        nextSubscriptionEndsAt = null;
      } else if (typeof body.subscription_ends_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.subscription_ends_at)) {
        nextSubscriptionEndsAt = body.subscription_ends_at;
      }

      if (body.activate_cycle === 'MONTHLY' || body.activate_cycle === 'ANNUAL') {
        nextPlanType = body.activate_cycle;
        const baseDate = nextSubscriptionEndsAt && new Date(`${nextSubscriptionEndsAt}T00:00:00Z`).getTime() > Date.now()
          ? new Date(`${nextSubscriptionEndsAt}T00:00:00Z`)
          : new Date();
        if (body.activate_cycle === 'MONTHLY') {
          baseDate.setUTCMonth(baseDate.getUTCMonth() + 1);
        } else {
          baseDate.setUTCFullYear(baseDate.getUTCFullYear() + 1);
        }
        nextSubscriptionEndsAt = baseDate.toISOString().slice(0, 10);
      }

      const nextAdminNotes = typeof body.admin_notes === 'string'
        ? body.admin_notes.trim().slice(0, 1000)
        : current.admin_notes;

      const unblockOnActivate = Boolean(body.activate_cycle);

      const updatedFamilyRes = await client.query(
        `UPDATE families
         SET plan_type = $1,
             trial_ends_at = $2,
             subscription_ends_at = $3,
             admin_notes = $4,
             blocked_at = CASE WHEN $5::boolean THEN NULL ELSE blocked_at END
         WHERE id::text = $6
         RETURNING id,
                   plan_type,
                   trial_ends_at,
                   subscription_ends_at::text AS subscription_ends_at,
                   COALESCE(admin_notes, '') AS admin_notes,
                   blocked_at`,
        [nextPlanType, nextTrialEndsAt, nextSubscriptionEndsAt, nextAdminNotes, unblockOnActivate, familyId]
      );

      let nextOwnerPhone = current.owner_phone || null;
      if (typeof body.owner_phone === 'string' && current.owner_id) {
        const cleanPhone = body.owner_phone.trim().slice(0, 30);
        const phoneRes = await client.query(
          `UPDATE users SET phone = $1 WHERE id::text = $2 RETURNING phone`,
          [cleanPhone || null, String(current.owner_id)]
        );
        nextOwnerPhone = phoneRes.rows[0]?.phone || null;
      }

      await client.query('COMMIT');
      invalidateAuthMembershipCache();
      return res.json({
        ...updatedFamilyRes.rows[0],
        owner_phone: nextOwnerPhone,
      });
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Erro ao atualizar dados comerciais do tenant:', error);
    return res.status(500).json({ error: 'Não foi possível salvar os dados comerciais do tenant.' });
  }
});

router.post('/api/internal/tenants/:familyId/reset-password', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }

    const familyId = String(req.params.familyId);
    const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password.trim() : '';
    if (newPassword.length < 6 || newPassword.length > 64) {
      return res.status(400).json({ error: 'A senha temporária deve ter entre 6 e 64 caracteres.' });
    }

    const ownerResult = await pool.query(
      `SELECT u.id, u.email, u.name
       FROM family_members fm
       JOIN users u ON u.id::text = fm.user_id
       WHERE fm.family_id = $1 AND fm.role = 'OWNER'
       LIMIT 1`,
      [familyId]
    );
    const owner = ownerResult.rows[0];
    if (!owner) {
      return res.status(404).json({ error: 'Responsável pela família não encontrado.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id::text = $2`,
      [passwordHash, String(owner.id)]
    );

    return res.json({
      message: `Senha redefinida com sucesso para ${owner.email}.`,
      owner_email: owner.email,
    });
  } catch (error: any) {
    console.error('Erro ao redefinir senha administrativa do tenant:', error);
    return res.status(500).json({ error: 'Não foi possível redefinir a senha do responsável.' });
  }
});

router.get('/api/family/profile', async (req: Request, res: Response): Promise<any> => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, avatar_url, phone, birth_date, bio,
              (password_hash IS NOT NULL) AS has_password
       FROM users WHERE id::text = $1`,
      [req.familyAccess!.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil do usuário não encontrado.' });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Erro ao carregar perfil do usuário:', error);
    return res.status(500).json({ error: 'Não foi possível carregar seu perfil.' });
  }
});

router.put('/api/family/password', async (req: Request, res: Response): Promise<any> => {
  const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';

  if (newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: 'A nova senha deve ter entre 6 e 64 caracteres.' });
  }

  try {
    const userRes = await pool.query(
      'SELECT id, password_hash FROM users WHERE id::text = $1',
      [req.familyAccess!.userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    if (user.password_hash) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Informe sua senha atual para confirmar a alteração.' });
      }
      const matches = await bcrypt.compare(currentPassword, user.password_hash);
      if (!matches) {
        return res.status(401).json({ error: 'A senha atual informada está incorreta.' });
      }
    }

    const nextHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id::text = $2',
      [nextHash, req.familyAccess!.userId]
    );

    return res.json({
      message: user.password_hash
        ? 'Sua senha foi alterada com sucesso!'
        : 'Senha de acesso criada com sucesso! Agora você também pode entrar com e-mail e senha.',
      has_password: true,
    });
  } catch (error: any) {
    console.error('Erro ao atualizar senha do perfil:', error);
    return res.status(500).json({ error: 'Não foi possível atualizar sua senha agora.' });
  }
});

router.put('/api/family/profile', async (req: Request, res: Response): Promise<any> => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const optionalFields = ['phone', 'avatar_url', 'birth_date', 'bio'];
  if (optionalFields.some(field => body[field] !== undefined && typeof body[field] !== 'string')) {
    return res.status(400).json({ error: 'Os campos do perfil devem ser enviados como texto.' });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const avatarUrl = typeof body.avatar_url === 'string' ? body.avatar_url.trim() : '';
  const birthDate = typeof body.birth_date === 'string' ? body.birth_date.trim() : '';
  const bio = typeof body.bio === 'string' ? body.bio.trim() : '';

  if (!name || name.length > 100) {
    return res.status(400).json({ error: 'O nome de exibição é obrigatório e deve ter até 100 caracteres.' });
  }
  if (phone.length > 30) {
    return res.status(400).json({ error: 'O telefone deve ter até 30 caracteres.' });
  }
  if (avatarUrl.length > 2048) {
    return res.status(400).json({ error: 'O endereço da foto deve ter até 2048 caracteres.' });
  }
  if (avatarUrl) {
    try {
      const parsedAvatarUrl = new URL(avatarUrl);
      if (parsedAvatarUrl.protocol !== 'https:') throw new Error('Unsupported protocol');
    } catch {
      return res.status(400).json({ error: 'Informe um endereço HTTPS válido para a foto de perfil.' });
    }
  }
  if (birthDate) {
    const parsedBirthDate = new Date(`${birthDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) ||
        Number.isNaN(parsedBirthDate.getTime()) ||
        parsedBirthDate.toISOString().slice(0, 10) !== birthDate ||
        parsedBirthDate.getTime() > Date.now()) {
      return res.status(400).json({ error: 'Informe uma data de nascimento válida, que não seja futura.' });
    }
  }
  if (bio.length > 280) {
    return res.status(400).json({ error: 'A descrição pessoal deve ter até 280 caracteres.' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET name = $1, phone = $2, avatar_url = $3, birth_date = $4, bio = $5
       WHERE id::text = $6
       RETURNING id, name, email, avatar_url, phone, birth_date, bio`,
      [
        name,
        phone || null,
        avatarUrl || null,
        birthDate || null,
        bio || null,
        req.familyAccess!.userId,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil do usuário não encontrado.' });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Erro ao atualizar perfil do usuário:', error);
    return res.status(500).json({ error: 'Não foi possível salvar as alterações do perfil.' });
  }
});

router.get('/api/family/members', requireFamilyPermission('members_manage'), async (req: Request, res: Response): Promise<any> => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.avatar_url, fm.role, fm.permissions, fm.created_at
       FROM family_members fm
       JOIN users u ON u.id::text = fm.user_id
       WHERE fm.family_id = $1
       ORDER BY CASE WHEN fm.role = 'OWNER' THEN 0 ELSE 1 END, u.name ASC`,
      [req.familyAccess!.familyId]
    );
    return res.json(result.rows);
  } catch (error: any) {
    console.error('Erro ao carregar membros da família:', error);
    return res.status(500).json({ error: 'Não foi possível carregar os membros da família.' });
  }
});

router.get('/api/family/invitations', requireFamilyPermission('members_manage'), async (req: Request, res: Response): Promise<any> => {
  try {
    const result = await pool.query(
      `SELECT email, created_at, expires_at
       FROM family_invitations
       WHERE family_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.familyAccess!.familyId]
    );
    return res.json(result.rows);
  } catch (error: any) {
    console.error('Erro ao carregar convites familiares:', error);
    return res.status(500).json({ error: 'Não foi possível carregar os convites.' });
  }
});

router.post('/api/family/invitations', requireFamilyPermission('members_manage'), async (req: Request, res: Response): Promise<any> => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const requestedPermissions = req.body.permissions;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !requestedPermissions || typeof requestedPermissions !== 'object') {
    return res.status(400).json({ error: 'Informe um e-mail válido e as permissões para o membro.' });
  }

  const permissions = Object.fromEntries(
    FAMILY_PERMISSIONS.map(permission => [
      permission,
      permission === 'members_manage' ? false : requestedPermissions[permission] === true,
    ])
  );
  const access = req.familyAccess!;
  const { token, tokenHash } = createInvitationToken();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingMember = await client.query(
      `SELECT 1 FROM family_members fm JOIN users u ON u.id::text = fm.user_id
       WHERE fm.family_id = $1 AND LOWER(u.email) = $2`,
      [access.familyId, email]
    );
    if (existingMember.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este e-mail já pertence a um membro da família.' });
    }

    const existingUser = await client.query(
      'SELECT family_id FROM users WHERE LOWER(email) = $1',
      [email]
    );
    if (
      existingUser.rows.length > 0 &&
      existingUser.rows[0].family_id &&
      String(existingUser.rows[0].family_id) !== String(access.familyId)
    ) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este e-mail já está vinculado a outra família e não pode ser transferido.' });
    }

    await client.query(
      `DELETE FROM family_invitations
       WHERE family_id = $1 AND email = $2 AND accepted_at IS NULL`,
      [access.familyId, email]
    );
    const result = await client.query(
      `INSERT INTO family_invitations
         (token_hash, family_id, email, permissions, invited_by, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW() + INTERVAL '7 days')
       RETURNING email, expires_at`,
      [tokenHash, access.familyId, email, JSON.stringify(permissions), access.userId]
    );
    await client.query('COMMIT');
    return res.status(201).json({ ...result.rows[0], token });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar convite familiar:', error);
    return res.status(500).json({ error: 'Não foi possível criar o convite.' });
  } finally {
    client.release();
  }
});

router.put('/api/family/members/:userId/permissions', requireFamilyPermission('members_manage'), async (req: Request, res: Response): Promise<any> => {
  const userId = String(req.params.userId);
  const requestedPermissions = req.body.permissions;
  if (!requestedPermissions || typeof requestedPermissions !== 'object') {
    return res.status(400).json({ error: 'Informe as permissões do membro.' });
  }
  const permissions = Object.fromEntries(
    FAMILY_PERMISSIONS.map(permission => [
      permission,
      permission === 'members_manage' ? false : requestedPermissions[permission] === true,
    ])
  );
  try {
    const result = await pool.query(
      `UPDATE family_members SET permissions = $1::jsonb
       WHERE family_id = $2 AND user_id = $3 AND role = 'MEMBER'
       RETURNING user_id`,
      [JSON.stringify(permissions), req.familyAccess!.familyId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Membro não encontrado ou sem permissão para editar.' });
    }
    invalidateAuthMembershipCache(userId);
    return res.json({ message: 'Permissões atualizadas.' });
  } catch (error: any) {
    console.error('Erro ao atualizar permissões do membro:', error);
    return res.status(500).json({ error: 'Não foi possível atualizar as permissões.' });
  }
});

router.delete('/api/family/invitations/:email', requireFamilyPermission('members_manage'), async (req: Request, res: Response): Promise<any> => {
  const email = String(req.params.email).trim().toLowerCase();
  try {
    const result = await pool.query(
      `DELETE FROM family_invitations
       WHERE family_id = $1 AND email = $2 AND accepted_at IS NULL
       RETURNING email`,
      [req.familyAccess!.familyId, email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Convite pendente não encontrado.' });
    }
    return res.json({ message: 'Convite revogado.' });
  } catch (error: any) {
    console.error('Erro ao revogar convite familiar:', error);
    return res.status(500).json({ error: 'Não foi possível revogar o convite.' });
  }
});

router.delete('/api/family/members/:userId', requireFamilyPermission('members_manage'), async (req: Request, res: Response): Promise<any> => {
  const userId = String(req.params.userId);
  try {
    const result = await pool.query(
      `DELETE FROM family_members
       WHERE family_id = $1 AND user_id = $2 AND role = 'MEMBER'
       RETURNING user_id`,
      [req.familyAccess!.familyId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Membro não encontrado ou não pode ser removido.' });
    }
    invalidateAuthMembershipCache(userId);
    return res.json({ message: 'Membro removido da família.' });
  } catch (error: any) {
    console.error('Erro ao remover membro da família:', error);
    return res.status(500).json({ error: 'Não foi possível remover o membro.' });
  }
});

export { publicRouter as publicFamilyRouter };
export default router;
