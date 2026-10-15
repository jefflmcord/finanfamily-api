import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './server';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'SEU_CLIENT_ID_DO_GOOGLE';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'seu-email-real@gmail.com',
    pass: process.env.SMTP_PASS || 'sua-senha-de-aplicativo',
  },
});

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

async function provisionNewFamilyTenant(
  name: string,
  email: string,
  passwordHash: string | null,
  googleId: string | null,
  avatarUrl: string | null,
  emailVerified: boolean,
  verificationToken: string | null
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const familyResult = await client.query(
      'INSERT INTO families (name) VALUES ($1) RETURNING id',
      [`Família de ${name}`]
    );
    const familyId = familyResult.rows[0].id;

    await client.query(
      'INSERT INTO accounts (family_id, name, balance) VALUES ($1, $2, $3)',
      [familyId, 'Conta Principal', 0]
    );

    const defaultCategories = [
      { name: 'Moradia & Contas', type: 'expense', color: '#6366f1' },
      { name: 'Alimentação', type: 'expense', color: '#f59e0b' },
      { name: 'Transporte', type: 'expense', color: '#3b82f6' },
      { name: 'Saúde', type: 'expense', color: '#ef4444' },
      { name: 'Lazer', type: 'expense', color: '#ec4899' },
      { name: 'Salário', type: 'income', color: '#10b981' },
      { name: 'Rendimentos', type: 'income', color: '#3b82f6' },
    ];

    for (const cat of defaultCategories) {
      await client.query(
        'INSERT INTO categories (family_id, name, type, color) VALUES ($1, $2, $3, $4)',
        [familyId, cat.name, cat.type, cat.color]
      );
    }

    const userResult = await client.query(
      `INSERT INTO users 
      (name, email, password_hash, google_id, avatar_url, family_id, email_verified, verification_token) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, family_id, avatar_url`,
      [name, email, passwordHash, googleId, avatarUrl, familyId, emailVerified, verificationToken]
    );

    await client.query('COMMIT');
    return userResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Auth Routes
router.post('/api/register', async (req: Request, res: Response): Promise<any> => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Preencha todos os campos corretamente.' });
  }
  try {
    const cleanEmail = email.trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'E-mail já cadastrado.' });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    await provisionNewFamilyTenant(name.trim(), cleanEmail, passwordHash, null, null, false, verificationToken);
    
    const verifyUrl = `${FRONTEND_URL}/verificar-email?token=${verificationToken}`;
    await transporter.sendMail({
      from: '"Equipe FinanFamily" <seu-email-real@gmail.com>',
      to: cleanEmail,
      subject: 'Confirme seu e-mail',
      html: `<p>Clique para verificar: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });

    return res.status(201).json({ message: 'Conta criada! Verifique seu e-mail.' });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

router.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Credenciais inválidas.' });
    if (!user.email_verified) return res.status(403).json({ error: 'E-mail não verificado.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const token = jwt.sign({ id: user.id, family_id: user.family_id }, JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(200).json({ token, user: safeUser });
  } catch (error) {
    return res.status(500).json({ error: 'Erro no login.' });
  }
});

router.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  const { credential } = req.body;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) return res.status(400).json({ error: 'Erro Google OAuth.' });

    const { email, name, sub: googleId, picture: avatarUrl } = payload;
    const cleanEmail = email.toLowerCase();
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    let user = result.rows[0];

    if (!user) {
      user = await provisionNewFamilyTenant(name || 'Usuário', cleanEmail, null, googleId, avatarUrl || null, true, null);
    }

    const token = jwt.sign({ id: user.id, family_id: user.family_id }, JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(200).json({ token, user: safeUser });
  } catch (error) {
    return res.status(500).json({ error: 'Erro Google.' });
  }
});

router.post('/api/verify-email', async (req: Request, res: Response): Promise<any> => {
  const { token } = req.body;
  const result = await pool.query('UPDATE users SET email_verified = TRUE, verification_token = NULL WHERE verification_token = $1 RETURNING id', [token]);
  if (result.rows.length === 0) return res.status(400).json({ error: 'Token inválido.' });
  return res.status(200).json({ message: 'E-mail verificado!' });
});

// Dashboard Summary & Data
router.get('/api/dashboard/summary', authenticateToken, async (req: any, res: Response): Promise<any> => {
  const familyId = req.user.family_id;
  try {
    const balanceResult = await pool.query('SELECT COALESCE(SUM(balance), 0) as total FROM accounts WHERE family_id = $1', [familyId]);
    const incomeResult = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE family_id = $1 AND type='income' AND date >= date_trunc('month', CURRENT_DATE)", [familyId]);
    const expenseResult = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE family_id = $1 AND type='expense' AND date >= date_trunc('month', CURRENT_DATE)", [familyId]);
    
    const categories = await pool.query(`
      SELECT c.name, c.color, COALESCE(SUM(t.amount), 0) as total
      FROM categories c
      LEFT JOIN transactions t ON c.id = t.category_id AND t.date >= date_trunc('month', CURRENT_DATE)
      WHERE c.family_id = $1 AND c.type = 'expense'
      GROUP BY c.id, c.name, c.color HAVING COALESCE(SUM(t.amount), 0) > 0
    `, [familyId]);

    return res.status(200).json({
      balance: parseFloat(balanceResult.rows[0].total),
      income: parseFloat(incomeResult.rows[0].total),
      expense: parseFloat(expenseResult.rows[0].total),
      categories: categories.rows,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erro no resumo.' });
  }
});

router.get('/api/dashboard/data', authenticateToken, async (req: any, res: Response): Promise<any> => {
  const familyId = req.user.family_id;
  try {
    const categories = await pool.query('SELECT * FROM categories WHERE family_id = $1', [familyId]);
    const accounts = await pool.query('SELECT * FROM accounts WHERE family_id = $1', [familyId]);
    const cards = await pool.query('SELECT * FROM credit_cards WHERE family_id = $1', [familyId]);
    const transactions = await pool.query(`
      SELECT t.*, c.name as category_name, c.color as category_color, cc.name as card_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN credit_cards cc ON t.credit_card_id = cc.id
      WHERE t.family_id = $1 ORDER BY t.date DESC LIMIT 100
    `, [familyId]);

    return res.status(200).json({
      categories: categories.rows,
      accounts: accounts.rows,
      cards: cards.rows,
      transactions: transactions.rows,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao buscar dados.' });
  }
});

// Criar Transação / Contas a Pagar / Receber com Parcelamento e Cartão
router.post('/api/transactions', authenticateToken, async (req: any, res: Response): Promise<any> => {
  const familyId = req.user.family_id;
  const userId = req.user.id;
  const { description, amount, type, category_id, account_id, credit_card_id, payment_method, date, due_date, installment_total, status } = req.body;

  if (!description || !amount || !type || !date) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const totalInst = parseInt(installment_total) || 1;
    const baseAmount = parseFloat(amount);
    const installmentValue = Number((baseAmount / totalInst).toFixed(2));

    for (let i = 1; i <= totalInst; i++) {
      let instDate = new Date(date);
      instDate.setMonth(instDate.getMonth() + (i - 1));
      const formattedDate = instDate.toISOString().split('T')[0];

      let instDueDate = due_date ? new Date(due_date) : new Date(date);
      if (due_date) instDueDate.setMonth(instDueDate.getMonth() + (i - 1));
      const formattedDueDate = instDueDate.toISOString().split('T')[0];

      const desc = totalInst > 1 ? `${description} (${i}/${totalInst})` : description;
      const txStatus = status || (payment_method === 'cartao_credito' ? 'pending' : 'paid');

      const resInsert = await client.query(
        `INSERT INTO transactions 
         (family_id, account_id, category_id, credit_card_id, user_id, description, amount, type, date, due_date, payment_method, installment_current, installment_total, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [familyId, account_id || null, category_id || null, credit_card_id || null, userId, desc, installmentValue, type, formattedDate, formattedDueDate, payment_method || 'boleto', i, totalInst, txStatus]
      );

      if (txStatus === 'paid' && account_id && type === 'expense') {
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [installmentValue, account_id]);
      } else if (txStatus === 'paid' && account_id && type === 'income') {
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [installmentValue, account_id]);
      }
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Lançamento(s) criado(s) com sucesso!' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Erro ao salvar transação.' });
  } finally {
    client.release();
  }
});

// Cadastrar Cartão de Crédito
router.post('/api/credit-cards', authenticateToken, async (req: any, res: Response): Promise<any> => {
  const familyId = req.user.family_id;
  const { name, limit_amount, closing_day, due_day, color } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO credit_cards (family_id, name, limit_amount, closing_day, due_day, color) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [familyId, name, limit_amount, closing_day, due_day, color || '#6366f1']
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao cadastrar cartão.' });
  }
});

export default router;