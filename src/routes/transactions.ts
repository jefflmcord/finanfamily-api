import { Router, Request, Response } from 'express';
import { pool } from '../database';

const router = Router();

// GET /api/transactions?family_id=...&month=10&year=2026
router.get('/', async (req: Request, res: Response): Promise<any> => {
  const { family_id, month, year } = req.query;

  if (!family_id) {
    return res.status(400).json({ error: 'family_id é obrigatório.' });
  }

  try {
    let query = `
      SELECT 
        t.id,
        t.family_id,
        t.account_id,
        t.credit_card_id,
        t.category_id,
        t.user_id,
        t.description,
        t.amount,
        t.paid_amount,
        t.interest_amount,
        t.reversal_reason,
        t.type,
        CASE 
          WHEN t.status = 'PAID' THEN 'PAID'
          WHEN t.due_date < CURRENT_DATE THEN 'OVERDUE'
          ELSE 'PENDING'
        END AS status,
        t.transaction_date,
        t.due_date,
        t.payment_date,
        t.installment_number,
        t.total_installments,
        t.parent_transaction_id,
        t.goal_id,
        c.name AS category_name,
        c.color AS category_color,
        a.name AS account_name,
        cc.name AS credit_card_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN credit_cards cc ON t.credit_card_id = cc.id
      WHERE t.family_id = $1
    `;

    const params: any[] = [String(family_id)];

    if (month && year) {
      params.push(Number(month), Number(year));
      query += ` AND EXTRACT(MONTH FROM t.due_date) = $2 AND EXTRACT(YEAR FROM t.due_date) = $3`;
    }

    query += ` ORDER BY t.due_date DESC, t.created_at DESC;`;

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions - Com virada inteligente de ciclo de fatura
router.post('/', async (req: Request, res: Response): Promise<any> => {
  const {
    family_id,
    account_id,
    credit_card_id,
    category_id,
    user_id,
    description,
    amount,
    installment_amount,
    transaction_date,
    due_date,
    type,
    status = 'PENDING',
    total_installments = 1,
    start_installment = 1,
    payment_method = 'CARD'
  } = req.body;

  if (!family_id || !description || !amount || !transaction_date || !due_date || !type) {
    return res.status(400).json({ 
      error: 'family_id, description, amount, transaction_date, due_date e type são obrigatórios.' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const totalInst = Math.max(1, Number(total_installments));
    const startInst = Math.max(1, Math.min(totalInst, Number(start_installment)));
    
    let instAmount = Number(installment_amount) || 0;
    if (instAmount <= 0) {
      instAmount = Math.round((Number(amount) / totalInst) * 100) / 100;
    }

    let cardDueDay: number | null = null;
    let cardClosingDay: number | null = null;

    if (credit_card_id && payment_method === 'CARD') {
      const cardRes = await client.query(
        'SELECT closing_day, due_day FROM credit_cards WHERE id = $1',
        [credit_card_id]
      );
      if (cardRes.rows.length > 0) {
        cardClosingDay = Number(cardRes.rows[0].closing_day);
        cardDueDay = Number(cardRes.rows[0].due_day);
      }
    }

    // Calcula a data de vencimento da parcela com virada automática de ciclo
    const computeDueDateForIndex = (offsetIndex: number): string => {
      const [txYearStr, txMonthStr, txDayStr] = transaction_date.split('-');
      const txDay = parseInt(txDayStr, 10);
      const txMonth = parseInt(txMonthStr, 10) - 1; // 0-based
      const txYear = parseInt(txYearStr, 10);

      if (credit_card_id && payment_method === 'CARD' && cardDueDay && cardClosingDay) {
        let initialMonthOffset = 0;

        // Se a data da compra for igual ou posterior ao fecho, empurra para o mês seguinte
        if (txDay >= cardClosingDay) {
          initialMonthOffset = 1;
        }

        // Se o dia de vencimento for numericamente menor que o fecho (ex: fecha dia 25, vence dia 5)
        if (cardDueDay < cardClosingDay && txDay < cardClosingDay) {
          initialMonthOffset = 1;
        } else if (cardDueDay < cardClosingDay && txDay >= cardClosingDay) {
          initialMonthOffset = 2;
        }

        const targetDate = new Date(txYear, txMonth + initialMonthOffset + offsetIndex, cardDueDay);
        const y = targetDate.getFullYear();
        const m = String(targetDate.getMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }

      // Para boletos, contas correntes e dinheiro: utiliza o due_date informado
      const [yearStr, monthStr, dayStr] = due_date.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10) - 1;
      const day = parseInt(dayStr, 10);

      const targetDate = new Date(year, month + offsetIndex, day);
      const y = targetDate.getFullYear();
      const m = String(targetDate.getMonth() + 1).padStart(2, '0');
      const d = String(targetDate.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };

    if (totalInst === 1) {
      const singleDueDate = computeDueDateForIndex(0);
      const query = `
        INSERT INTO transactions (
          family_id, account_id, credit_card_id, category_id, user_id,
          description, amount, type, status, transaction_date, due_date,
          installment_number, total_installments
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 1)
        RETURNING *;
      `;

      const values = [
        family_id,
        payment_method === 'BOLETO' || payment_method === 'CASH' ? null : (account_id || null),
        payment_method === 'CARD' ? (credit_card_id || null) : null,
        category_id || null,
        user_id || null,
        description,
        Number(amount),
        type,
        status,
        transaction_date,
        singleDueDate
      ];

      const result = await client.query(query, values);
      await client.query('COMMIT');

      return res.status(201).json({
        message: 'Lançamento criado com sucesso!',
        transaction: result.rows[0]
      });
    }

    let parentId: string | null = null;
    const createdTransactions = [];
    let offset = 0;

    for (let currentNumber = startInst; currentNumber <= totalInst; currentNumber++) {
      const currentDueDate = computeDueDateForIndex(offset);
      const installmentDescription = `${description} (${currentNumber}/${totalInst})`;

      const query = `
        INSERT INTO transactions (
          family_id, account_id, credit_card_id, category_id, user_id,
          description, amount, type, status, transaction_date, due_date,
          installment_number, total_installments, parent_transaction_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *;
      `;

      const values = [
        family_id,
        payment_method === 'BOLETO' || payment_method === 'CASH' ? null : (account_id || null),
        payment_method === 'CARD' ? (credit_card_id || null) : null,
        category_id || null,
        user_id || null,
        installmentDescription,
        instAmount,
        type,
        status,
        transaction_date,
        currentDueDate,
        currentNumber,
        totalInst,
        parentId
      ];

      const result = await client.query(query, values);
      const transactionCreated = result.rows[0];

      if (currentNumber === startInst) {
        parentId = transactionCreated.id;
      }

      createdTransactions.push(transactionCreated);
      offset++;
    }

    await client.query('COMMIT');

    return res.status(201).json({
      message: `Parcelamento (${startInst}/${totalInst} até ${totalInst}/${totalInst}) criado com sucesso!`,
      transactions: createdTransactions
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/transactions/:id - Editar lançamento
router.put('/:id', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { description, amount, due_date, category_id } = req.body;

  if (!description || amount === undefined || !due_date) {
    return res.status(400).json({ error: 'description, amount e due_date são obrigatórios.' });
  }

  try {
    const query = `
      UPDATE transactions
      SET 
        description = $1,
        amount = $2,
        due_date = $3,
        category_id = $4
      WHERE id = $5
      RETURNING *;
    `;

    const result = await pool.query(query, [
      description,
      Number(amount),
      due_date,
      category_id || null,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    return res.json({ message: 'Transação atualizada com sucesso!', transaction: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/transactions/:id - Excluir lançamento
router.delete('/:id', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { delete_all_installments } = req.query;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query('SELECT id, parent_transaction_id FROM transactions WHERE id = $1', [id]);
    if (txRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    const tx = txRes.rows[0];

    if (delete_all_installments === 'true') {
      const rootId = tx.parent_transaction_id || tx.id;
      await client.query(
        'DELETE FROM transactions WHERE id = $1 OR parent_transaction_id = $1',
        [rootId]
      );
    } else {
      await client.query('DELETE FROM transactions WHERE id = $1', [id]);
    }

    await client.query('COMMIT');
    return res.json({ message: 'Lançamento excluído com sucesso!' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/transactions/:id/pay - Liquidar com cálculo de juros/multas
router.patch('/:id/pay', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { account_id, payment_method, paid_amount, payment_date } = req.body || {};

  try {
    const currentTx = await pool.query('SELECT amount FROM transactions WHERE id = $1', [id]);
    if (currentTx.rows.length === 0) {
      return res.status(404).json({ error: 'Transação não encontrada.' });
    }

    const originalAmount = Number(currentTx.rows[0].amount);
    const finalPaidAmount = paid_amount ? Number(paid_amount) : originalAmount;
    const interest = Math.max(0, finalPaidAmount - originalAmount);
    const pDate = payment_date || new Date().toISOString().split('T')[0];

    let query = `
      UPDATE transactions 
      SET 
        status = 'PAID',
        paid_amount = $1,
        interest_amount = $2,
        payment_date = $3
    `;
    const params: any[] = [finalPaidAmount, interest, pDate];

    if (payment_method === 'CASH') {
      query += `, account_id = NULL`;
    } else if (account_id) {
      params.push(account_id);
      query += `, account_id = $${params.length}`;
    }

    params.push(id);
    query += ` WHERE id = $${params.length} RETURNING *;`;

    const result = await pool.query(query, params);

    return res.json({ 
      message: 'Transação liquidada com sucesso!', 
      transaction: result.rows[0] 
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/transactions/:id/reverse - Estornar pagamento com justificativa
router.patch('/:id/reverse', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;
  const { reason } = req.body || {};

  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'A justificativa do estorno é obrigatória.' });
  }

  try {
    const query = `
      UPDATE transactions
      SET 
        status = 'PENDING',
        paid_amount = NULL,
        interest_amount = 0.00,
        payment_date = NULL,
        reversal_reason = $1
      WHERE id = $2 AND status = 'PAID'
      RETURNING *;
    `;

    const result = await pool.query(query, [reason.trim(), id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transação não encontrada ou não está em estado de paga.' });
    }

    return res.json({
      message: 'Pagamento estornado com sucesso!',
      transaction: result.rows[0]
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;