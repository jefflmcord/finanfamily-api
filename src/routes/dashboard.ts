import { Router, Request, Response } from 'express';
import { pool } from '../database';

const router = Router();

// GET /api/dashboard/summary?family_id=...&month=10&year=2026
router.get('/summary', async (req: Request, res: Response): Promise<any> => {
  const { family_id, month, year } = req.query;

  if (!family_id || !month || !year) {
    return res.status(400).json({ error: 'family_id, month e year são obrigatórios.' });
  }

  try {
    const m = Number(month);
    const y = Number(year);

    // 1. Totalizadores de Receitas, Despesas e Juros Pagos
    const summaryQuery = `
      SELECT 
        COALESCE(SUM(CASE WHEN t.type = 'INCOME' AND t.status = 'PAID' THEN COALESCE(t.paid_amount, t.amount) ELSE 0 END), 0) AS income_received,
        COALESCE(SUM(CASE WHEN t.type = 'INCOME' THEN t.amount ELSE 0 END), 0) AS income_projected,
        COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' AND c.type = 'FIXED' THEN t.amount ELSE 0 END), 0) AS expenses_fixed,
        COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' AND (c.type = 'VARIABLE' OR c.type IS NULL) THEN t.amount ELSE 0 END), 0) AS expenses_variable,
        COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' AND t.status = 'PAID' THEN COALESCE(t.paid_amount, t.amount) ELSE 0 END), 0) AS expenses_paid,
        COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount ELSE 0 END), 0) AS expenses_total,
        COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' AND c.name = 'Investimentos' THEN t.amount ELSE 0 END), 0) AS investments_total,
        COALESCE(SUM(CASE WHEN t.type = 'EXPENSE' AND t.status = 'PAID' THEN t.interest_amount ELSE 0 END), 0) AS total_interest_paid,
        COUNT(CASE WHEN t.type = 'EXPENSE' AND t.status = 'PAID' AND t.interest_amount > 0 THEN 1 END) AS overdue_paid_count
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.family_id = $1
        AND EXTRACT(MONTH FROM t.due_date) = $2
        AND EXTRACT(YEAR FROM t.due_date) = $3;
    `;

    const summaryRes = await pool.query(summaryQuery, [family_id, m, y]);
    const row = summaryRes.rows[0];

    const incomeReceived = Number(row.income_received);
    const incomeProjected = Number(row.income_projected);
    const expensesFixed = Number(row.expenses_fixed);
    const expensesVariable = Number(row.expenses_variable);
    const expensesPaid = Number(row.expenses_paid);
    const expensesTotal = Number(row.expenses_total);
    const investmentsTotal = Number(row.investments_total);
    const totalInterestPaid = Number(row.total_interest_paid);
    const overduePaidCount = Number(row.overdue_paid_count);

    const projectedBalance = incomeProjected - expensesTotal;

    // 2. Gastos por Categoria (Donut / Pizza)
    const categoryQuery = `
      SELECT 
        COALESCE(c.name, 'Outros') AS name,
        COALESCE(c.color, '#64748b') AS color,
        SUM(COALESCE(t.paid_amount, t.amount))::numeric(15,2) AS total
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.family_id = $1
        AND t.type = 'EXPENSE'
        AND EXTRACT(MONTH FROM t.due_date) = $2
        AND EXTRACT(YEAR FROM t.due_date) = $3
      GROUP BY c.name, c.color
      ORDER BY total DESC;
    `;

    const categoryRes = await pool.query(categoryQuery, [family_id, m, y]);

    return res.json({
      month: m,
      year: y,
      income: {
        received: incomeReceived,
        projected: incomeProjected
      },
      expenses: {
        fixed: expensesFixed,
        variable: expensesVariable,
        paidSoFar: expensesPaid,
        totalProjected: expensesTotal,
        investments: investmentsTotal
      },
      interest: {
        totalPaid: totalInterestPaid,
        count: overduePaidCount
      },
      projectedBalance,
      categoriesDistribution: categoryRes.rows.map((cat: any) => ({
        name: cat.name,
        color: cat.color,
        total: Number(cat.total)
      }))
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/interest-metrics?family_id=...&month=10&year=2026
router.get('/interest-metrics', async (req: Request, res: Response): Promise<any> => {
  const { family_id, month, year } = req.query;

  if (!family_id || !month || !year) {
    return res.status(400).json({ error: 'family_id, month e year são obrigatórios.' });
  }

  try {
    const query = `
      SELECT 
        t.id,
        t.description,
        t.amount AS original_amount,
        t.paid_amount,
        t.interest_amount,
        t.due_date,
        t.payment_date,
        c.name AS category_name,
        a.name AS account_name,
        cc.name AS credit_card_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN credit_cards cc ON t.credit_card_id = cc.id
      WHERE t.family_id = $1
        AND t.status = 'PAID'
        AND t.interest_amount > 0
        AND EXTRACT(MONTH FROM t.due_date) = $2
        AND EXTRACT(YEAR FROM t.due_date) = $3
      ORDER BY t.interest_amount DESC;
    `;

    const result = await pool.query(query, [family_id, Number(month), Number(year)]);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;