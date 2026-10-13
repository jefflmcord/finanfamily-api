import { Router, Request, Response } from 'express';
import { pool } from '../database';

const router = Router();

// GET /api/categories?family_id=...&flow_type=EXPENSE
router.get('/', async (req: Request, res: Response): Promise<any> => {
  const { family_id, flow_type } = req.query;

  if (!family_id) {
    return res.status(400).json({ error: 'family_id é obrigatório.' });
  }

  try {
    let query = `
      SELECT * FROM categories 
      WHERE family_id = $1
    `;
    const params: any[] = [family_id];

    if (flow_type) {
      params.push(flow_type);
      query += ` AND flow_type = $2`;
    }

    query += ` ORDER BY name ASC;`;

    const result = await pool.query(query, params);
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/categories
router.post('/', async (req: Request, res: Response): Promise<any> => {
  const { family_id, name, type = 'VARIABLE', flow_type = 'EXPENSE', color = '#64748b' } = req.body;

  if (!family_id || !name) {
    return res.status(400).json({ error: 'family_id e name são obrigatórios.' });
  }

  try {
    const query = `
      INSERT INTO categories (family_id, name, type, flow_type, color)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    const result = await pool.query(query, [
      family_id,
      name.trim(),
      type,
      flow_type,
      color
    ]);

    return res.status(201).json(result.rows[0]);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:id
router.delete('/:id', async (req: Request, res: Response): Promise<any> => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    return res.json({ message: 'Categoria excluída com sucesso!' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;