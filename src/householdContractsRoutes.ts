import { Router, Request, Response } from 'express';
import { pool } from './database';
import { requireFamilyPermission } from './accessControl';

const router = Router();

export const CONTRACT_GROUPS = [
  'Streaming & Digital',
  'Internet & Telefonia',
  'Moradia & Utilidades',
  'Saúde & Bem-Estar',
  'Educação & Cursos',
  'Seguros & Proteção',
  'Clubes & Outros',
] as const;

export const WARRANTY_CATEGORIES = [
  'Cozinha & Eletros',
  'Lavanderia & Limpeza',
  'Sala, TV & Áudio',
  'Celulares & Informática',
  'Climatização & Casa',
  'Ferramentas & Outros',
] as const;

function addMonthsToDateStr(dateStr: string, monthsToAdd: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + monthsToAdd, 1));
  const maxDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, maxDay));
  return target.toISOString().slice(0, 10);
}

// 1. LISTAR TODOS OS CONTRATOS/ASSINATURAS E GARANTIAS DA FAMÍLIA
router.get(
  '/overview',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      const [contractsRes, warrantiesRes] = await Promise.all([
        pool.query(
          `SELECT id, family_id, title, provider, contract_group, billing_cycle,
                  amount, billing_day, TO_CHAR(renewal_date, 'YYYY-MM-DD') AS renewal_date,
                  payment_method, credit_card_id, account_id, status,
                  cancellation_url, support_phone, notes, created_at, updated_at
           FROM household_contracts
           WHERE family_id = $1
           ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 WHEN status = 'PAUSED' THEN 1 ELSE 2 END,
                    billing_day ASC, title ASC`,
          [familyId]
        ),
        pool.query(
          `SELECT id, family_id, product_name, brand_model, room_category, store_name,
                  TO_CHAR(purchase_date, 'YYYY-MM-DD') AS purchase_date,
                  purchase_amount, warranty_months, extended_warranty_months,
                  TO_CHAR(warranty_expires_at, 'YYYY-MM-DD') AS warranty_expires_at,
                  invoice_number, serial_number, support_contact, notes, created_at
           FROM household_warranties
           WHERE family_id = $1
           ORDER BY warranty_expires_at ASC, product_name ASC`,
          [familyId]
        ),
      ]);

      return res.json({
        contracts: contractsRes.rows.map(r => ({
          ...r,
          amount: Number(r.amount || 0),
          billing_day: Number(r.billing_day || 10),
        })),
        warranties: warrantiesRes.rows.map(w => ({
          ...w,
          purchase_amount: Number(w.purchase_amount || 0),
          warranty_months: Number(w.warranty_months || 12),
          extended_warranty_months: Number(w.extended_warranty_months || 0),
        })),
      });
    } catch (error) {
      console.error('Erro ao carregar contratos e garantias:', error);
      return res.status(500).json({ error: 'Não foi possível carregar contratos e garantias.' });
    }
  }
);

// 2. CRIAR CONTRATO / ASSINATURA RECORRENTE
router.post(
  '/contracts',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const {
      title,
      provider,
      contract_group = 'Streaming & Digital',
      billing_cycle = 'MONTHLY',
      amount,
      billing_day = 10,
      renewal_date,
      payment_method = 'CARD',
      credit_card_id,
      account_id,
      support_phone,
      notes,
    } = req.body ?? {};

    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    const parsedAmount = Number(amount);
    if (!cleanTitle || !Number.isFinite(parsedAmount) || parsedAmount < 0) {
      return res.status(400).json({ error: 'Informe um nome e valor válidos para o contrato/assinatura.' });
    }

    const safeDay = Math.min(31, Math.max(1, Number(billing_day) || 10));
    const safeCycle = billing_cycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';
    const safeRenewal =
      typeof renewal_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(renewal_date)
        ? renewal_date
        : null;

    try {
      const inserted = await pool.query(
        `INSERT INTO household_contracts (
           family_id, title, provider, contract_group, billing_cycle,
           amount, billing_day, renewal_date, payment_method,
           credit_card_id, account_id, status, support_phone, notes
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ACTIVE', $12, $13)
         RETURNING id, family_id, title, provider, contract_group, billing_cycle,
                   amount, billing_day, TO_CHAR(renewal_date, 'YYYY-MM-DD') AS renewal_date,
                   payment_method, credit_card_id, account_id, status, support_phone, notes`,
        [
          familyId,
          cleanTitle.slice(0, 140),
          typeof provider === 'string' && provider.trim() ? provider.trim().slice(0, 120) : null,
          typeof contract_group === 'string' && contract_group.trim()
            ? contract_group.trim().slice(0, 60)
            : 'Streaming & Digital',
          safeCycle,
          Math.round(parsedAmount * 100) / 100,
          safeDay,
          safeRenewal,
          typeof payment_method === 'string' ? payment_method : 'CARD',
          credit_card_id ? String(credit_card_id) : null,
          account_id ? String(account_id) : null,
          typeof support_phone === 'string' && support_phone.trim()
            ? support_phone.trim().slice(0, 60)
            : null,
          typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 300) : null,
        ]
      );
      return res.status(201).json(inserted.rows[0]);
    } catch (error) {
      console.error('Erro ao criar contrato/assinatura:', error);
      return res.status(500).json({ error: 'Não foi possível cadastrar o contrato/assinatura.' });
    }
  }
);

