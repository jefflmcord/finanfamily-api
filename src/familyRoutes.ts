import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './database';
import {
  createInvitationToken,
  FAMILY_PERMISSIONS,
  hashInvitationToken,
  INTERNAL_ADMIN_EMAIL,
  requireFamilyPermission,
} from './accessControl';

const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const publicRouter = Router();
const router = Router();

const VALID_PLAN_TYPES = ['TRIAL', 'MONTHLY', 'ANNUAL', 'COURTESY'] as const;
const VALID_BROADCAST_TYPES = ['INFO', 'SUCCESS', 'WARNING'] as const;

async function isInternalAdmin(userId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM users WHERE id::text = $1 AND LOWER(email) = $2',
    [userId, INTERNAL_ADMIN_EMAIL]
  );
  return result.rows.length > 0;
}

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
    const settingsResult = await pool.query(
      `SELECT key, value FROM system_settings WHERE key IN ('global_broadcast_message', 'global_broadcast_type')`
    );
    const settingsMap = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));
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

router.get('/api/internal/tenants', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!await isInternalAdmin(req.familyAccess!.userId)) {
      return res.status(403).json({ error: 'Acesso não autorizado.' });
    }

    const [tenantsResult, settingsResult] = await Promise.all([
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
    ]);

    const settingsMap = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));

    return res.json({
      tenants: tenantsResult.rows,
      contactPhone: settingsMap.tenant_support_phone || '(41) 0000-0000',
      broadcastMessage: settingsMap.global_broadcast_message || '',
      broadcastType: settingsMap.global_broadcast_type || 'INFO',
    });
  } catch (error: any) {
    console.error('Erro ao carregar relatório interno de tenants:', error);
    return res.status(500).json({ error: 'Não foi possível carregar o relatório interno.' });
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
      `SELECT id, name, email, avatar_url, phone, birth_date, bio
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
    return res.json({ message: 'Membro removido da família.' });
  } catch (error: any) {
    console.error('Erro ao remover membro da família:', error);
    return res.status(500).json({ error: 'Não foi possível remover o membro.' });
  }
});

export { publicRouter as publicFamilyRouter };
export default router;
