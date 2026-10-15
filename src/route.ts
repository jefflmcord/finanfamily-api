import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './server'; // Certifique-se de que o pool do banco está exportado no server.ts

const router = Router();

// ============================================================================
// CONFIGURAÇÕES E VARIÁVEIS DE AMBIENTE
// ============================================================================
const JWT_SECRET = process.env.JWT_SECRET || 'finanfamily_secreto_2026';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'SEU_CLIENT_ID_DO_GOOGLE';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Configuração do disparador de e-mails (Nodemailer)
// Em produção, adicione estas variáveis no painel do Render (Environment Variables)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true para porta 465, false para as outras
  auth: {
    user: process.env.SMTP_USER || 'seu-email-real@gmail.com',
    pass: process.env.SMTP_PASS || 'sua-senha-de-aplicativo', 
  },
});

// ============================================================================
// FUNÇÃO CENTRAL: PROVISIONAMENTO ZERO-TOUCH (MULTI-TENANT)
// ============================================================================
async function provisionNewFamilyTenant(
  name: string,
  email: string,
  passwordHash: string | null,
  googleId: string | null,
  avatarUrl: string | null,
  emailVerified: boolean,
  verificationToken: string | null
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Inicia a transação segura

    // 1. Criar a Família (Tenant isolado)
    const familyResult = await client.query(
      'INSERT INTO families (name) VALUES ($1) RETURNING id',
      [`Família de ${name}`]
    );
    const familyId = familyResult.rows[0].id;

    // 2. Criar Conta Bancária Padrão
    await client.query(
      'INSERT INTO accounts (family_id, name, balance) VALUES ($1, $2, $3)',
      [familyId, 'Conta Principal', 0]
    );

    // 3. Criar Categorias Padrão
    const defaultCategories = [
      { name: 'Moradia & Contas', type: 'expense', color: '#6366f1' },
      { name: 'Alimentação', type: 'expense', color: '#f59e0b' },
      { name: 'Transporte', type: 'expense', color: '#3b82f6' },
      { name: 'Saúde', type: 'expense', color: '#ef4444' },
      { name: 'Lazer', type: 'expense', color: '#ec4899' },
      { name: 'Salário', type: 'income', color: '#10b981' },
      { name: 'Rendimentos', type: 'income', color: '#3b82f6' },
    ];

    for (const cat of defaultCategories) {
      await client.query(
        'INSERT INTO categories (family_id, name, type, color) VALUES ($1, $2, $3, $4)',
        [familyId, cat.name, cat.type, cat.color]
      );
    }

    // 4. Criar o Usuário vinculado a essa nova Família
    const userResult = await client.query(
      `INSERT INTO users 
      (name, email, password_hash, google_id, avatar_url, family_id, email_verified, verification_token) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, family_id, avatar_url`,
      [name, email, passwordHash, googleId, avatarUrl, familyId, emailVerified, verificationToken]
    );

    await client.query('COMMIT'); // Salva tudo no banco se não houver erro
    return userResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK'); // Desfaz tudo se der algum erro
    throw error;
  } finally {
    client.release(); // Libera a conexão
  }
}

// ============================================================================
// ROTAS DE AUTENTICAÇÃO E REGISTRO
// ============================================================================