// 3. ATUALIZAR CONTRATO / STATUS (PAUSAR, CANCELAR, EDITAR VALOR)
router.put(
  '/contracts/:id',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const contractId = req.params.id;
    const {
      title,
      provider,
      contract_group,
      billing_cycle,
      amount,
      billing_day,
      renewal_date,
      status,
      support_phone,
      notes,
    } = req.body ?? {};

    try {
      const currentRes = await pool.query(
        'SELECT * FROM household_contracts WHERE id = $1 AND family_id = $2',
        [contractId, familyId]
      );
      if (currentRes.rows.length === 0) {
        return res.status(404).json({ error: 'Contrato/assinatura não encontrado.' });
      }
      const cur = currentRes.rows[0];

      const nextStatus =
        status === 'ACTIVE' || status === 'PAUSED' || status === 'CANCELED' ? status : cur.status;
      const nextAmount =
        amount !== undefined ? Math.max(0, Number(amount) || 0) : Number(cur.amount);
      const nextDay =
        billing_day !== undefined
          ? Math.min(31, Math.max(1, Number(billing_day) || 10))
          : Number(cur.billing_day);
      const nextRenewal =
        renewal_date !== undefined
          ? typeof renewal_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(renewal_date)
            ? renewal_date
            : null
          : cur.renewal_date;

      const updated = await pool.query(
        `UPDATE household_contracts
         SET title = $1,
             provider = $2,
             contract_group = $3,
             billing_cycle = $4,
             amount = $5,
             billing_day = $6,
             renewal_date = $7,
             status = $8,
             support_phone = $9,
             notes = $10,
             updated_at = NOW()
         WHERE id = $11 AND family_id = $12
         RETURNING id, family_id, title, provider, contract_group, billing_cycle,
                   amount, billing_day, TO_CHAR(renewal_date, 'YYYY-MM-DD') AS renewal_date,
                   payment_method, credit_card_id, account_id, status, support_phone, notes`,
        [
          typeof title === 'string' && title.trim() ? title.trim().slice(0, 140) : cur.title,
          provider !== undefined
            ? typeof provider === 'string' && provider.trim()
              ? provider.trim().slice(0, 120)
              : null
            : cur.provider,
          typeof contract_group === 'string' && contract_group.trim()
            ? contract_group.trim()
            : cur.contract_group,
          billing_cycle === 'ANNUAL' || billing_cycle === 'MONTHLY'
            ? billing_cycle
            : cur.billing_cycle,
          nextAmount,
          nextDay,
          nextRenewal,
          nextStatus,
          support_phone !== undefined
            ? typeof support_phone === 'string' && support_phone.trim()
              ? support_phone.trim().slice(0, 60)
              : null
            : cur.support_phone,
          notes !== undefined
            ? typeof notes === 'string' && notes.trim()
              ? notes.trim().slice(0, 300)
              : null
            : cur.notes,
          contractId,
          familyId,
        ]
      );
      return res.json(updated.rows[0]);
    } catch (error) {
      console.error('Erro ao atualizar contrato:', error);
      return res.status(500).json({ error: 'Não foi possível atualizar o contrato.' });
    }
  }
);

// 4. EXCLUIR CONTRATO / ASSINATURA
router.delete(
  '/contracts/:id',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      await pool.query('DELETE FROM household_contracts WHERE id = $1 AND family_id = $2', [
        req.params.id,
        familyId,
      ]);
      return res.json({ message: 'Assinatura/contrato removido.' });
    } catch (error) {
      console.error('Erro ao remover contrato:', error);
      return res.status(500).json({ error: 'Não foi possível remover o contrato.' });
    }
  }
);

