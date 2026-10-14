"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../database");
const router = (0, express_1.Router)();
// GET /api/goals?family_id=...
router.get('/', async (req, res) => {
    const { family_id } = req.query;
    if (!family_id) {
        return res.status(400).json({ error: 'family_id é obrigatório.' });
    }
    try {
        const query = `
      SELECT 
        g.*,
        a_target.name AS target_account_name
      FROM goals g
      LEFT JOIN accounts a_target ON g.target_account_id = a_target.id
      WHERE g.family_id = $1 
      ORDER BY g.created_at DESC;
    `;
        const result = await database_1.pool.query(query, [family_id]);
        return res.json(result.rows);
    }
    catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
// POST /api/goals - Criar Objetivo e vincular parcelas via goal_id
router.post('/', async (req, res) => {
    const { family_id, title, target_amount, monthly_contribution, target_months, start_date, account_id, target_account_id } = req.body;
    if (!family_id || !title || !target_amount) {
        return res.status(400).json({ error: 'family_id, title e target_amount são obrigatórios.' });
    }
    const client = await database_1.pool.connect();
    try {
        await client.query('BEGIN');
        const totalMonths = Math.max(1, Number(target_months) || 1);
        const monthlyVal = Number(monthly_contribution) || (Number(target_amount) / totalMonths);
        const baseDate = start_date ? new Date(start_date) : new Date();
        const targetDate = new Date(baseDate);
        targetDate.setUTCMonth(targetDate.getUTCMonth() + totalMonths);
        // 1. Inserir Objetivo
        const goalInsertQuery = `
      INSERT INTO goals (
        family_id, title, target_amount, current_amount, 
        monthly_contribution, target_months, start_date, target_date,
        target_account_id
      ) VALUES ($1, $2, $3, 0.00, $4, $5, $6, $7, $8)
      RETURNING *;
    `;
        const goalRes = await client.query(goalInsertQuery, [
            family_id,
            title,
            Number(target_amount),
            monthlyVal,
            totalMonths,
            baseDate.toISOString().split('T')[0],
            targetDate.toISOString().split('T')[0],
            target_account_id || null
        ]);
        const createdGoal = goalRes.rows[0];
        // 2. Garantir a existência da categoria "Investimentos"
        let categoryId = null;
        const catRes = await client.query(`SELECT id FROM categories WHERE family_id = $1 AND name = 'Investimentos' LIMIT 1`, [family_id]);
        if (catRes.rows.length > 0) {
            categoryId = catRes.rows[0].id;
        }
        else {
            const newCatRes = await client.query(`INSERT INTO categories (family_id, name, type, color) 
         VALUES ($1, 'Investimentos', 'VARIABLE', '#10b981') 
         RETURNING id`, [family_id]);
            categoryId = newCatRes.rows[0].id;
        }
        // 3. Gerar os lançamentos em Contas a Pagar com o goal_id associado
        let parentId = null;
        for (let i = 1; i <= totalMonths; i++) {
            const currentDueDate = new Date(baseDate);
            currentDueDate.setUTCMonth(currentDueDate.getUTCMonth() + (i - 1));
            const desc = `Investimento: ${title} (${i}/${totalMonths})`;
            const txQuery = `
        INSERT INTO transactions (
          family_id, account_id, credit_card_id, category_id,
          description, amount, type, status, transaction_date, due_date,
          installment_number, total_installments, parent_transaction_id, goal_id
        ) VALUES ($1, $2, NULL, $3, $4, $5, 'EXPENSE', 'PENDING', $6, $7, $8, $9, $10, $11)
        RETURNING id;
      `;
            const txRes = await client.query(txQuery, [
                family_id,
                account_id || null,
                categoryId,
                desc,
                monthlyVal,
                baseDate.toISOString().split('T')[0],
                currentDueDate.toISOString().split('T')[0],
                i,
                totalMonths,
                parentId,
                createdGoal.id
            ]);
            if (i === 1) {
                parentId = txRes.rows[0].id;
            }
        }
        await client.query('COMMIT');
        return res.status(201).json({
            message: 'Objetivo de investimento criado e provisionado!',
            goal: createdGoal
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: err.message });
    }
    finally {
        client.release();
    }
});
// POST /api/goals/:id/contribution - Registar Aporte Avulso
router.post('/:id/contribution', async (req, res) => {
    const { id } = req.params;
    const { family_id, amount, account_id, payment_date } = req.body;
    if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ error: 'O valor do aporte deve ser superior a zero.' });
    }
    const client = await database_1.pool.connect();
    try {
        await client.query('BEGIN');
        const goalRes = await client.query(`SELECT * FROM goals WHERE id = $1`, [id]);
        if (goalRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Objetivo não encontrado.' });
        }
        const goal = goalRes.rows[0];
        const contributionVal = Number(amount);
        const newCurrentAmount = Number(goal.current_amount) + contributionVal;
        const isCompleted = newCurrentAmount >= Number(goal.target_amount);
        await client.query(`UPDATE goals 
       SET current_amount = $1, 
           status = CASE WHEN $2 = true THEN 'COMPLETED' ELSE status END,
           updated_at = NOW() 
       WHERE id = $3`, [newCurrentAmount, isCompleted, id]);
        let categoryId = null;
        const catRes = await client.query(`SELECT id FROM categories WHERE family_id = $1 AND name = 'Investimentos' LIMIT 1`, [goal.family_id]);
        if (catRes.rows.length > 0)
            categoryId = catRes.rows[0].id;
        const pDate = payment_date || new Date().toISOString().split('T')[0];
        await client.query(`INSERT INTO transactions (
        family_id, account_id, category_id, description,
        amount, type, status, transaction_date, due_date,
        installment_number, total_installments, goal_id
      ) VALUES ($1, $2, $3, $4, $5, 'EXPENSE', 'PAID', $6, $6, 1, 1, $7)`, [
            goal.family_id,
            account_id || null,
            categoryId,
            `Aporte Avulso: ${goal.title}`,
            contributionVal,
            pDate,
            id
        ]);
        await client.query('COMMIT');
        return res.json({
            message: 'Aporte realizado com sucesso!',
            current_amount: newCurrentAmount
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: err.message });
    }
    finally {
        client.release();
    }
});
// DELETE /api/goals/:id - Excluir objetivo e remover parcelas pendentes vinculadas
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const client = await database_1.pool.connect();
    try {
        await client.query('BEGIN');
        // 1. Obter informações do objetivo para fallback de descrição
        const goalRes = await client.query(`SELECT title FROM goals WHERE id = $1`, [id]);
        const goalTitle = goalRes.rows[0]?.title;
        // 2. Remover as parcelas do Contas a Pagar ainda em aberto (não pagas)
        // Busca tanto pelo goal_id quanto pelo padrão da descrição caso sejam metas antigas
        if (goalTitle) {
            await client.query(`DELETE FROM transactions 
         WHERE (goal_id = $1 OR description LIKE $2)
           AND status != 'PAID'`, [id, `Investimento: ${goalTitle}%`]);
        }
        else {
            await client.query(`DELETE FROM transactions 
         WHERE goal_id = $1 AND status != 'PAID'`, [id]);
        }
        // 3. Excluir o registro do objetivo
        await client.query(`DELETE FROM goals WHERE id = $1`, [id]);
        await client.query('COMMIT');
        return res.json({
            message: 'Objetivo e parcelas em aberto de Contas a Pagar foram excluídos com sucesso!'
        });
    }
    catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: err.message });
    }
    finally {
        client.release();
    }
});
exports.default = router;
