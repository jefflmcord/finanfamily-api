import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './server';

const router = Router();

// Endpoint de ping (Healthcheck simples)
router.get('/ping', (req: Request, res: Response) => {
  return res.json({ message: 'pong' });
});

// Endpoint 1: Login de Usuário
router.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  try {
    // 1. Buscar o usuário pelo e-mail
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // 2. Verificar se a senha confere com o hash salvo no banco
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // 3. Gerar o Token JWT
    const secret = process.env.JWT_SECRET || 'finanfamily_secreto_2026_super_seguro';
    const token = jwt.sign(
      { id: user.id, family_id: user.family_id },
      secret,
      { expiresIn: '1d' } // Token válido por 1 dia
    );

    // 4. Retornar os dados de acesso (incluindo a flag de troca de senha no primeiro acesso)
    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        family_id: user.family_id,
        must_change_password: user.must_change_password
      }
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// Endpoint 2: Troca de Senha Obrigatória (Primeiro Acesso)
router.post('/api/update-password', async (req: Request, res: Response): Promise<any> => {
  const { email, oldPassword, newPassword } = req.body;

  if (!email || !oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    // Verificar se a senha atual (provisória) está correta
    const isPasswordValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'A senha provisória informada está incorreta.' });
    }

    // Gerar o hash da nova senha definitiva
    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    // Atualizar no banco e liberar a trava de troca obrigatória
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [newPasswordHash, user.id]
    );

    return res.status(200).json({ message: 'Senha atualizada com sucesso!' });
  } catch (error) {
    console.error('Erro ao atualizar senha:', error);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

export default router;