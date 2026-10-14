import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './server';

const router = Router();

// Endpoint de ping (Healthcheck simples)
router.get('/ping', (req: Request, res: Response) => {
  return res.json({ message: 'pong' });
});

// Endpoint 1: Login
router.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  try {
    // 1. Procurar o utilizador pelo email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // 2. Verificar se a senha confere com o hash
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

    // 4. Devolver os dados de acesso (incluindo o aviso de troca de senha)
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

// Endpoint 2: Troca de Senha Obrigatória
router.post('/api/update-password', async (req: Request, res: Response): Promise<any> => {
  const { email, oldPassword, newPassword } = req.body;

  if (!email || !oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }

    // Verificar se a senha atual (provisória) está correta
    const isPasswordValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'A senha atual está incorreta.' });
    }

    // Gerar o hash da nova senha
    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    // Atualizar no banco e remover a trava de troca obrigatória
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

// Rota temporária para criar o administrador com a criptografia correta
router.get('/api/setup', async (req: Request, res: Response): Promise<any> => {
  try {
    const email = 'admin@finanfamily.com';
    const password = '123456';
    const family_id = '0663962f-71e2-43e1-a8a5-0c017f68536d';

    // 1. Gera a palavra-passe criptografada perfeitamente
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    // 2. Apaga o utilizador antigo com erro e insere o novo
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    await pool.query(
      'INSERT INTO users (family_id, name, email, password_hash, must_change_password) VALUES ($1, $2, $3, $4, TRUE)',
      [family_id, 'Administrador FinanFamily', email, hash]
    );

    return res.json({ message: 'Utilizador criado com sucesso! Pode efetuar o login.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao criar utilizador.' });
  }
});
export default router;