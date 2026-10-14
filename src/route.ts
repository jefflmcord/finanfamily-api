import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './server';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026_super_seguro';

// Função auxiliar que cria o ambiente completo (Multi-Tenant) para um novo cliente
async function provisionNewFamilyTenant(name: string, email: string, passwordHash: string | null, googleId: string | null, avatarUrl: string | null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Criar a Família (Tenant)
    const familyName = `Família de ${name.split(' ')[0]}`;
    const familyRes = await client.query(
      'INSERT INTO families (name) VALUES ($1) RETURNING id',
      [familyName]
    );
    const familyId = familyRes.rows[0].id;

    // 2. Criar o Usuário Principal vinculado à Família
    const userRes = await client.query(
      `INSERT INTO users (family_id, name, email, password_hash, google_id, avatar_url, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE)
       RETURNING id, name, email, family_id, must_change_password, avatar_url`,
      [familyId, name, email, passwordHash, googleId, avatarUrl]
    );
    const newUser = userRes.rows[0];

    // 3. Criar Conta Bancária Inicial Padrão (se a tabela accounts existir)
    try {
      await client.query(
        `INSERT INTO accounts (family_id, name, type, balance)
         VALUES ($1, 'Conta Principal', 'CHECKING', 0)`,
        [familyId]
      );
    } catch (e) {
      console.warn('Aviso: Tabela accounts ignorada no seed inicial:', e);
    }

    // 4. Criar Categorias Padrão (se a tabela categories existir)
    try {
      const defaultCategories = [
        { name: 'Salário / Renda', type: 'INCOME', color: '#10b981' },
        { name: 'Moradia', type: 'EXPENSE', color: '#3b82f6' },
        { name: 'Alimentação', type: 'EXPENSE', color: '#f59e0b' },
        { name: 'Transporte', type: 'EXPENSE', color: '#8b5cf6' },
        { name: 'Saúde', type: 'EXPENSE', color: '#ec4899' },
        { name: 'Lazer', type: 'EXPENSE', color: '#06b6d4' },
        { name: 'Investimentos', type: 'EXPENSE', color: '#14b8a6' },
      ];

      for (const cat of defaultCategories) {
        await client.query(
          `INSERT INTO categories (family_id, name, type, color)
           VALUES ($1, $2, $3, $4)`,
          [familyId, cat.name, cat.type, cat.color]
        );
      }
    } catch (e) {
      console.warn('Aviso: Tabela categories ignorada no seed inicial:', e);
    }

    await client.query('COMMIT');
    return newUser;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Endpoint de ping
router.get('/ping', (req: Request, res: Response) => {
  return res.json({ message: 'pong' });
});

// Endpoint 1: Login Tradicional (E-mail e Senha)
router.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (!user.password_hash) {
      return res.status(401).json({
        error: 'Esta conta foi criada com o Google. Clique em "Continuar com o Google" para entrar.'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = jwt.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        family_id: user.family_id,
        must_change_password: user.must_change_password,
        avatar_url: user.avatar_url || null
      }
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// Endpoint 2: Login / Cadastro Automático com Google (Multi-Tenant)
router.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: 'Token do Google não fornecido.' });
  }

  try {
    // 1. Validar o token diretamente na API oficial do Google
    const googleVerifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`;
    const googleRes = await fetch(googleVerifyUrl);

    if (!googleRes.ok) {
      return res.status(401).json({ error: 'Token do Google inválido ou expirado.' });
    }

    const googleData: any = await googleRes.json();
    const email = (googleData.email || '').toLowerCase();
    const name = googleData.name || 'Usuário FinanFamily';
    const googleId = googleData.sub;
    const avatarUrl = googleData.picture || null;

    if (!email) {
      return res.status(400).json({ error: 'Não foi possível obter o e-mail da sua conta Google.' });
    }

    // 2. Verificar se o usuário já existe no banco
    const existingRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = existingRes.rows[0];

    if (user) {
      // Se já existia, atualiza o google_id e foto caso ainda não estejam preenchidos
      if (!user.google_id || !user.avatar_url) {
        const updateRes = await pool.query(
          `UPDATE users 
           SET google_id = COALESCE(google_id, $1), 
               avatar_url = COALESCE(avatar_url, $2) 
           WHERE id = $3 
           RETURNING *`,
          [googleId, avatarUrl, user.id]
        );
        user = updateRes.rows[0];
      }
    } else {
      // 3. Se NÃO existe, provisiona automaticamente a Família + Usuário + Categorias + Conta!
      user = await provisionNewFamilyTenant(name, email, null, googleId, avatarUrl);
    }

    // 4. Emitir o Token JWT do FinanFamily
    const token = jwt.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        family_id: user.family_id,
        must_change_password: false,
        avatar_url: user.avatar_url || null
      }
    });
  } catch (error) {
    console.error('Erro na autenticação Google:', error);
    return res.status(500).json({ error: 'Erro ao autenticar com o Google.' });
  }
});

// Endpoint 3: Criar Conta Manualmente (Self-Service sem Google)
router.post('/api/register', async (req: Request, res: Response): Promise<any> => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    const cleanEmail = email.trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Este e-mail já está cadastrado. Faça login.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Provisiona a Família + Usuário + Dados Iniciais automaticamente
    const newUser = await provisionNewFamilyTenant(name.trim(), cleanEmail, passwordHash, null, null);

    const token = jwt.sign(
      { id: newUser.id, family_id: newUser.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        family_id: newUser.family_id,
        must_change_password: false,
        avatar_url: null
      }
    });
  } catch (error) {
    console.error('Erro ao criar conta:', error);
    return res.status(500).json({ error: 'Erro ao criar a sua conta.' });
  }
});

// Endpoint 4: Troca de Senha Obrigatória (Primeiro Acesso)
router.post('/api/update-password', async (req: Request, res: Response): Promise<any> => {
  const { email, oldPassword, newPassword } = req.body;

  if (!email || !oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];

    if (!user || !user.password_hash) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'A senha provisória informada está incorreta.' });
    }

    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

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