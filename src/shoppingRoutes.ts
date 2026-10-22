import { Router, Request, Response } from 'express';
import { pool } from './database';
import { requireFamilyPermission } from './accessControl';

const router = Router();

export const AISLE_CATEGORIES = [
  'Mercearia',
  'Hortifrúti',
  'Açougue & Frios',
  'Laticínios & Padaria',
  'Bebidas',
  'Limpeza',
  'Higiene & Farmácia',
  'Pet & Outros',
] as const;

interface TemplateItem {
  name: string;
  aisle_category: string;
  quantity: number;
  unit: string;
}

const SHOPPING_TEMPLATES: Record<string, TemplateItem[]> = {
  COMPRA_MES: [
    { name: 'Arroz 5kg', aisle_category: 'Mercearia', quantity: 2, unit: 'pct' },
    { name: 'Feijão 1kg', aisle_category: 'Mercearia', quantity: 3, unit: 'pct' },
    { name: 'Açúcar 5kg', aisle_category: 'Mercearia', quantity: 1, unit: 'pct' },
    { name: 'Café 500g', aisle_category: 'Mercearia', quantity: 2, unit: 'pct' },
    { name: 'Óleo de Soja 900ml', aisle_category: 'Mercearia', quantity: 3, unit: 'un' },
    { name: 'Azeite de Oliva 500ml', aisle_category: 'Mercearia', quantity: 1, unit: 'un' },
    { name: 'Macarrão 500g', aisle_category: 'Mercearia', quantity: 4, unit: 'pct' },
    { name: 'Molho de Tomate', aisle_category: 'Mercearia', quantity: 4, unit: 'un' },
    { name: 'Farinha de Trigo 1kg', aisle_category: 'Mercearia', quantity: 1, unit: 'pct' },
    { name: 'Sal 1kg', aisle_category: 'Mercearia', quantity: 1, unit: 'pct' },
    { name: 'Leite Integral 1L', aisle_category: 'Laticínios & Padaria', quantity: 12, unit: 'un' },
    { name: 'Manteiga / Margarina', aisle_category: 'Laticínios & Padaria', quantity: 2, unit: 'un' },
    { name: 'Queijo Mussarela', aisle_category: 'Laticínios & Padaria', quantity: 0.5, unit: 'kg' },
    { name: 'Ovos (Dúzia/Cartela)', aisle_category: 'Hortifrúti', quantity: 2, unit: 'cx' },
    { name: 'Peito de Frango', aisle_category: 'Açougue & Frios', quantity: 3, unit: 'kg' },
    { name: 'Carne Moída', aisle_category: 'Açougue & Frios', quantity: 2, unit: 'kg' },
    { name: 'Carne para Bife/Panela', aisle_category: 'Açougue & Frios', quantity: 2, unit: 'kg' },
    { name: 'Sabão em Pó / Líquido', aisle_category: 'Limpeza', quantity: 1, unit: 'un' },
    { name: 'Amaciante de Roupas', aisle_category: 'Limpeza', quantity: 1, unit: 'un' },
    { name: 'Detergente Lava-louças', aisle_category: 'Limpeza', quantity: 4, unit: 'un' },
    { name: 'Água Sanitária', aisle_category: 'Limpeza', quantity: 2, unit: 'un' },
    { name: 'Desinfetante', aisle_category: 'Limpeza', quantity: 2, unit: 'un' },
    { name: 'Esponja de Louça', aisle_category: 'Limpeza', quantity: 1, unit: 'pct' },
    { name: 'Saco de Lixo', aisle_category: 'Limpeza', quantity: 2, unit: 'pct' },
    { name: 'Papel Higiênico (Fardo)', aisle_category: 'Higiene & Farmácia', quantity: 2, unit: 'pct' },
    { name: 'Creme Dental', aisle_category: 'Higiene & Farmácia', quantity: 3, unit: 'un' },
    { name: 'Sabonete', aisle_category: 'Higiene & Farmácia', quantity: 6, unit: 'un' },
    { name: 'Shampoo / Condicionador', aisle_category: 'Higiene & Farmácia', quantity: 2, unit: 'un' },
  ],
  FEIRA: [
    { name: 'Banana', aisle_category: 'Hortifrúti', quantity: 1.5, unit: 'kg' },
    { name: 'Maçã', aisle_category: 'Hortifrúti', quantity: 1, unit: 'kg' },
    { name: 'Laranja / Limão', aisle_category: 'Hortifrúti', quantity: 2, unit: 'kg' },
    { name: 'Mamão / Melão', aisle_category: 'Hortifrúti', quantity: 1, unit: 'un' },
    { name: 'Tomate', aisle_category: 'Hortifrúti', quantity: 1.5, unit: 'kg' },
    { name: 'Batata Inglesa', aisle_category: 'Hortifrúti', quantity: 2, unit: 'kg' },
    { name: 'Cebola', aisle_category: 'Hortifrúti', quantity: 1, unit: 'kg' },
    { name: 'Alho', aisle_category: 'Hortifrúti', quantity: 0.3, unit: 'kg' },
    { name: 'Cenoura', aisle_category: 'Hortifrúti', quantity: 1, unit: 'kg' },
    { name: 'Alface / Folhas Verdes', aisle_category: 'Hortifrúti', quantity: 2, unit: 'un' },
    { name: 'Brócolis / Couve-flor', aisle_category: 'Hortifrúti', quantity: 1, unit: 'un' },
    { name: 'Ovos (Cartela)', aisle_category: 'Hortifrúti', quantity: 1, unit: 'cx' },
  ],
  LIMPEZA: [
    { name: 'Sabão Líquido / Pó', aisle_category: 'Limpeza', quantity: 2, unit: 'un' },
    { name: 'Amaciante Concentrado', aisle_category: 'Limpeza', quantity: 1, unit: 'un' },
    { name: 'Detergente Lava-louças', aisle_category: 'Limpeza', quantity: 6, unit: 'un' },
    { name: 'Desinfetante', aisle_category: 'Limpeza', quantity: 3, unit: 'un' },
    { name: 'Água Sanitária 2L', aisle_category: 'Limpeza', quantity: 2, unit: 'un' },
    { name: 'Limpador Multiuso', aisle_category: 'Limpeza', quantity: 2, unit: 'un' },
    { name: 'Papel Toalha', aisle_category: 'Limpeza', quantity: 2, unit: 'pct' },
    { name: 'Saco de Lixo 50L/100L', aisle_category: 'Limpeza', quantity: 2, unit: 'pct' },
    { name: 'Papel Higiênico', aisle_category: 'Higiene & Farmácia', quantity: 2, unit: 'pct' },
    { name: 'Sabonete', aisle_category: 'Higiene & Farmácia', quantity: 6, unit: 'un' },
    { name: 'Creme Dental', aisle_category: 'Higiene & Farmácia', quantity: 3, unit: 'un' },
    { name: 'Desodorante', aisle_category: 'Higiene & Farmácia', quantity: 2, unit: 'un' },
  ],
  CHURRASCO: [
    { name: 'Picanha / Alcatra / Contrafilé', aisle_category: 'Açougue & Frios', quantity: 2.5, unit: 'kg' },
    { name: 'Linguiça Toscana', aisle_category: 'Açougue & Frios', quantity: 1, unit: 'kg' },
    { name: 'Asinha / Tulipa de Frango', aisle_category: 'Açougue & Frios', quantity: 1, unit: 'kg' },
    { name: 'Pão de Alho', aisle_category: 'Laticínios & Padaria', quantity: 2, unit: 'pct' },
    { name: 'Queijo Coalho', aisle_category: 'Laticínios & Padaria', quantity: 1, unit: 'pct' },
    { name: 'Carvão 4kg/5kg', aisle_category: 'Pet & Outros', quantity: 1, unit: 'pct' },
    { name: 'Sal Grosso', aisle_category: 'Mercearia', quantity: 1, unit: 'pct' },
    { name: 'Farofa Pronta', aisle_category: 'Mercearia', quantity: 1, unit: 'pct' },
    { name: 'Refrigerante / Suco', aisle_category: 'Bebidas', quantity: 4, unit: 'un' },
    { name: 'Cerveja (Pack)', aisle_category: 'Bebidas', quantity: 2, unit: 'cx' },
  ],
};

