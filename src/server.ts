import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import router from './route';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Configuração da Ligação à Base de Dados PostgreSQL (Neon)
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Registar as rotas unificadas
app.use(router);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Servidor FinanFamily rodando na porta ${PORT}`);
});