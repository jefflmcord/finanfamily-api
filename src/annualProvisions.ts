import { Router, Request, Response } from 'express';
import { pool } from './database';
import { requireFamilyPermission } from './accessControl';

const router = Router();

const EXPENSE_TYPES = ['IPTU', 'IPVA', 'LICENCIAMENTO', 'OTHER'] as const;
type ExpenseType = typeof EXPENSE_TYPES[number];

function isExpenseType(value: unknown): value is ExpenseType {
  return typeof value === 'string' && EXPENSE_TYPES.includes(value as ExpenseType);
}

function parseAmount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 9_999_999_999.99) return null;
  const roundedAmount = Math.round(amount * 100) / 100;
  return roundedAmount > 0 ? roundedAmount : null;
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addYearsToDate(dateValue: string, years: number): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

function validateProvisionInput(body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const targetAmount = parseAmount(body.target_amount);

  if (!title || title.length > 120) {
    return { error: 'Informe uma descrição de até 120 caracteres.' } as const;
  }
  if (!isExpenseType(body.expense_type)) {
    return { error: 'Selecione um tipo de despesa anual válido.' } as const;
  }
  if (targetAmount === null) {
    return { error: 'Informe um valor estimado maior que zero.' } as const;
  }
  if (!isValidDate(body.due_date)) {
    return { error: 'Informe uma data de vencimento válida.' } as const;
  }

  return {
    value: {
      title,
      expenseType: body.expense_type,
      targetAmount,
      dueDate: body.due_date,
    },
  } as const;
}

router.get(
  '/',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await pool.query(
        `SELECT p.id, p.title, p.expense_type, p.target_amount, p.saved_amount,
                TO_CHAR(p.due_date, 'YYYY-MM-DD') AS due_date, p.status,
                p.actual_amount, TO_CHAR(p.paid_date, 'YYYY-MM-DD') AS paid_date,
                p.renewed_from_id, child.id AS renewed_provision_id, p.created_at,
                COALESCE(
                  JSON_AGG(
                    JSON_BUILD_OBJECT(
                      'id', c.id,
                      'amount', c.amount,
                      'contribution_date', TO_CHAR(c.contribution_date, 'YYYY-MM-DD'),
                      'created_at', c.created_at
                    ) ORDER BY c.contribution_date DESC, c.id DESC
                  ) FILTER (WHERE c.id IS NOT NULL),
                  '[]'::json
                ) AS contributions
         FROM annual_provisions p
         LEFT JOIN annual_provisions child ON child.renewed_from_id = p.id
         LEFT JOIN annual_provision_contributions c ON c.provision_id = p.id
         WHERE p.family_id = $1
         GROUP BY p.id, child.id
         ORDER BY p.status ASC, p.due_date ASC, p.created_at DESC`,
        [req.familyAccess!.familyId]
      );
      return res.json(result.rows);
    } catch (error) {
      console.error('Erro ao carregar provisões anuais:', error);
      return res.status(500).json({ error: 'Não foi possível carregar as provisões anuais.' });
    }
  }
);

router.post(
  '/',
  requireFamilyPermission('provisions_manage'),
  async (req: Request, res: Response): Promise<any> => {
    const validation = validateProvisionInput(req.body ?? {});
    if ('error' in validation) return res.status(400).json({ error: validation.error });

    try {
      const result = await pool.query(
        `INSERT INTO annual_provisions
           (family_id, title, expense_type, target_amount, due_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, paid_date, renewed_from_id, created_at`,
        [
          req.familyAccess!.familyId,
          validation.value.title,
          validation.value.expenseType,
          validation.value.targetAmount,
          validation.value.dueDate,
        ]
      );
      return res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Erro ao criar provisão anual:', error);
      return res.status(500).json({ error: 'Não foi possível criar a provisão anual.' });
    }
  }
);