function normalizeItemName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function getCardInvoiceDueDate(transactionDate: string, closingDay: number, dueDay: number): string {
  const [y, m, d] = transactionDate.slice(0, 10).split('-').map(Number);
  let targetYear = y;
  let targetMonth = m;

  if (d >= closingDay) {
    targetMonth += 1;
  }
  if (dueDay < closingDay) {
    targetMonth += 1;
  }
  while (targetMonth > 12) {
    targetMonth -= 12;
    targetYear += 1;
  }
  const maxDaysInMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(dueDay, 1), maxDaysInMonth);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

async function ensureSupermarketCategory(client: any, familyId: string): Promise<string> {
  const existing = await client.query(
    `SELECT id FROM categories
     WHERE family_id::text = $1
       AND flow_type = 'EXPENSE'
       AND (LOWER(name) LIKE '%mercado%' OR LOWER(name) LIKE '%alimenta%')
     ORDER BY CASE WHEN LOWER(name) LIKE '%mercado%' THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [String(familyId)]
  );
  if (existing.rows.length > 0) {
    return String(existing.rows[0].id);
  }
  const inserted = await client.query(
    `INSERT INTO categories (family_id, name, flow_type)
     VALUES ($1, 'Supermercado', 'EXPENSE')
     RETURNING id`,
    [familyId]
  );
  return String(inserted.rows[0].id);
}

// 1. VISÃO COMPLETA DO MÓDULO DE MERCADO
router.get(
  '/overview',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      const [listsRes, itemsRes, historyRes] = await Promise.all([
        pool.query(
          `SELECT id, family_id, name, store_name, budget_limit, status,
                  completed_at, total_spent, linked_transaction_id, created_at, updated_at
           FROM shopping_lists
           WHERE family_id = $1
           ORDER BY CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END, created_at DESC`,
          [familyId]
        ),
        pool.query(
          `SELECT id, list_id, family_id, name, aisle_category, quantity, unit,
                  unit_price, last_paid_price, is_checked, notes, created_at
           FROM shopping_list_items
           WHERE family_id = $1
           ORDER BY is_checked ASC, aisle_category ASC, name ASC, id ASC`,
          [familyId]
        ),
        pool.query(
          `SELECT id, normalized_name, display_name, aisle_category, unit,
                  last_price, previous_price, min_price, max_price,
                  last_store, purchase_count, updated_at
           FROM shopping_price_history
           WHERE family_id = $1
           ORDER BY purchase_count DESC, updated_at DESC`,
          [familyId]
        ),
      ]);

      const itemsByList = new Map<string, any[]>();
      for (const item of itemsRes.rows) {
        const key = String(item.list_id);
        const listItems = itemsByList.get(key) || [];
        listItems.push({
          ...item,
          quantity: Number(item.quantity || 1),
          unit_price: Number(item.unit_price || 0),
          last_paid_price: item.last_paid_price !== null ? Number(item.last_paid_price) : null,
        });
        itemsByList.set(key, listItems);
      }

      const lists = listsRes.rows.map(list => {
        const listItems = itemsByList.get(String(list.id)) || [];
        const estimatedTotal = listItems.reduce(
          (sum, it) => sum + Number(it.quantity || 0) * Number(it.unit_price || 0),
          0
        );
        const cartTotal = listItems
          .filter(it => it.is_checked)
          .reduce((sum, it) => sum + Number(it.quantity || 0) * Number(it.unit_price || 0), 0);

        return {
          ...list,
          budget_limit: Number(list.budget_limit || 0),
          total_spent: Number(list.total_spent || 0),
          total_items: listItems.length,
          checked_items: listItems.filter(it => it.is_checked).length,
          estimated_total: Math.round(estimatedTotal * 100) / 100,
          cart_total: Math.round(cartTotal * 100) / 100,
          items: listItems,
        };
      });

      return res.json({
        lists,
        priceHistory: historyRes.rows.map(row => ({
          ...row,
          last_price: Number(row.last_price || 0),
          previous_price: row.previous_price !== null ? Number(row.previous_price) : null,
          min_price: Number(row.min_price || 0),
          max_price: Number(row.max_price || 0),
          purchase_count: Number(row.purchase_count || 1),
        })),
      });
    } catch (error) {
      console.error('Erro ao carregar módulo de mercado:', error);
      return res.status(500).json({ error: 'Não foi possível carregar suas listas de mercado.' });
    }
  }
);

// 2. CRIAR NOVA LISTA DE COMPRAS (COM SUPORTE A MODELO PRONTO)
router.post(
  '/lists',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const { name, store_name, budget_limit, template } = req.body ?? {};
    const cleanName = typeof name === 'string' ? name.trim() : '';

    if (!cleanName || cleanName.length > 140) {
      return res.status(400).json({ error: 'Informe um nome válido para a lista de compras.' });
    }

    const parsedBudget = Math.max(0, Number(budget_limit) || 0);
    const cleanStore = typeof store_name === 'string' ? store_name.trim().slice(0, 120) || null : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const listRes = await client.query(
        `INSERT INTO shopping_lists (family_id, name, store_name, budget_limit, status)
         VALUES ($1, $2, $3, $4, 'OPEN')
         RETURNING id, family_id, name, store_name, budget_limit, status, created_at`,
        [familyId, cleanName, cleanStore, parsedBudget]
      );
      const createdList = listRes.rows[0];

      const templateItems =
        typeof template === 'string' && SHOPPING_TEMPLATES[template] ? SHOPPING_TEMPLATES[template] : [];

      if (templateItems.length > 0) {
        const historyRes = await client.query(
          `SELECT normalized_name, last_price FROM shopping_price_history WHERE family_id = $1`,
          [familyId]
        );
        const priceMap = new Map<string, number>();
        for (const h of historyRes.rows) {
          priceMap.set(String(h.normalized_name), Number(h.last_price));
        }

        for (const item of templateItems) {
          const norm = normalizeItemName(item.name);
          const historicalPrice = priceMap.get(norm) ?? null;
          await client.query(
            `INSERT INTO shopping_list_items (
               list_id, family_id, name, aisle_category, quantity, unit, unit_price, last_paid_price
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              createdList.id,
              familyId,
              item.name,
              item.aisle_category,
              item.quantity,
              item.unit,
              historicalPrice ?? 0,
              historicalPrice,
            ]
          );
        }
      }

      await client.query('COMMIT');
      return res.status(201).json({
        message: 'Lista de compras criada com sucesso!',
        listId: String(createdList.id),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao criar lista de compras:', error);
      return res.status(500).json({ error: 'Não foi possível criar a lista de compras.' });
    } finally {
      client.release();
    }
  }
);

