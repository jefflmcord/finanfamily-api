"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../database");
const router = (0, express_1.Router)();
// GET /api/accounts?family_id=...
router.get('/', async (req, res) => {
    const { family_id } = req.query;
    if (!family_id) {
        return res.status(400).json({ error: 'family_id é obrigatório.' });
    }
    try {
        const result = await database_1.pool.query(`SELECT id, name, initial_balance, current_balance, color 
       FROM accounts 
       WHERE family_id = $1 
       ORDER BY name ASC`, [String(family_id)]);
        return res.json(result.rows);
    }
    catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
// POST /api/accounts
router.post('/', async (req, res) => {
    const { family_id, name, initial_balance, color } = req.body;
    if (!family_id || !name) {
        return res.status(400).json({ error: 'family_id e name são obrigatórios.' });
    }
    try {
        const balance = Number(initial_balance) || 0;
        const accountColor = color || '#3B82F6';
        const result = await database_1.pool.query(`INSERT INTO accounts (family_id, name, initial_balance, current_balance, color)
       VALUES ($1, $2, $3, $3, $4)
       RETURNING id, name, initial_balance, current_balance, color`, [family_id, name, balance, accountColor]);
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
exports.default = router;
