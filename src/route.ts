import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './server';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Rota raiz para teste de status
router.get('/', (req: Request, res: Response) => {
  return res.status(200).json({ status: 'online', message: 'API FinanFamily a funcionar perfeitamente!' });
});

// Middleware de Autenticação
const authenticateToken = (req: any, res: Response, next: NextFunction): any => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Acesso negado. Token ausente.' });

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: 'Token inválido ou expirado.' });
    req.user = user;
    next();
  });
};

// 1. LOGIN TRADICIONAL
router.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e palavra-passe são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
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

    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(200).json({ token, user: safeUser });
  } catch (err: any) {
    console.error('Erro no login:', err);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// 2. GOOGLE OAUTH (LOGIN / REGISTRO COM GOOGLE)
router.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Token do Google não fornecido.' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Falha ao ler dados do Google.' });
    }

    const { email, name, sub: googleId, picture: avatarUrl } = payload;
    const cleanEmail = email.toLowerCase();

    let result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    let user = result.rows[0];

    if (user) {
      if (!user.google_id) {
        const updateResult = await pool.query(
          'UPDATE users SET google_id = $1, avatar_url = $2, email_verified = TRUE WHERE id = $3 RETURNING *',
          [googleId, avatarUrl, user.id]
        );
        user = updateResult.rows[0];
      }
    } else {
      // Criação automática de Família e Utilizador (Tenant) para quem entra com Google
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const familyRes = await client.query('INSERT INTO families (name) VALUES ($1) RETURNING id', [`Família de ${name || 'Utilizador'}`]);
        const familyId = familyRes.rows[0].id;

        await client.query('INSERT INTO accounts (family_id, name, current_balance) VALUES ($1, $2, $3)', [familyId, 'Conta Principal', 0]);

        const userRes = await client.query(
          `INSERT INTO users (name, email, google_id, avatar_url, family_id, email_verified) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, name, email, family_id, avatar_url`,
          [name || 'Utilizador', cleanEmail, googleId, avatarUrl || null, familyId]
        );
        user = userRes.rows[0];
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    const token = jwt.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({ token, user });
  } catch (err: any) {
    console.error('Erro no Google Auth:', err);
    return res.status(500).json({ error: 'Erro ao autenticar com o Google.' });
  }
});

// 3. CONTAS BANCÁRIAS
router.get('/api/accounts', async (req: Request, res: Response): Promise<any> => {
  const { family_id } = req.query;
  if (!family_id) return res.status(400).json({ error: 'family_id é obrigatório.' });

  try {
    const result = await pool.query(
      `SELECT id, name, initial_balance, current_balance, color FROM accounts WHERE family_id = $1 ORDER BY name ASC`,
      [String(family_id)]
    );
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. CATEGORIAS
router.get('/api/categories', async (req: Request, res: Response): Promise<any> => {
  const { family_id } = req.query;
  if (!family_id) return res.status(400).json({ error: 'family_id é obrigatório.' });

  try {
    const result = await pool.query(`SELECT * FROM categories WHERE family_id = $1 ORDER BY name ASC`, [String(family_id)]);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 5. CARTÕES DE CRÉDITO
router.get('/api/credit-cards', async (req: Request, res: Response): Promise<any> => {
  const { family_id } = req.query;
  if (!family_id) return res.status(400).json({ error: 'family_id é obrigatório.' });

  try {
    const result = await pool.query(`SELECT * FROM credit_cards WHERE family_id = $1 ORDER BY name ASC`, [String(family_id)]);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/api/credit-cards', async (req: Request, res: Response): Promise<any> => {
  const { family_id, name, brand, total_limit, closing_day, due_day } = req.body;
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

// 6. TRANSAÇÕES / CONTAS A PAGAR E RECEBER
router.get('/api/transactions', async (req: Request, res: Response): Promise<any> => {
  const { family_id } = req.query;
  if (!family_id) return res.status(400).json({ error: 'family_id é obrigatório.' });

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

router.post('/api/transactions', async (req: Request, res: Response): Promise<any> => {
  const {
    family_id,
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
    payment_method = 'BOLETO'
  } = req.body;

  if (!family_id || !description || !amount || !transaction_date || !due_date || !type) {
    return res.status(400).json({ error: 'family_id, description, amount, transaction_date, due_date e type são obrigatórios.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const totalInst = Math.max(1, Number(total_installments));
    const instAmount = Math.round((Number(amount) / totalInst) * 100) / 100;

    let parentId: string | null = null;
    const createdTransactions = [];

    for (let i = Number(start_installment); i <= totalInst; i++) {
      const [year, month, day] = due_date.split('-');
      const targetDate = new Date(Number(year), Number(month) - 1 + (i - 1), Number(day));
      const formattedDueDate = targetDate.toISOString().split('T')[0];

      const installmentDescription = totalInst > 1 ? `${description} (${i}/${totalInst})` : description;

      const result = await client.query(
        `INSERT INTO transactions (
          family_id, account_id, credit_card_id, category_id,
          description, amount, type, status, transaction_date, due_date,
          installment_number, total_installments, parent_transaction_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *;`,
        [
          family_id,
          payment_method === 'CARD' ? null : (account_id || null),
          payment_method === 'CARD' ? (credit_card_id || null) : null,
          category_id || null,
          installmentDescription,
          instAmount,
          type,
          status,
          transaction_date,
          formattedDueDate,
          i,
          totalInst,
          parentId
        ]
      );

      if (i === Number(start_installment)) {
        parentId = result.rows[0].id;
      }
      createdTransactions.push(result.rows[0]);
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Lançamento(s) criado(s) com sucesso!', transactions: createdTransactions });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 7. METAS / INVESTIMENTOS
router.get('/api/goals', async (req: Request, res: Response): Promise<any> => {
  const { family_id } = req.query;
  if (!family_id) return res.status(400).json({ error: 'family_id é obrigatório.' });

  try {
    const result = await pool.query(`SELECT * FROM goals WHERE family_id = $1 ORDER BY created_at DESC`, [String(family_id)]);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DASHBOARD SUMMARY
router.get('/api/dashboard/summary', authenticateToken, async (req: any, res: Response): Promise<any> => {
  const familyId = req.user.family_id;
  try {
    const balanceResult = await pool.query('SELECT COALESCE(SUM(current_balance), 0) as total FROM accounts WHERE family_id = $1', [familyId]);
    const incomeResult = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE family_id = $1 AND type='INCOME' AND status='PAID'", [familyId]);
    const expenseResult = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE family_id = $1 AND type='EXPENSE' AND status='PAID'", [familyId]);

    return res.status(200).json({
      balance: parseFloat(balanceResult.rows[0].total),
      income: parseFloat(incomeResult.rows[0].total),
      expense: parseFloat(expenseResult.rows[0].total),
      categories: []
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/api/dashboard/data', authenticateToken, async (req: any, res: Response): Promise<any> => {
  const familyId = req.user.family_id;
  try {
    const categories = await pool.query('SELECT * FROM categories WHERE family_id = $1', [familyId]);
    const accounts = await pool.query('SELECT * FROM accounts WHERE family_id = $1', [familyId]);
    const cards = await pool.query('SELECT * FROM credit_cards WHERE family_id = $1', [familyId]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE family_id = $1', [familyId]);

    return res.status(200).json({
      categories: categories.rows,
      accounts: accounts.rows,
      cards: cards.rows,
      transactions: transactions.rows
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;