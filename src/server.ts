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

// Conexão com o banco de dados PostgreSQL (Neon)
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Endpoint de verificação (Health Check)
app.get('/health', (req: Request, res: Response) => {
  return res.status(200).json({ status: 'ok', message: 'FinanFamily API está ativa!' });
});

// Endpoint do Dashboard com a estrutura EXATA que o React (page.tsx) espera
app.get('/api/dashboard/summary', async (req: Request, res: Response) => {
  const { month, year } = req.query;

  try {
    return res.status(200).json({
      month: Number(month) || 10,
      year: Number(year) || 2026,
      income: {
        received: 0,
        projected: 0
      },
      expenses: {
        fixed: 0,
        variable: 0,
        paidSoFar: 0,
        totalProjected: 0,
        investments: 0
      },
      interest: {
        totalPaid: 0,
        count: 0
      },
      projectedBalance: 0,
      categoriesDistribution: []
    });
  } catch (error: any) {
    console.error('Erro ao consultar indicadores do dashboard:', error);
    return res.status(500).json({ error: 'Erro interno ao consultar dashboard.' });
  }
});

// Registro das rotas da aplicação
app.use(router);

// Rota de fallback para 404 (Não encontrada)
app.use((req: Request, res: Response) => {
  return res.status(404).json({ error: 'Rota não encontrada.' });
});

const PORT = Number(process.env.PORT) || 3333;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor FinanFamily API em execução na porta ${PORT}`);
});