// 3. ATUALIZAR LISTA DE COMPRAS
router.put(
  '/lists/:id',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const listId = req.params.id;
    const { name, store_name, budget_limit } = req.body ?? {};
    const cleanName = typeof name === 'string' ? name.trim() : '';

    if (!cleanName) {
      return res.status(400).json({ error: 'Informe um nome para a lista.' });
    }

    try {
      const result = await pool.query(
        `UPDATE shopping_lists
         SET name = $1,
             store_name = $2,
             budget_limit = $3,
             updated_at = NOW()
         WHERE id = $4 AND family_id = $5
         RETURNING *`,
        [
          cleanName.slice(0, 140),
          typeof store_name === 'string' ? store_name.trim().slice(0, 120) || null : null,
          Math.max(0, Number(budget_limit) || 0),
          listId,
          familyId,
        ]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Lista não encontrada.' });
      }
      return res.json(result.rows[0]);
    } catch (error) {
      console.error('Erro ao atualizar lista:', error);
      return res.status(500).json({ error: 'Não foi possível atualizar a lista.' });
    }
  }
);

// 4. EXCLUIR LISTA DE COMPRAS
router.delete(
  '/lists/:id',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      await pool.query('DELETE FROM shopping_lists WHERE id = $1 AND family_id = $2', [
        req.params.id,
        familyId,
      ]);
      return res.json({ message: 'Lista removida com sucesso.' });
    } catch (error) {
      console.error('Erro ao excluir lista:', error);
      return res.status(500).json({ error: 'Não foi possível excluir a lista.' });
    }
  }
);

