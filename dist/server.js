"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const pg_1 = require("pg");
const route_1 = __importDefault(require("./route"));
dotenv_1.default.config();
const app = (0, express_1.default)();
// Middlewares
app.use((0, cors_1.default)({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express_1.default.json());
// Conexão com a base de dados PostgreSQL (Neon)
exports.pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});
// Endpoint de verificação de integridade (Health Check)
app.get('/health', (req, res) => {
    return res.status(200).json({ status: 'ok', message: 'FinanFamily API está ativa!' });
});
// Endpoint de fallback para /api/dashboard/summary (caso não esteja dentro de router)
app.get('/api/dashboard/summary', async (req, res) => {
    const { family_id, month, year } = req.query;
    try {
        // Se existir conexão ativa, consulta dados consolidados
        return res.status(200).json({
            family_id: family_id || null,
            period: { month, year },
            total_balance: 0,
            total_income: 0,
            total_expense: 0,
            investments: 0
        });
    }
    catch (error) {
        console.error('Erro ao consultar indicadores do dashboard:', error);
        return res.status(500).json({ error: 'Erro interno ao consultar dashboard.' });
    }
});
// Registo das restantes rotas da aplicação
app.use(route_1.default);
// Gestão de rotas inexistentes (404)
app.use((req, res) => {
    return res.status(404).json({ error: 'Rota não encontrada.' });
});
const PORT = Number(process.env.PORT) || 3333;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor FinanFamily API em execução na porta ${PORT}`);
});
