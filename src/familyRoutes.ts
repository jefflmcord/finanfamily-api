import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './database';
import {
  createInvitationToken,
  FAMILY_PERMISSIONS,
  hashInvitationToken,
  requireFamilyPermission,
} from './accessControl';

const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const publicRouter = Router();
const router = Router();

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
  return res.json({
    familyId: access.familyId,
    role: access.role,
    permissions: access.role === 'OWNER'
      ? Object.fromEntries(FAMILY_PERMISSIONS.map(permission => [permission, true]))
      : access.permissions,
  });
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
