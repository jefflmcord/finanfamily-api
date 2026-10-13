import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

export const pool = new Pool(
  connectionString
    ? {
        connectionString,
        ssl: {
          rejectUnauthorized: false, // Obrigatório para conexões remotas seguras com Neon/Render
        },
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'finanfamily',
      }
);

// Teste de conexão opcional ao iniciar
pool.on('connect', () => {
  console.log(' Conectado com sucesso ao banco PostgreSQL (Neon)!');
});

pool.on('error', (err) => {
  console.error(' Erro inesperado no cliente do pool PostgreSQL:', err);
});