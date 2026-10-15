import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter from './routes/auth';
import accountsRouter from './routes/accounts';
import categoriesRouter from './routes/categories';
import creditCardsRouter from './routes/creditCards';
import transactionsRouter from './routes/transactions';
import goalsRouter from './routes/goals';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', authRouter); // Mapeia /api/login e /api/register
app.use('/api/accounts', accountsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/credit-cards', creditCardsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/goals', goalsRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});