// 5. DUPLICAR / REAPROVEITAR LISTA PARA NOVO MÊS
router.post(
  '/lists/:id/duplicate',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const sourceListId = req.params.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sourceRes = await client.query(
        'SELECT * FROM shopping_lists WHERE id = $1 AND family_id = $2',
        [sourceListId, familyId]
      );
      if (sourceRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Lista original não encontrada.' });
      }
      const source = sourceRes.rows[0];
      const newName =
        typeof req.body?.name === 'string' && req.body.name.trim()
          ? req.body.name.trim()
          : `${source.name} (Nova Compra)`;

      const newListRes = await client.query(
        `INSERT INTO shopping_lists (family_id, name, store_name, budget_limit, status)
         VALUES ($1, $2, $3, $4, 'OPEN')
         RETURNING id`,
        [familyId, newName.slice(0, 140), source.store_name, source.budget_limit]
      );
      const newListId = newListRes.rows[0].id;

      await client.query(
        `INSERT INTO shopping_list_items (
           list_id, family_id, name, aisle_category, quantity, unit,
           unit_price, last_paid_price, is_checked, notes
         )
         SELECT $1, family_id, name, aisle_category, quantity, unit,
                unit_price,
                CASE WHEN unit_price > 0 THEN unit_price ELSE last_paid_price END,
                FALSE,
                notes
         FROM shopping_list_items
         WHERE list_id = $2 AND family_id = $3`,
        [newListId, sourceListId, familyId]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        message: 'Lista reaproveitada com os últimos preços salvos!',
        listId: String(newListId),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao duplicar lista:', error);
      return res.status(500).json({ error: 'Não foi possível duplicar a lista.' });
    } finally {
      client.release();
    }
  }
);

