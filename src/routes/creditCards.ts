import { Router, Request, Response } from 'express';
import { pool } from '../database';

const router = Router();

// GET /api/credit-cards?family_id=...
router.get('/', async (req: Request, res: Response): Promise<any> => {
  const { family_id } = req.query;

  if (!family_id) {
    return res.status(400).json({ error: 'family_id é obrigatório.' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM credit_cards WHERE family_id = $1 ORDER BY name ASC`,
      [family_id]
    );
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/credit-cards - Criar novo cartão
router.post('/', async (req: Request, res: Response): Promise<any> => {
  const {
    family_id,
    name,
    brand,
    total_limit,
    closing_day,
    due_day
  } = req.body;

  const parsedLimit = typeof total_limit === 'string'
    ? Number(total_limit.replace('.', '').replace(',', '.'))
    : Number(total_limit);

  if (!family_id || !name || !brand || isNaN(parsedLimit) || parsedLimit <= 0) {
    return res.status(400).json({ 
      error: 'family_id, name, brand e total_limit são obrigatórios.' 
    });
  }

  try {
    const query = `
      INSERT INTO credit_cards (
        family_id, name, brand, total_limit, closing_day, due_day
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;

    const values = [
      family_id,
      name,
      brand,
      parsedLimit,
      Number(closing_day) || 1,
      Number(due_day) || 10
    ];

    const result = await pool.query(query, values);
    return res.status(201).json(result.rows[0]);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/credit-cards/:id
router.delete('/:id', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM credit_cards WHERE id = $1', [id]);
    return res.json({ message: 'Cartão de crédito removido com sucesso!' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/credit-cards/:id/invoice?month=10&year=2026
router.get('/:id/invoice', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { month, year } = req.query;

  if (!month || !year) {
    return res.status(400).json({ error: 'month e year são obrigatórios.' });
  }

  try {
    const query = `
      SELECT 
        t.*,
        c.name as category_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.credit_card_id = $1
        AND EXTRACT(MONTH FROM t.due_date) = $2
        AND EXTRACT(YEAR FROM t.due_date) = $3
      ORDER BY t.transaction_date ASC, t.created_at ASC;
    `;

    const result = await pool.query(query, [id, Number(month), Number(year)]);
    const items = result.rows;
    const total = items.reduce((acc: number, item: any) => acc + Number(item.amount), 0);
    const isPaid = items.length > 0 && items.every((item: any) => item.status === 'PAID');

    return res.json({
      items,
      total,
      isPaid,
      count: items.length
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/credit-cards/:id/pay-invoice - Quitação da fatura em lote
router.post('/:id/pay-invoice', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { month, year, account_id, paid_amount, payment_date } = req.body;

  if (!month || !year) {
    return res.status(400).json({ error: 'month e year são obrigatórios.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const selectQuery = `
      SELECT id, amount 
      FROM transactions 
      WHERE credit_card_id = $1
        AND EXTRACT(MONTH FROM due_date) = $2
        AND EXTRACT(YEAR FROM due_date) = $3
        AND status != 'PAID';
    `;
    const pendingRes = await client.query(selectQuery, [id, Number(month), Number(year)]);

    if (pendingRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Não existem lançamentos pendentes nesta fatura.' });
    }

    const pDate = payment_date || new Date().toISOString().split('T')[0];
    const totalOriginal = pendingRes.rows.reduce((acc, row) => acc + Number(row.amount), 0);
    const finalPaid = paid_amount ? Number(paid_amount) : totalOriginal;
    const totalInterest = Math.max(0, finalPaid - totalOriginal);

    // Rateio proporcional dos juros entre as parcelas, se houver acréscimo
    for (const row of pendingRes.rows) {
      const rowShare = totalOriginal > 0 ? Number(row.amount) / totalOriginal : 0;
      const rowInterest = totalInterest * rowShare;
      const rowPaid = Number(row.amount) + rowInterest;

      await client.query(
        `UPDATE transactions
         SET status = 'PAID',
             account_id = $1,
             paid_amount = $2,
             interest_amount = $3,
             payment_date = $4
         WHERE id = $5`,
        [account_id || null, rowPaid, rowInterest, pDate, row.id]
      );
    }

    await client.query('COMMIT');
    return res.json({ 
      message: 'Fatura liquidada com sucesso!',
      settled_count: pendingRes.rows.length
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;