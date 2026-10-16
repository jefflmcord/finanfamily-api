import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import router from './route';
import { initializeAccessControl } from './accessControl';
import { pool } from './database';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

export { pool };

// Registar as rotas unificadas
app.use(router);

const PORT = process.env.PORT || 4000;

initializeAccessControl()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor FinanFamily rodando na porta ${PORT}`);
    });
  })
  .catch((error: unknown) => {
    console.error('Falha ao preparar permissões familiares:', error);
    process.exit(1);
  });