// 1. REGISTRO MANUAL COM VALIDAÇÃO DE E-MAIL
router.post('/api/register', async (req: Request, res: Response): Promise<any> => {
  const { name, email, password } = req.body;
  
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Preencha todos os campos corretamente (senha mín. 6 caracteres).' });
  }

  try {
    const cleanEmail = email.trim().toLowerCase();
    
    // Verifica se o e-mail já existe
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Este e-mail já está cadastrado no sistema.' });
    }

    // Criptografa a senha e gera o token único de verificação de e-mail
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Cria a família, conta, categorias e usuário (emailVerified = false)
    await provisionNewFamilyTenant(
      name.trim(), 
      cleanEmail, 
      passwordHash, 
      null, 
      null, 
      false, 
      verificationToken
    );

    // Dispara o e-mail de boas-vindas com o link de ativação
    const verifyUrl = `${FRONTEND_URL}/verificar-email?token=${verificationToken}`;
    
    await transporter.sendMail({
      from: '"Equipe FinanFamily" <seu-email-real@gmail.com>', // Atualize para o remetente oficial
      to: cleanEmail,
      subject: 'Bem-vindo ao FinanFamily! Confirme seu e-mail',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #10b981;">Olá, ${name}!</h2>
          <p>Falta muito pouco para você acessar o painel inteligente da sua família.</p>
          <p>Por favor, clique no botão abaixo para verificar sua conta e liberar o seu acesso:</p>
          <br/>
          <a href="${verifyUrl}" style="padding: 12px 24px; background-color: #10b981; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Verificar Meu E-mail Agora
          </a>
          <br/><br/>
          <p style="font-size: 12px; color: #888;">Se você não solicitou este cadastro, pode ignorar este e-mail.</p>
        </div>
      `,
    });

    return res.status(201).json({ message: 'Conta criada! Verifique sua caixa de entrada para ativar o acesso.' });
  } catch (error) {
    console.error('Erro no registro:', error);
    return res.status(500).json({ error: 'Erro interno ao criar conta.' });
  }
});

// 2. LOGIN MANUAL TRADICIONAL
router.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];

    // Se não existir usuário ou se for uma conta logada apenas via Google (sem senha cadastrada)
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Credenciais inválidas ou e-mail vinculado ao Google.' });
    }
    
    // BLOQUEIO: Exige verificação do e-mail
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Por favor, verifique seu e-mail antes de fazer login. Cheque sua caixa de entrada.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Gera o Token de Sessão (JWT)
    const token = jwt.sign(
      { id: user.id, family_id: user.family_id }, 
      JWT_SECRET, 
      { expiresIn: '7d' }
    );
    
    // Oculta dados sensíveis antes de enviar para o Frontend
    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    
    return res.status(200).json({ token, user: safeUser });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// 3. LOGIN / REGISTRO COM GOOGLE OAUTH (Zero-Touch)
router.post('/api/auth/google', async (req: Request, res: Response): Promise<any> => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Token do Google não fornecido.' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Falha ao ler dados do Google.' });
    }

    const { email, name, sub: googleId, picture: avatarUrl } = payload;
    const cleanEmail = email.toLowerCase();

    // Verifica se já existe um usuário com este e-mail
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    let user = result.rows[0];

    if (user) {
      // Se existir mas não tiver o Google ID vinculado, nós atualizamos
      if (!user.google_id) {
        const updateResult = await pool.query(
          'UPDATE users SET google_id = $1, avatar_url = $2, email_verified = TRUE WHERE id = $3 RETURNING *',
          [googleId, avatarUrl, user.id]
        );
        user = updateResult.rows[0];
      }
    } else {
      // Se não existir, fazemos o Provisionamento Completo da Família
      // Como a validação veio do Google, já setamos emailVerified = true e sem token de verificação
      user = await provisionNewFamilyTenant(
        name || 'Usuário', 
        cleanEmail, 
        null, 
        googleId, 
        avatarUrl || null, 
        true, 
        null
      );
    }

    const token = jwt.sign(
      { id: user.id, family_id: user.family_id }, 
      JWT_SECRET, 
      { expiresIn: '7d' }
    );

    const { password_hash, verification_token, reset_token, ...safeUser } = user;

    return res.status(200).json({ token, user: safeUser });
  } catch (error) {
    console.error('Erro na autenticação Google:', error);
    return res.status(500).json({ error: 'Erro ao validar conta do Google.' });
  }
});

// ============================================================================
// ROTAS DE VERIFICAÇÃO E RECUPERAÇÃO DE SENHA
// ============================================================================

// 4. CONFIRMAR E-MAIL CLICADO NO LINK
router.post('/api/verify-email', async (req: Request, res: Response): Promise<any> => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token inválido.' });

  try {
    const result = await pool.query(
      'UPDATE users SET email_verified = TRUE, verification_token = NULL WHERE verification_token = $1 RETURNING id', 
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Link de verificação inválido ou já foi utilizado.' });
    }
    
    return res.status(200).json({ message: 'E-mail verificado com sucesso! Você já pode fazer login.' });
  } catch (error) {
    console.error('Erro ao verificar email:', error);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// 5. SOLICITAR REDEFINIÇÃO DE SENHA (Gera o Token e envia e-mail)
router.post('/api/forgot-password', async (req: Request, res: Response): Promise<any> => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório.' });

  try {
    const cleanEmail = email.trim().toLowerCase();
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    const user = result.rows[0];

    // Se o usuário existir e tiver senha cadastrada (evita enviar pra quem só loga via Google)
    if (user && user.password_hash) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expireDate = new Date(Date.now() + 30 * 60000); // Validade de 30 minutos

      await pool.query(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3', 
        [resetToken, expireDate, user.id]
      );

      const resetUrl = `${FRONTEND_URL}/redefinir-senha?token=${resetToken}`;
      
      await transporter.sendMail({
        from: '"Suporte FinanFamily" <seu-email-real@gmail.com>',
        to: cleanEmail,
        subject: 'Recuperação de Senha - FinanFamily',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
            <h2 style="color: #10b981;">Redefinição de Senha</h2>
            <p>Recebemos um pedido para alterar a senha da sua conta FinanFamily.</p>
            <p>Clique no link abaixo para criar uma nova senha (este link expira em 30 minutos):</p>
            <br/>
            <a href="${resetUrl}" style="padding: 12px 24px; background-color: #10b981; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Redefinir Minha Senha
            </a>
            <br/><br/>
            <p style="font-size: 12px; color: #888;">Se você não pediu para alterar a senha, ignore este e-mail. Sua conta continua segura.</p>
          </div>
        `,
      });
    }

    // Por segurança, retorna 200 de sucesso mesmo se o e-mail não existir (evita invasores descobrirem quem é cliente)
    return res.status(200).json({ message: 'Se o e-mail estiver cadastrado, você receberá um link de recuperação em instantes.' });
  } catch (error) {
    console.error('Erro no forgot-password:', error);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// 6. EXECUTAR REDEFINIÇÃO DE SENHA (Salva a nova senha)
router.post('/api/reset-password', async (req: Request, res: Response): Promise<any> => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Dados inválidos. A nova senha deve ter no mínimo 6 caracteres.' });
  }

  try {
    // Busca usuário pelo token e verifica se o token ainda não venceu
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()', 
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Link de recuperação inválido ou já expirado.' });
    }

    // Criptografa a nova senha
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Atualiza a senha e invalida o token para não ser usado de novo
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2', 
      [passwordHash, result.rows[0].id]
    );
    
    return res.status(200).json({ message: 'Sua senha foi alterada com sucesso! Você já pode entrar.' });
  } catch (error) {
    console.error('Erro no reset-password:', error);
    return res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// ============================================================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================================================
import { NextFunction } from 'express';

const authenticateToken = (req: any, res: Response, next: NextFunction): any => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token ausente.' });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: 'Token inválido ou expirado.' });
    req.user = user; // Guarda o id e family_id do utilizador logado
    next();
  });
};

