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

// Função auxiliar para garantir que a categoria "Investimento" existe para a família
async function ensureInvestmentCategory(client: any, familyId: number) {
  let catRes = await client.query(
    `SELECT id FROM categories WHERE family_id = $1 AND LOWER(name) = 'investimento'`,
    [familyId]
  );
  if (catRes.rows.length > 0) {
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

// 2. GOOGLE OAUTH
router.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Token do Google não fornecido.' });

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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const familyRes = await client.query('INSERT INTO families (name) VALUES ($1) RETURNING id', [`Família de ${name || 'Utilizador'}`]);
        const familyId = familyRes.rows[0].id;

        await client.query('INSERT INTO accounts (family_id, name, balance) VALUES ($1, $2, $3)', [familyId, 'Conta Principal', 0]);
        await client.query('INSERT INTO categories (family_id, name, flow_type) VALUES ($1, $2, $3)', [familyId, 'Investimento', 'EXPENSE']);

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
      `SELECT id, name, balance FROM accounts WHERE family_id = $1 ORDER BY name ASC`,
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

// 7. METAS / OBJETIVOS
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

router.post('/api/goals', async (req: Request, res: Response): Promise<any> => {
  const { family_id, title, target_amount, months } = req.body;
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
router.put('/api/transactions/:id', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { description, amount, due_date, status, category_id, account_id, payment_method } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE transactions 
       SET description = $1, amount = $2, due_date = $3, status = $4, category_id = $5, account_id = $6, payment_method = $7 
       WHERE id = $8 RETURNING *`,
      [
        description, 
        amount, 
        due_date, 
        status, 
        category_id || null, 
        payment_method === 'CARD' ? null : (account_id || null), 
        payment_method || 'BOLETO',
        id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Transação não encontrada.' });
    return res.json({ message: 'Transação atualizada.', transaction: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// --- APAGAR TRANSAÇÃO (COM LÓGICA DE PARCELAS) ---
router.patch('/api/transactions/:id/pay', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { account_id, paid_amount } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const transactionResult = await client.query(
      'SELECT id, family_id, amount, type, status, account_id FROM transactions WHERE id = $1 FOR UPDATE',
      [id]
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
    if (!Number.isFinite(finalAmount) || finalAmount < Number(transaction.amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'O valor pago precisa cobrir o valor total do lançamento.' });
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
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [balanceChange, accountId]);

    const updatedTransaction = await client.query(
      "UPDATE transactions SET status = 'PAID', account_id = $2 WHERE id = $1 RETURNING *",
      [id, accountId]
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

router.delete('/api/transactions/:id', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { scope, parent_id } = req.query; // scope pode ser 'single' (apenas esta) ou 'all' (todas da série)

  try {
    if (scope === 'all' && parent_id && parent_id !== 'null') {
      // Apaga a transação original (pai) e todas as suas parcelas filhas
      await pool.query(
        `DELETE FROM transactions WHERE id = $1 OR parent_transaction_id = $1 OR id = $2 OR parent_transaction_id = $2`,
        [parent_id, id]
      );
    } else {
      // Apaga apenas esta transação isolada
      await pool.query(`DELETE FROM transactions WHERE id = $1`, [id]);
    }
    return res.json({ message: 'Transação apagada com sucesso.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
export default router;