// 6. ADICIONAR ITEM (OU MÚLTIPLOS ITENS DO CATÁLOGO RÁPIDO) À LISTA
router.post(
  '/lists/:id/items',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const listId = req.params.id;
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [req.body];

    if (rawItems.length === 0) {
      return res.status(400).json({ error: 'Informe ao menos um item.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const listCheck = await client.query(
        'SELECT id FROM shopping_lists WHERE id = $1 AND family_id = $2',
        [listId, familyId]
      );
      if (listCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Lista não encontrada.' });
      }

      const historyRes = await client.query(
        'SELECT normalized_name, last_price FROM shopping_price_history WHERE family_id = $1',
        [familyId]
      );
      const priceMap = new Map<string, number>();
      for (const h of historyRes.rows) {
        priceMap.set(String(h.normalized_name), Number(h.last_price));
      }

      const createdItems = [];
      for (const raw of rawItems) {
        const cleanName = typeof raw?.name === 'string' ? raw.name.trim() : '';
        if (!cleanName) continue;

        const norm = normalizeItemName(cleanName);
        const historicalPrice = priceMap.get(norm) ?? null;
        const providedPrice = Number(raw?.unit_price);
        const finalPrice =
          Number.isFinite(providedPrice) && providedPrice > 0
            ? providedPrice
            : historicalPrice ?? 0;

        const inserted = await client.query(
          `INSERT INTO shopping_list_items (
             list_id, family_id, name, aisle_category, quantity, unit,
             unit_price, last_paid_price, is_checked, notes
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            listId,
            familyId,
            cleanName.slice(0, 140),
            typeof raw?.aisle_category === 'string' && raw.aisle_category.trim()
              ? raw.aisle_category.trim()
              : 'Mercearia',
            Math.max(0.01, Number(raw?.quantity) || 1),
            typeof raw?.unit === 'string' && raw.unit.trim() ? raw.unit.trim().slice(0, 20) : 'un',
            Math.max(0, finalPrice),
            historicalPrice,
            Boolean(raw?.is_checked),
            typeof raw?.notes === 'string' ? raw.notes.trim().slice(0, 200) || null : null,
          ]
        );
        createdItems.push(inserted.rows[0]);
      }

      await client.query('COMMIT');
      return res.status(201).json({ items: createdItems });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao adicionar item à lista:', error);
      return res.status(500).json({ error: 'Não foi possível adicionar o item.' });
    } finally {
      client.release();
    }
  }
);

// 7. ATUALIZAR ITEM DA LISTA (MARCAR NO CARRINHO, ALTERAR QUANTIDADE/PREÇO)
router.put(
  '/items/:itemId',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const itemId = req.params.itemId;
    const { name, aisle_category, quantity, unit, unit_price, is_checked, notes } = req.body ?? {};

    try {
      const currentRes = await pool.query(
        'SELECT * FROM shopping_list_items WHERE id = $1 AND family_id = $2',
        [itemId, familyId]
      );
      if (currentRes.rows.length === 0) {
        return res.status(404).json({ error: 'Item não encontrado.' });
      }
      const current = currentRes.rows[0];

      const nextName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 140) : current.name;
      const nextAisle =
        typeof aisle_category === 'string' && aisle_category.trim()
          ? aisle_category.trim()
          : current.aisle_category;
      const nextQuantity =
        quantity !== undefined ? Math.max(0.001, Number(quantity) || 1) : Number(current.quantity);
      const nextUnit = typeof unit === 'string' && unit.trim() ? unit.trim().slice(0, 20) : current.unit;
      const nextUnitPrice =
        unit_price !== undefined ? Math.max(0, Number(unit_price) || 0) : Number(current.unit_price);
      const nextChecked = is_checked !== undefined ? Boolean(is_checked) : Boolean(current.is_checked);
      const nextNotes =
        notes !== undefined ? (typeof notes === 'string' ? notes.trim().slice(0, 200) || null : null) : current.notes;

      const updated = await pool.query(
        `UPDATE shopping_list_items
         SET name = $1,
             aisle_category = $2,
             quantity = $3,
             unit = $4,
             unit_price = $5,
             is_checked = $6,
             notes = $7
         WHERE id = $8 AND family_id = $9
         RETURNING *`,
        [
          nextName,
          nextAisle,
          nextQuantity,
          nextUnit,
          nextUnitPrice,
          nextChecked,
          nextNotes,
          itemId,
          familyId,
        ]
      );

      return res.json(updated.rows[0]);
    } catch (error) {
      console.error('Erro ao atualizar item da lista:', error);
      return res.status(500).json({ error: 'Não foi possível atualizar o item.' });
    }
  }
);

// 8. REMOVER ITEM DA LISTA
router.delete(
  '/items/:itemId',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    try {
      await pool.query('DELETE FROM shopping_list_items WHERE id = $1 AND family_id = $2', [
        req.params.itemId,
        familyId,
      ]);
      return res.json({ message: 'Item removido.' });
    } catch (error) {
      console.error('Erro ao remover item:', error);
      return res.status(500).json({ error: 'Não foi possível remover o item.' });
    }
  }
);

// 9. FINALIZAR COMPRA NO CAIXA & LANÇAR AUTOMATICAMENTE NO FINANCEIRO
router.post(
  '/lists/:id/checkout',
  requireFamilyPermission('family_read'),
  async (req: Request, res: Response): Promise<any> => {
    const familyId = String(req.familyAccess!.familyId);
    const listId = req.params.id;
    const {
      store_name,
      total_spent_override,
      create_transaction = true,
      payment_target = 'ACCOUNT', // 'ACCOUNT' | 'CARD'
      account_id,
      credit_card_id,
      category_id,
      payment_method = 'PIX',
      settle_immediately = true,
      purchase_date,
    } = req.body ?? {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const listRes = await client.query(
        'SELECT * FROM shopping_lists WHERE id = $1 AND family_id = $2 FOR UPDATE',
        [listId, familyId]
      );
      if (listRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Lista de compras não encontrada.' });
      }
      const list = listRes.rows[0];
      const finalStore =
        typeof store_name === 'string' && store_name.trim()
          ? store_name.trim().slice(0, 120)
          : list.store_name;

      const itemsRes = await client.query(
        'SELECT * FROM shopping_list_items WHERE list_id = $1 AND family_id = $2',
        [listId, familyId]
      );
      const allItems = itemsRes.rows;
      const checkedItems = allItems.filter(it => it.is_checked);
      const itemsToProcess = checkedItems.length > 0 ? checkedItems : allItems;

      const calculatedTotal = itemsToProcess.reduce(
        (sum, it) => sum + Number(it.quantity || 0) * Number(it.unit_price || 0),
        0
      );
      const finalTotal =
        Number.isFinite(Number(total_spent_override)) && Number(total_spent_override) > 0
          ? Math.round(Number(total_spent_override) * 100) / 100
          : Math.round(calculatedTotal * 100) / 100;

      // Atualiza histórico de preços da família para cada item com preço informado
      for (const item of itemsToProcess) {
        const unitPrice = Number(item.unit_price || 0);
        if (unitPrice <= 0) continue;

        const norm = normalizeItemName(item.name);
        await client.query(
          `INSERT INTO shopping_price_history (
             family_id, normalized_name, display_name, aisle_category, unit,
             last_price, previous_price, min_price, max_price, last_store, purchase_count, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $6, $6, $7, 1, NOW())
           ON CONFLICT (family_id, normalized_name)
           DO UPDATE SET
             display_name = EXCLUDED.display_name,
             aisle_category = EXCLUDED.aisle_category,
             unit = EXCLUDED.unit,
             previous_price = shopping_price_history.last_price,
             last_price = EXCLUDED.last_price,
             min_price = LEAST(shopping_price_history.min_price, EXCLUDED.last_price),
             max_price = GREATEST(shopping_price_history.max_price, EXCLUDED.last_price),
             last_store = COALESCE(EXCLUDED.last_store, shopping_price_history.last_store),
             purchase_count = shopping_price_history.purchase_count + 1,
             updated_at = NOW()`,
          [
            familyId,
            norm,
            item.name,
            item.aisle_category || 'Mercearia',
            item.unit || 'un',
            unitPrice,
            finalStore,
          ]
        );
      }

      let linkedTransactionId: string | null = null;
      const txDate =
        typeof purchase_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(purchase_date)
          ? purchase_date
          : new Date().toISOString().slice(0, 10);

      if (create_transaction && finalTotal > 0) {
        const resolvedCategoryId = category_id
          ? String(category_id)
          : await ensureSupermarketCategory(client, familyId);

        const txDescription = finalStore
          ? `Mercado: ${list.name} (${finalStore})`
          : `Mercado: ${list.name}`;

        if (payment_target === 'CARD' && credit_card_id) {
          const cardRes = await client.query(
            'SELECT id, closing_day, due_day FROM credit_cards WHERE id = $1 AND family_id = $2',
            [credit_card_id, familyId]
          );
          if (cardRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Cartão de crédito selecionado inválido.' });
          }
          const card = cardRes.rows[0];
          const dueDate = getCardInvoiceDueDate(
            txDate,
            Number(card.closing_day || 1),
            Number(card.due_day || 10)
          );

          const txInsert = await client.query(
            `INSERT INTO transactions (
               family_id, credit_card_id, category_id, description, amount,
               transaction_date, due_date, type, status, payment_method
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'EXPENSE', 'PENDING', 'CARD')
             RETURNING id`,
            [familyId, credit_card_id, resolvedCategoryId, txDescription, finalTotal, txDate, dueDate]
          );
          linkedTransactionId = String(txInsert.rows[0].id);
        } else {
          const isPaid = Boolean(settle_immediately && account_id);
          const txInsert = await client.query(
            `INSERT INTO transactions (
               family_id, account_id, category_id, description, amount, paid_amount,
               transaction_date, due_date, type, status, payment_method
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'EXPENSE', $8, $9)
             RETURNING id`,
            [
              familyId,
              account_id || null,
              resolvedCategoryId,
              txDescription,
              finalTotal,
              isPaid ? finalTotal : null,
              txDate,
              isPaid ? 'PAID' : 'PENDING',
              payment_method || 'PIX',
            ]
          );
          linkedTransactionId = String(txInsert.rows[0].id);

          if (isPaid && account_id) {
            await client.query(
              'UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND family_id = $3',
              [finalTotal, account_id, familyId]
            );
          }
        }
      }

      await client.query(
        `UPDATE shopping_lists
         SET status = 'COMPLETED',
             store_name = $1,
             total_spent = $2,
             completed_at = NOW(),
             linked_transaction_id = $3,
             updated_at = NOW()
         WHERE id = $4 AND family_id = $5`,
        [finalStore, finalTotal, linkedTransactionId, listId, familyId]
      );

      await client.query('COMMIT');
      return res.json({
        message: create_transaction
          ? 'Compra finalizada e lançada automaticamente no financeiro da família!'
          : 'Compra concluída e preços salvos no histórico da casa!',
        linkedTransactionId,
        totalSpent: finalTotal,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao finalizar compra de mercado:', error);
      return res.status(500).json({ error: 'Não foi possível finalizar a compra.' });
    } finally {
      client.release();
    }
  }
);

export default router;