router.put(
  '/:id',
  requireFamilyPermission('provisions_manage'),
  async (req: Request, res: Response): Promise<any> => {
    const validation = validateProvisionInput(req.body ?? {});
    if ('error' in validation) return res.status(400).json({ error: validation.error });

    try {
      const result = await pool.query(
        `UPDATE annual_provisions
         SET title = $1, expense_type = $2, target_amount = $3, due_date = $4,
             updated_at = NOW()
         WHERE id = $5 AND family_id = $6 AND status = 'ACTIVE'
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, paid_date, renewed_from_id, created_at`,
        [
          validation.value.title,
          validation.value.expenseType,
          validation.value.targetAmount,
          validation.value.dueDate,
          req.params.id,
          req.familyAccess!.familyId,
        ]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Provisão ativa não encontrada.' });
      }
      return res.json(result.rows[0]);
    } catch (error) {
      console.error('Erro ao atualizar provisão anual:', error);
      return res.status(500).json({ error: 'Não foi possível atualizar a provisão anual.' });
    }
  }
);

router.post(
  '/:id/contributions',
  requireFamilyPermission('provisions_manage'),
  async (req: Request, res: Response): Promise<any> => {
    const amount = parseAmount(req.body?.amount);
    const contributionDate = req.body?.contribution_date;
    if (amount === null) {
      return res.status(400).json({ error: 'Informe um valor reservado maior que zero.' });
    }
    if (!isValidDate(contributionDate)) {
      return res.status(400).json({ error: 'Informe uma data válida para a reserva.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const provision = await client.query(
        `SELECT id FROM annual_provisions
         WHERE id = $1 AND family_id = $2 AND status = 'ACTIVE'
         FOR UPDATE`,
        [req.params.id, req.familyAccess!.familyId]
      );
      if (provision.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Provisão ativa não encontrada.' });
      }

      const contribution = await client.query(
        `INSERT INTO annual_provision_contributions
           (provision_id, family_id, amount, contribution_date, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, amount, TO_CHAR(contribution_date, 'YYYY-MM-DD') AS contribution_date`,
        [
          provision.rows[0].id,
          req.familyAccess!.familyId,
          amount,
          contributionDate,
          req.familyAccess!.userId,
        ]
      );
      await client.query(
        `UPDATE annual_provisions
         SET saved_amount = saved_amount + $1, updated_at = NOW()
         WHERE id = $2 AND family_id = $3`,
        [amount, provision.rows[0].id, req.familyAccess!.familyId]
      );
      await client.query('COMMIT');
      return res.status(201).json(contribution.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao registrar valor reservado:', error);
      return res.status(500).json({ error: 'Não foi possível registrar o valor reservado.' });
    } finally {
      client.release();
    }
  }
);

router.delete(
  '/:id/contributions/:contributionId',
  requireFamilyPermission('provisions_manage'),
  async (req: Request, res: Response): Promise<any> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const provision = await client.query(
        `SELECT id FROM annual_provisions
         WHERE id = $1 AND family_id = $2 AND status = 'ACTIVE'
         FOR UPDATE`,
        [req.params.id, req.familyAccess!.familyId]
      );
      if (provision.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Provisão ativa não encontrada.' });
      }

      const deleted = await client.query(
        `DELETE FROM annual_provision_contributions
         WHERE id = $1 AND provision_id = $2 AND family_id = $3
         RETURNING id, amount`,
        [req.params.contributionId, req.params.id, req.familyAccess!.familyId]
      );
      if (deleted.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Registro de reserva não encontrado.' });
      }

      await client.query(
        `UPDATE annual_provisions
         SET saved_amount = GREATEST(0, saved_amount - $1), updated_at = NOW()
         WHERE id = $2 AND family_id = $3`,
        [deleted.rows[0].amount, req.params.id, req.familyAccess!.familyId]
      );
      await client.query('COMMIT');
      return res.json({ message: 'Reserva removida com sucesso.' });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao remover valor reservado:', error);
      return res.status(500).json({ error: 'Não foi possível remover o valor reservado.' });
    } finally {
      client.release();
    }
  }
);