// ============================================================================
// ROTAS DO DASHBOARD (SISTEMA INTERNO)
// ============================================================================

router.get('/api/dashboard/summary', authenticateToken, async (req: any, res: Response): Promise<any> => {
  const familyId = req.user.family_id;

  try {
    // 1. Obter o Saldo Total das contas da família
    const balanceResult = await pool.query(
      'SELECT COALESCE(SUM(balance), 0) as total_balance FROM accounts WHERE family_id = $1',
      [familyId]
    );
    const currentBalance = parseFloat(balanceResult.rows[0].total_balance);

    // 2. Obter Receitas e Despesas do Mês Atual
    // (Assumindo que já existe uma tabela 'transactions' com as colunas amount, type e date)
    const currentMonthResult = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as total_expense
      FROM transactions 
      WHERE family_id = $1 
        AND date >= date_trunc('month', CURRENT_DATE)
        AND date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
    `, [familyId]);

    const monthlyIncome = parseFloat(currentMonthResult.rows[0].total_income);
    const monthlyExpense = parseFloat(currentMonthResult.rows[0].total_expense);

    // 3. Obter as despesas agrupadas por categoria para o gráfico
    const categoryResult = await pool.query(`
      SELECT c.name, c.color, COALESCE(SUM(t.amount), 0) as total
      FROM categories c
      LEFT JOIN transactions t ON c.id = t.category_id 
        AND t.date >= date_trunc('month', CURRENT_DATE) 
        AND t.date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      WHERE c.family_id = $1 AND c.type = 'expense'
      GROUP BY c.id, c.name, c.color
      HAVING COALESCE(SUM(t.amount), 0) > 0
      ORDER BY total DESC
      LIMIT 4
    `, [familyId]);

    return res.status(200).json({
      balance: currentBalance,
      income: monthlyIncome,
      expense: monthlyExpense,
      categories: categoryResult.rows
    });

  } catch (error) {
    console.error('Erro ao carregar dashboard:', error);
    return res.status(500).json({ error: 'Erro ao carregar os dados do dashboard.' });
  }
});

export default router;