// 5. GERAR LANÇAMENTO NO FINANCEIRO A PARTIR DO CONTRATO/ASSINATURA (1 MÊS OU N MESES)
router.post(
  '/contracts/:id/launch-financial',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const contractId = req.params.id;
    const {
      months = 1,
      payment_target = 'ACCOUNT',
      account_id,
      credit_card_id,
      category_id,
    } = req.body ?? {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const contractRes = await client.query(
        'SELECT * FROM household_contracts WHERE id = $1 AND family_id = $2',
        [contractId, familyId]
      );
      if (contractRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Contrato/assinatura não encontrado.' });
      }
      const contract = contractRes.rows[0];
      const amount = Number(contract.amount || 0);
      if (amount <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'O contrato precisa ter valor maior que zero.' });
      }

      let resolvedCategoryId = category_id ? String(category_id) : null;
      if (!resolvedCategoryId) {
        const catRes = await client.query(
          `SELECT id FROM categories
           WHERE family_id::text = $1 AND flow_type = 'EXPENSE'
           ORDER BY id ASC LIMIT 1`,
          [familyId]
        );
        resolvedCategoryId = catRes.rows[0]?.id ? String(catRes.rows[0].id) : null;
      }

      const now = new Date();
      const baseYear = now.getFullYear();
      const baseMonth = now.getMonth() + 1;
      const safeDay = Math.min(28, Math.max(1, Number(contract.billing_day || 10)));
      const firstDueDate = `${baseYear}-${String(baseMonth).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
      const count = Math.min(12, Math.max(1, Number(months) || 1));

      for (let i = 0; i < count; i++) {
        const dueDate = addMonthsToDateStr(firstDueDate, i);
        const description =
          count > 1 ? `${contract.title} (${i + 1}/${count})` : `${contract.title}`;

        await client.query(
          `INSERT INTO transactions (
             family_id, account_id, credit_card_id, category_id, description,
             amount, transaction_date, due_date, type, status, payment_method
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'EXPENSE', 'PENDING', $8)`,
          [
            familyId,
            payment_target === 'ACCOUNT' && account_id ? account_id : null,
            payment_target === 'CARD' && credit_card_id ? credit_card_id : null,
            resolvedCategoryId,
            description,
            amount,
            dueDate,
            payment_target === 'CARD' ? 'CARD' : 'BOLETO',
          ]
        );
      }

      await client.query('COMMIT');
      return res.json({
        message: `${count} lançamento(s) de "${contract.title}" enviado(s) para Contas a Pagar!`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao lançar contrato no financeiro:', error);
      return res.status(500).json({ error: 'Não foi possível gerar os lançamentos.' });
    } finally {
      client.release();
    }
  }
);

// 6. CADASTRAR BEM / GARANTIA NO COFRE DE GARANTIAS DA CASA
router.post(
  '/warranties',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const {
      product_name,
      brand_model,
      room_category = 'Cozinha & Eletros',
      store_name,
      purchase_date,
      purchase_amount = 0,
      warranty_months = 12,
      extended_warranty_months = 0,
      invoice_number,
      serial_number,
      support_contact,
      notes,
    } = req.body ?? {};

    const cleanName = typeof product_name === 'string' ? product_name.trim() : '';
    const safePurchaseDate =
      typeof purchase_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(purchase_date)
        ? purchase_date
        : new Date().toISOString().slice(0, 10);

    if (!cleanName) {
      return res.status(400).json({ error: 'Informe o nome do produto/bem.' });
    }

    const factoryMonths = Math.max(1, Number(warranty_months) || 12);
    const extendedMonths = Math.max(0, Number(extended_warranty_months) || 0);
    const totalMonths = factoryMonths + extendedMonths;
    const expiresAt = addMonthsToDateStr(safePurchaseDate, totalMonths);

    try {
      const inserted = await pool.query(
        `INSERT INTO household_warranties (
           family_id, product_name, brand_model, room_category, store_name,
           purchase_date, purchase_amount, warranty_months, extended_warranty_months,
           warranty_expires_at, invoice_number, serial_number, support_contact, notes
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, family_id, product_name, brand_model, room_category, store_name,
                   TO_CHAR(purchase_date, 'YYYY-MM-DD') AS purchase_date,
                   purchase_amount, warranty_months, extended_warranty_months,
                   TO_CHAR(warranty_expires_at, 'YYYY-MM-DD') AS warranty_expires_at,
                   invoice_number, serial_number, support_contact, notes`,
        [
          familyId,
          cleanName.slice(0, 140),
          typeof brand_model === 'string' && brand_model.trim()
            ? brand_model.trim().slice(0, 120)
            : null,
          typeof room_category === 'string' && room_category.trim()
            ? room_category.trim().slice(0, 60)
            : 'Cozinha & Eletros',
          typeof store_name === 'string' && store_name.trim()
            ? store_name.trim().slice(0, 120)
            : null,
          safePurchaseDate,
          Math.max(0, Number(purchase_amount) || 0),
          factoryMonths,
          extendedMonths,
          expiresAt,
          typeof invoice_number === 'string' && invoice_number.trim()
            ? invoice_number.trim().slice(0, 80)
            : null,
          typeof serial_number === 'string' && serial_number.trim()
            ? serial_number.trim().slice(0, 80)
            : null,
          typeof support_contact === 'string' && support_contact.trim()
            ? support_contact.trim().slice(0, 140)
            : null,
          typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 300) : null,
        ]
      );
      return res.status(201).json(inserted.rows[0]);
    } catch (error) {
      console.error('Erro ao cadastrar garantia:', error);
      return res.status(500).json({ error: 'Não foi possível salvar a garantia do produto.' });
    }
  }
);

// 7. EXCLUIR GARANTIA DO COFRE
router.delete(
  '/warranties/:id',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      await pool.query('DELETE FROM household_warranties WHERE id = $1 AND family_id = $2', [
        req.params.id,
        familyId,
      ]);
      return res.json({ message: 'Garantia removida com sucesso.' });
    } catch (error) {
      console.error('Erro ao excluir garantia:', error);
      return res.status(500).json({ error: 'Não foi possível excluir a garantia.' });
    }
  }
);

export default router;
