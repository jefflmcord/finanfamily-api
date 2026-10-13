import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import router from './route';

dotenv.config();

const app = express();

// Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Conexão com a base de dados PostgreSQL (Neon)
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Endpoint de verificação de integridade (Health Check)
app.get('/health', (req: Request, res: Response) => {
  return res.status(200).json({ status: 'ok', message: 'FinanFamily API está ativa!' });
});

// Endpoint de fallback para /api/dashboard/summary
app.get('/api/dashboard/summary', async (req: Request, res: Response) => {
  const { family_id, month, year } = req.query;

  try {
    return res.status(200).json({
      family_id: family_id || null,
      period: { month, year },
      // Estrutura atualizada para evitar o erro 'reading projected'
      total_balance: { current: 0, projected: 0 },
      total_income: { current: 0, projected: 0 },
      total_expense: { current: 0, projected: 0 },
      investments: { current: 0, projected: 0 }
    });
  } catch (error: any) {
    console.error('Erro ao consultar indicadores do dashboard:', error);
    return res.status(500).json({ error: 'Erro interno ao consultar dashboard.' });
  }
});

// Registo das restantes rotas da aplicação
app.use(router);

// Gestão de rotas inexistentes (404)
app.use((req: Request, res: Response) => {
  return res.status(404).json({ error: 'Rota não encontrada.' });
});

const PORT = Number(process.env.PORT) || 3333;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor FinanFamily API em execução na porta ${PORT}`);
});