router.delete(
  '/:id',
  requireFamilyPermission('provisions_manage'),
  async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await pool.query(
        `DELETE FROM annual_provisions
         WHERE id = $1 AND family_id = $2
         RETURNING id`,
        [req.params.id, req.familyAccess!.familyId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Provisão não encontrada.' });
      }
      return res.json({ message: 'Provisão excluída com sucesso.' });
    } catch (error) {
      console.error('Erro ao excluir provisão anual:', error);
      return res.status(500).json({ error: 'Não foi possível excluir a provisão anual.' });
    }
  }
);

router.post(
  '/:id/settle',
  requireFamilyPermission('provisions_manage'),
  async (req: Request, res: Response): Promise<any> => {
    const actualAmount = parseAmount(req.body?.actual_amount);
    const paidDate = req.body?.paid_date ?? new Date().toISOString().slice(0, 10);
    if (actualAmount === null) {
      return res.status(400).json({ error: 'Informe o valor efetivamente pago, maior que zero.' });
    }
    if (!isValidDate(paidDate)) {
      return res.status(400).json({ error: 'Informe uma data válida para o pagamento.' });
    }

    try {
      const result = await pool.query(
        `UPDATE annual_provisions
         SET status = 'PAID', actual_amount = $1, paid_date = $2, updated_at = NOW()
         WHERE id = $3 AND family_id = $4 AND status = 'ACTIVE'
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, TO_CHAR(paid_date, 'YYYY-MM-DD') AS paid_date,
                   renewed_from_id, created_at`,
        [actualAmount, paidDate, req.params.id, req.familyAccess!.familyId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Provisão ativa não encontrada.' });
      }
      return res.json(result.rows[0]);
    } catch (error) {
      console.error('Erro ao concluir provisão anual:', error);
      return res.status(500).json({ error: 'Não foi possível concluir a provisão anual.' });
    }
  }
);

router.post(
  '/:id/renew',
  requireFamilyPermission('provisions_manage'),
  async (req: Request, res: Response): Promise<any> => {
    const customTargetAmount =
      req.body?.target_amount !== undefined && req.body?.target_amount !== null && req.body?.target_amount !== ''
        ? parseAmount(req.body.target_amount)
        : undefined;
    if (customTargetAmount === null) {
      return res.status(400).json({ error: 'Informe um valor estimado válido maior que zero para a renovação.' });
    }
    const customDueDate =
      req.body?.due_date !== undefined && req.body?.due_date !== null && req.body?.due_date !== ''
        ? req.body.due_date
        : undefined;
    if (customDueDate !== undefined && !isValidDate(customDueDate)) {
      return res.status(400).json({ error: 'Informe uma data de vencimento válida para a renovação.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sourceResult = await client.query(
        `SELECT id, family_id, title, expense_type, target_amount, actual_amount,
                TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status
         FROM annual_provisions
         WHERE id = $1 AND family_id = $2
         FOR UPDATE`,
        [req.params.id, req.familyAccess!.familyId]
      );
      const source = sourceResult.rows[0];
      if (!source) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Provisão não encontrada.' });
      }
      if (source.status !== 'PAID') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Conclua o pagamento antes de renovar a provisão.' });
      }

      const existingRenewal = await client.query(
        `SELECT id FROM annual_provisions WHERE renewed_from_id = $1`,
        [source.id]
      );
      if (existingRenewal.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Esta provisão já foi renovada.' });
      }

      let dueDate = customDueDate ?? addYearsToDate(source.due_date, 1);
      if (customDueDate === undefined) {
        const today = new Date().toISOString().slice(0, 10);
        while (dueDate <= today) dueDate = addYearsToDate(dueDate, 1);
      }
      const nextTargetAmount = customTargetAmount ?? source.actual_amount ?? source.target_amount;

      const renewal = await client.query(
        `INSERT INTO annual_provisions
           (family_id, title, expense_type, target_amount, due_date, renewed_from_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, paid_date, renewed_from_id, created_at`,
        [
          source.family_id,
          source.title,
          source.expense_type,
          nextTargetAmount,
          dueDate,
          source.id,
        ]
      );
      await client.query('COMMIT');
      return res.status(201).json(renewal.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao renovar provisão anual:', error);
      return res.status(500).json({ error: 'Não foi possível renovar a provisão anual.' });
    } finally {
      client.release();
    }
  }
);

export default router;
