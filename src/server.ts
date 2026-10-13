import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Importação das rotas
import transactionsRoutes from './routes/transactions';
import categoriesRoutes from './routes/categories';
import creditCardsRoutes from './routes/creditCards';
import accountsRoutes from './routes/accounts';
import dashboardRoutes from './routes/dashboard';

dotenv.config();

const app = express();

// Permite requisições tanto de localhost quanto de qualquer domínio web em produção
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Rota de Health Check (ótima para plataformas como Render checarem se a API está viva)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'FinanFamily API está ativa!' });
});

// Registro das rotas da API
app.use('/api/transactions', transactionsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/credit-cards', creditCardsRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/dashboard', dashboardRoutes);

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  console.log(` Servidor rodando na porta ${PORT}`);
});