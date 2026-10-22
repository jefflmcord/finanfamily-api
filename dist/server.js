var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/server.ts
var server_exports = {};
__export(server_exports, {
  pool: () => pool
});
module.exports = __toCommonJS(server_exports);
var import_express5 = __toESM(require("express"));
var import_cors = __toESM(require("cors"));
var import_dotenv2 = __toESM(require("dotenv"));

// src/route.ts
var import_express4 = require("express");
var import_bcrypt2 = __toESM(require("bcrypt"));
var import_jsonwebtoken3 = __toESM(require("jsonwebtoken"));
var import_google_auth_library = require("google-auth-library");

// src/database.ts
var import_pg = require("pg");
var import_dotenv = __toESM(require("dotenv"));
import_dotenv.default.config();
var connectionString = process.env.DATABASE_URL;
var pool = new import_pg.Pool(
  connectionString ? {
    connectionString,
    max: 12,
    idleTimeoutMillis: 3e4,
    connectionTimeoutMillis: 1e4,
    keepAlive: true,
    ssl: {
      rejectUnauthorized: false
      // Obrigatório para conexões remotas seguras com Neon/Render
    }
  } : {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "finanfamily",
    max: 12,
    idleTimeoutMillis: 3e4,
    keepAlive: true
  }
);
pool.on("connect", () => {
  console.log(" Conectado com sucesso ao banco PostgreSQL (Neon)!");
});
pool.on("error", (err) => {
  console.error(" Erro inesperado no cliente do pool PostgreSQL:", err);
});

// src/familyRoutes.ts
var import_express = require("express");
var import_bcrypt = __toESM(require("bcrypt"));
var import_jsonwebtoken2 = __toESM(require("jsonwebtoken"));

// src/accessControl.ts
var import_crypto = require("crypto");
var import_jsonwebtoken = __toESM(require("jsonwebtoken"));
var JWT_SECRET = process.env.JWT_SECRET || "finanfamily_secreto_2026";
var DEFAULT_SUPPORT_PHONE = "(41) 0000-0000";
var INTERNAL_ADMIN_EMAIL = "jeffersonluismattosocordeiro@gmail.com";
async function getTenantAccessStatus(familyId) {
  const result = await pool.query(
    `SELECT f.blocked_at,
            (SELECT value FROM system_settings WHERE key = 'tenant_support_phone') AS contact_phone
     FROM families f
     WHERE f.id::text = $1`,
    [String(familyId)]
  );
  return {
    blocked: Boolean(result.rows[0]?.blocked_at),
    contactPhone: result.rows[0]?.contact_phone || DEFAULT_SUPPORT_PHONE
  };
}
var FAMILY_PERMISSIONS = [
  "family_read",
  "transactions_create",
  "transactions_edit",
  "transactions_delete",
  "transactions_settle",
  "accounts_manage",
  "cards_manage",
  "categories_manage",
  "goals_manage",
  "provisions_manage",
  "members_manage"
];
async function initializeAccessControl() {
  const defaultPermissions = JSON.stringify(
    Object.fromEntries(FAMILY_PERMISSIONS.map((permission) => [
      permission,
      permission !== "members_manage"
    ]))
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS family_members (
      family_id TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      invited_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (family_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS family_invitations (
      token_hash TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      email TEXT NOT NULL,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      invited_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ
    )
  `);
  await pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12, 2)");
  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'BOLETO'
  `);
  await pool.query(`
    ALTER TABLE categories
      ADD COLUMN IF NOT EXISTS budget_amount NUMERIC(12, 2)
      CHECK (budget_amount IS NULL OR budget_amount > 0)
  `);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone TEXT,
      ADD COLUMN IF NOT EXISTS birth_date DATE,
      ADD COLUMN IF NOT EXISTS bio VARCHAR(280),
      ADD COLUMN IF NOT EXISTS reset_token TEXT,
      ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE families
      ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'TRIAL',
      ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS subscription_ends_at DATE,
      ADD COLUMN IF NOT EXISTS admin_notes TEXT,
      ADD COLUMN IF NOT EXISTS enabled_modules JSONB NOT NULL DEFAULT '["financeiro","mercado"]'::jsonb
  `);
  await pool.query(`
    ALTER TABLE families
      ALTER COLUMN registered_at SET DEFAULT NOW(),
      ALTER COLUMN trial_ends_at SET DEFAULT (NOW() + INTERVAL '10 days')
  `);
  await pool.query(`
    UPDATE families
    SET trial_ends_at = COALESCE(registered_at, NOW()) + INTERVAL '10 days'
    WHERE trial_ends_at IS NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_leads (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(180) NOT NULL UNIQUE,
      whatsapp VARCHAR(40) NOT NULL,
      source VARCHAR(80) NOT NULL DEFAULT 'EBOOK_10_PASSOS',
      status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED')),
      notes TEXT,
      download_count INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS annual_provisions (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      title VARCHAR(120) NOT NULL,
      expense_type TEXT NOT NULL CHECK (expense_type IN ('IPTU', 'IPVA', 'LICENCIAMENTO', 'OTHER')),
      target_amount NUMERIC(12, 2) NOT NULL CHECK (target_amount > 0),
      saved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
      due_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAID')),
      actual_amount NUMERIC(12, 2) CHECK (actual_amount IS NULL OR actual_amount > 0),
      paid_date DATE,
      renewed_from_id BIGINT UNIQUE REFERENCES annual_provisions(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS annual_provision_contributions (
      id BIGSERIAL PRIMARY KEY,
      provision_id BIGINT NOT NULL REFERENCES annual_provisions(id) ON DELETE CASCADE,
      family_id TEXT NOT NULL,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      contribution_date DATE NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS annual_provisions_family_due_idx
      ON annual_provisions (family_id, status, due_date)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS annual_provision_contributions_provision_date_idx
      ON annual_provision_contributions (provision_id, contribution_date DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_lists (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      name VARCHAR(140) NOT NULL,
      store_name VARCHAR(120),
      budget_limit NUMERIC(12, 2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COMPLETED')),
      completed_at TIMESTAMPTZ,
      total_spent NUMERIC(12, 2) NOT NULL DEFAULT 0,
      linked_transaction_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_list_items (
      id BIGSERIAL PRIMARY KEY,
      list_id BIGINT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
      family_id TEXT NOT NULL,
      name VARCHAR(140) NOT NULL,
      aisle_category VARCHAR(60) NOT NULL DEFAULT 'Mercearia',
      quantity NUMERIC(10, 3) NOT NULL DEFAULT 1,
      unit VARCHAR(20) NOT NULL DEFAULT 'un',
      unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      last_paid_price NUMERIC(12, 2),
      is_checked BOOLEAN NOT NULL DEFAULT FALSE,
      notes VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_price_history (
      id BIGSERIAL PRIMARY KEY,
      family_id TEXT NOT NULL,
      normalized_name VARCHAR(140) NOT NULL,
      display_name VARCHAR(140) NOT NULL,
      aisle_category VARCHAR(60) NOT NULL DEFAULT 'Mercearia',
      unit VARCHAR(20) NOT NULL DEFAULT 'un',
      last_price NUMERIC(12, 2) NOT NULL,
      previous_price NUMERIC(12, 2),
      min_price NUMERIC(12, 2) NOT NULL,
      max_price NUMERIC(12, 2) NOT NULL,
      last_store VARCHAR(120),
      purchase_count INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (family_id, normalized_name)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS shopping_lists_family_status_idx
      ON shopping_lists (family_id, status, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS shopping_list_items_list_idx
      ON shopping_list_items (list_id, aisle_category, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS shopping_price_history_family_idx
      ON shopping_price_history (family_id, updated_at DESC)
  `);
  await pool.query(`
    UPDATE family_members
    SET permissions = jsonb_set(COALESCE(permissions, '{}'::jsonb), '{provisions_manage}', 'false'::jsonb, true)
    WHERE NOT COALESCE(permissions ? 'provisions_manage', false)
  `);
  await pool.query(
    `INSERT INTO system_settings (key, value)
     VALUES
       ('tenant_support_phone', $1),
       ('global_broadcast_message', ''),
       ('global_broadcast_type', 'INFO')
     ON CONFLICT (key) DO NOTHING`,
    [DEFAULT_SUPPORT_PHONE]
  );
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('family_budgets') IS NOT NULL THEN
        EXECUTE $migration$
          UPDATE categories c
          SET budget_amount = latest.amount
          FROM (
            SELECT DISTINCT ON (family_id, category_id) family_id, category_id, amount
            FROM family_budgets
            ORDER BY family_id, category_id, updated_at DESC, year DESC, month DESC
          ) latest
          WHERE c.id::text = latest.category_id
            AND c.family_id::text = latest.family_id
            AND c.flow_type = 'EXPENSE'
            AND c.budget_amount IS NULL
        $migration$;
        EXECUTE 'DROP TABLE family_budgets';
      END IF;
    END $$
  `);
  await pool.query(`
    UPDATE transactions
    SET payment_method = 'CARD'
    WHERE credit_card_id IS NOT NULL AND payment_method <> 'CARD'
  `);
  await pool.query(`
    ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS bank_name TEXT,
      ADD COLUMN IF NOT EXISTS agency TEXT,
      ADD COLUMN IF NOT EXISTS account_number TEXT,
      ADD COLUMN IF NOT EXISTS pix_key TEXT,
      ADD COLUMN IF NOT EXISTS initial_balance NUMERIC(12, 2)
  `);
  await pool.query("UPDATE accounts SET initial_balance = balance WHERE initial_balance IS NULL");
  await pool.query("ALTER TABLE accounts ALTER COLUMN initial_balance SET DEFAULT 0");
  await pool.query("ALTER TABLE accounts ALTER COLUMN initial_balance SET NOT NULL");
  await pool.query("UPDATE accounts SET bank_name = name WHERE bank_name IS NULL");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS family_invitations_family_email_idx
      ON family_invitations (family_id, email)
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_lower_email_idx ON users (LOWER(email))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_id_text_idx ON users ((id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS families_id_text_idx ON families ((id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS family_members_user_id_idx ON family_members (user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS family_members_family_id_idx ON family_members (family_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS accounts_family_id_idx ON accounts ((family_id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS categories_family_id_idx ON categories ((family_id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS credit_cards_family_id_idx ON credit_cards ((family_id::text))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS transactions_family_due_idx ON transactions ((family_id::text), due_date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS transactions_category_id_idx ON transactions (category_id)`);
  await pool.query(
    `INSERT INTO family_members (family_id, user_id, role, permissions)
     SELECT ranked.family_id, ranked.user_id,
       CASE WHEN ranked.member_number = 1 THEN 'OWNER' ELSE 'MEMBER' END,
       $1::jsonb
     FROM (
       SELECT family_id::text AS family_id, id::text AS user_id,
         ROW_NUMBER() OVER (PARTITION BY family_id ORDER BY id) AS member_number
       FROM users
       WHERE family_id IS NOT NULL
     ) ranked
     ON CONFLICT (user_id) DO NOTHING`,
    [defaultPermissions]
  );
  await pool.query(
    `UPDATE family_members
     SET permissions = jsonb_set(permissions, '{members_manage}', 'false'::jsonb, true)
     WHERE role = 'MEMBER'`
  );
}
var authMembershipCache = /* @__PURE__ */ new Map();
var AUTH_CACHE_TTL_MS = 4e3;
function invalidateAuthMembershipCache(userId) {
  if (userId) {
    authMembershipCache.delete(String(userId));
  } else {
    authMembershipCache.clear();
  }
}
function authenticateFamilyMember(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Acesso negado. Token ausente." });
    return;
  }
  import_jsonwebtoken.default.verify(token, JWT_SECRET, async (error, decoded) => {
    if (error || !decoded || typeof decoded === "string" || !("id" in decoded)) {
      res.status(403).json({ error: "Token inv\xE1lido ou expirado." });
      return;
    }
    const userIdKey = String(decoded.id);
    const now = Date.now();
    const cached = authMembershipCache.get(userIdKey);
    try {
      let membership = cached && cached.expiresAt > now ? cached : void 0;
      if (!membership) {
        const result = await pool.query(
          `SELECT fm.family_id, fm.user_id, fm.role, fm.permissions,
                  f.blocked_at, u.email,
                  (SELECT value FROM system_settings WHERE key = 'tenant_support_phone') AS contact_phone
           FROM family_members fm
           JOIN families f ON f.id::text = fm.family_id
           JOIN users u ON u.id::text = fm.user_id
           WHERE fm.user_id = $1`,
          [userIdKey]
        );
        const row = result.rows[0];
        if (row) {
          membership = {
            family_id: String(row.family_id),
            user_id: String(row.user_id),
            role: row.role,
            permissions: row.permissions || {},
            blocked_at: row.blocked_at || null,
            email: String(row.email || ""),
            contact_phone: row.contact_phone || null,
            expiresAt: now + AUTH_CACHE_TTL_MS
          };
          authMembershipCache.set(userIdKey, membership);
        }
      }
      if (!membership) {
        res.status(403).json({ error: "Este usu\xE1rio n\xE3o est\xE1 vinculado a uma fam\xEDlia ativa." });
        return;
      }
      req.familyAccess = {
        userId: String(membership.user_id),
        familyId: String(membership.family_id),
        role: membership.role,
        permissions: membership.permissions || {}
      };
      if (membership.blocked_at) {
        const isInternalAdmin2 = String(membership.email).toLowerCase() === INTERNAL_ADMIN_EMAIL;
        if (!isInternalAdmin2 || !req.originalUrl.startsWith("/api/internal/")) {
          res.status(403).json({
            code: "TENANT_BLOCKED",
            error: "Seu acesso est\xE1 temporariamente indispon\xEDvel.",
            contact_phone: membership.contact_phone || DEFAULT_SUPPORT_PHONE
          });
          return;
        }
      }
      next();
    } catch (dbError) {
      next(dbError);
    }
  });
}
function requireFamilyPermission(permission) {
  return (req, res, next) => {
    const access = req.familyAccess;
    if (!access) {
      res.status(401).json({ error: "Acesso n\xE3o autenticado." });
      return;
    }
    if (access.role === "OWNER" || access.permissions[permission] === true) {
      next();
      return;
    }
    res.status(403).json({ error: "Voc\xEA n\xE3o tem permiss\xE3o para realizar esta a\xE7\xE3o." });
  };
}
function createInvitationToken() {
  const token = (0, import_crypto.randomBytes)(32).toString("base64url");
  return { token, tokenHash: (0, import_crypto.createHash)("sha256").update(token).digest("hex") };
}
function hashInvitationToken(token) {
  return (0, import_crypto.createHash)("sha256").update(token).digest("hex");
}

// src/familyRoutes.ts
var JWT_SECRET2 = process.env.JWT_SECRET || "finanfamily_secreto_2026";
var publicRouter = (0, import_express.Router)();
var router = (0, import_express.Router)();
var VALID_PLAN_TYPES = ["TRIAL", "MONTHLY", "ANNUAL", "COURTESY"];
var VALID_BROADCAST_TYPES = ["INFO", "SUCCESS", "WARNING"];
var VALID_LEAD_STATUSES = ["NEW", "CONTACTED", "CONVERTED", "ARCHIVED"];
var DEFAULT_FAMILY_CATEGORIES = [
  { name: "Investimento", flow_type: "EXPENSE" },
  { name: "Moradia & Contas", flow_type: "EXPENSE" },
  { name: "Supermercado & Alimenta\xE7\xE3o", flow_type: "EXPENSE" },
  { name: "Transporte & Combust\xEDvel", flow_type: "EXPENSE" },
  { name: "Sa\xFAde & Farm\xE1cia", flow_type: "EXPENSE" },
  { name: "Lazer & Assinaturas", flow_type: "EXPENSE" },
  { name: "Sal\xE1rio & Pr\xF3-labore", flow_type: "INCOME" },
  { name: "Renda Extra", flow_type: "INCOME" }
];
async function seedDefaultFamilyResources(client, familyId) {
  await client.query(
    "INSERT INTO accounts (family_id, name, bank_name, balance, initial_balance) VALUES ($1, $2, $3, $4, $5)",
    [familyId, "Conta Principal", "Conta Principal", 0, 0]
  );
  for (const category of DEFAULT_FAMILY_CATEGORIES) {
    await client.query(
      "INSERT INTO categories (family_id, name, flow_type) VALUES ($1, $2, $3)",
      [familyId, category.name, category.flow_type]
    );
  }
}
async function isInternalAdmin(userId) {
  const result = await pool.query(
    "SELECT 1 FROM users WHERE id::text = $1 AND LOWER(email) = $2",
    [userId, INTERNAL_ADMIN_EMAIL]
  );
  return result.rows.length > 0;
}
publicRouter.post("/api/public/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  const familyNameInput = typeof req.body?.family_name === "string" ? req.body.family_name.trim().slice(0, 120) : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const whatsapp = typeof req.body?.whatsapp === "string" ? req.body.whatsapp.trim().slice(0, 40) : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const digitCount = whatsapp.replace(/\D/g, "").length;
  if (name.length < 2) {
    return res.status(400).json({ error: "Informe seu nome completo." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Informe um endere\xE7o de e-mail v\xE1lido." });
  }
  if (digitCount < 8 || digitCount > 15) {
    return res.status(400).json({ error: "Informe um WhatsApp v\xE1lido com DDD." });
  }
  if (password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingUser = await client.query(
      "SELECT id FROM users WHERE LOWER(email) = $1 FOR UPDATE",
      [email]
    );
    if (existingUser.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: 'Este e-mail j\xE1 possui uma conta cadastrada. Use a aba "J\xE1 tenho conta" para entrar.'
      });
    }
    const familyName = familyNameInput || `Fam\xEDlia de ${name.split(" ")[0]}`;
    const familyRes = await client.query(
      `INSERT INTO families (name, registered_at, plan_type, trial_ends_at)
       VALUES ($1, NOW(), 'TRIAL', NOW() + INTERVAL '10 days')
       RETURNING id`,
      [familyName]
    );
    const familyId = familyRes.rows[0].id;
    await seedDefaultFamilyResources(client, familyId);
    const passwordHash = await import_bcrypt.default.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, phone, password_hash, family_id, email_verified)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, name, email, phone, family_id, avatar_url`,
      [name, email, whatsapp, passwordHash, familyId]
    );
    const user = userRes.rows[0];
    const ownerPermissions = Object.fromEntries(FAMILY_PERMISSIONS.map((permission) => [permission, true]));
    await client.query(
      `INSERT INTO family_members (family_id, user_id, role, permissions)
       VALUES ($1, $2, 'OWNER', $3::jsonb)`,
      [String(familyId), String(user.id), JSON.stringify(ownerPermissions)]
    );
    await client.query(
      `UPDATE marketing_leads
       SET status = 'CONVERTED',
           whatsapp = COALESCE(NULLIF($1, ''), whatsapp),
           updated_at = NOW()
       WHERE LOWER(email) = $2`,
      [whatsapp, email]
    );
    await client.query("COMMIT");
    const token = import_jsonwebtoken2.default.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET2,
      { expiresIn: "7d" }
    );
    return res.status(201).json({ token, user });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({ error: "Este e-mail j\xE1 possui uma conta cadastrada." });
    }
    console.error("Erro ao criar nova conta familiar:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel concluir o cadastro agora. Tente novamente." });
  } finally {
    client.release();
  }
});
publicRouter.post("/api/public/leads/ebook", async (req, res) => {
  const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const name = rawName ? rawName.slice(0, 120) : "Visitante";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const whatsapp = typeof req.body?.whatsapp === "string" ? req.body.whatsapp.trim().slice(0, 40) : "";
  const digitCount = whatsapp.replace(/\D/g, "").length;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Informe um e-mail v\xE1lido para baixar o e-book." });
  }
  if (digitCount < 8 || digitCount > 15) {
    return res.status(400).json({ error: "Informe um WhatsApp v\xE1lido com DDD." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO marketing_leads (name, email, whatsapp, source)
       VALUES ($1, $2, $3, 'EBOOK_10_PASSOS')
       ON CONFLICT (email)
       DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> 'Visitante' THEN EXCLUDED.name ELSE marketing_leads.name END,
         whatsapp = EXCLUDED.whatsapp,
         download_count = marketing_leads.download_count + 1,
         updated_at = NOW()
       RETURNING id, name, email, whatsapp, status, download_count, created_at`,
      [name, email, whatsapp]
    );
    await pool.query(
      `UPDATE users SET phone = COALESCE(NULLIF(phone, ''), $1) WHERE LOWER(email) = $2`,
      [whatsapp, email]
    );
    return res.status(201).json({ success: true, lead: result.rows[0] });
  } catch (error) {
    console.error("Erro ao registrar lead do e-book:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel registrar seus dados no momento." });
  }
});
publicRouter.post("/api/public/recover-password", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const whatsapp = typeof req.body?.whatsapp === "string" ? req.body.whatsapp.trim() : "";
  const newPassword = typeof req.body?.new_password === "string" ? req.body.new_password : "";
  const inputDigits = whatsapp.replace(/\D/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Informe o e-mail cadastrado na sua conta." });
  }
  if (inputDigits.length < 8) {
    return res.status(400).json({ error: "Informe o WhatsApp cadastrado na conta com DDD." });
  }
  if (newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: "A nova senha deve ter entre 6 e 64 caracteres." });
  }
  try {
    const [userRes, settingRes] = await Promise.all([
      pool.query(
        `SELECT u.id, u.email, u.phone,
                (SELECT ml.whatsapp FROM marketing_leads ml WHERE LOWER(ml.email) = LOWER(u.email) LIMIT 1) AS lead_whatsapp
         FROM users u
         WHERE LOWER(u.email) = $1
         LIMIT 1`,
        [email]
      ),
      pool.query(`SELECT value FROM system_settings WHERE key = 'tenant_support_phone'`)
    ]);
    const supportPhone = settingRes.rows[0]?.value || "(41) 0000-0000";
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: "N\xE3o encontramos nenhuma conta cadastrada com este e-mail." });
    }
    const storedPhoneRaw = String(user.phone || user.lead_whatsapp || "");
    const storedDigits = storedPhoneRaw.replace(/\D/g, "");
    if (storedDigits.length < 8) {
      return res.status(409).json({
        code: "PHONE_NOT_REGISTERED",
        contact_phone: supportPhone,
        error: "Esta conta ainda n\xE3o possui WhatsApp vinculado para valida\xE7\xE3o autom\xE1tica. Solicite a redefini\xE7\xE3o r\xE1pida pelo suporte abaixo."
      });
    }
    const storedSuffix = storedDigits.slice(-8);
    const inputSuffix = inputDigits.slice(-8);
    if (storedSuffix !== inputSuffix) {
      return res.status(401).json({
        error: "O WhatsApp informado n\xE3o confere com o telefone cadastrado para este e-mail."
      });
    }
    const passwordHash = await import_bcrypt.default.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           phone = COALESCE(NULLIF(phone, ''), $2),
           reset_token = NULL,
           reset_token_expires_at = NULL
       WHERE id = $3`,
      [passwordHash, whatsapp, user.id]
    );
    return res.json({ message: "Sua senha foi redefinida com sucesso! Voc\xEA j\xE1 pode entrar." });
  } catch (error) {
    console.error("Erro na recupera\xE7\xE3o de senha:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel redefinir sua senha no momento." });
  }
});
publicRouter.post("/api/forgot-password", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Informe um e-mail v\xE1lido." });
  }
  try {
    const { token, tokenHash } = createInvitationToken();
    await pool.query(
      `UPDATE users
       SET reset_token = $1,
           reset_token_expires_at = NOW() + INTERVAL '2 hours'
       WHERE LOWER(email) = $2`,
      [tokenHash, email]
    );
    return res.json({
      message: "Se o e-mail estiver cadastrado, as instru\xE7\xF5es de recupera\xE7\xE3o foram processadas.",
      reset_token_created: Boolean(token)
    });
  } catch (error) {
    console.error("Erro ao solicitar token de redefini\xE7\xE3o:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel processar a solicita\xE7\xE3o." });
  }
});
publicRouter.post("/api/reset-password", async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  if (!token || newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: "Token v\xE1lido e senha com no m\xEDnimo 6 caracteres s\xE3o obrigat\xF3rios." });
  }
  try {
    const tokenHash = hashInvitationToken(token);
    const passwordHash = await import_bcrypt.default.hash(newPassword, 10);
    const result = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           reset_token = NULL,
           reset_token_expires_at = NULL
       WHERE (reset_token = $2 OR reset_token = $3)
         AND (reset_token_expires_at IS NULL OR reset_token_expires_at > NOW())
       RETURNING id`,
      [passwordHash, tokenHash, token]
    );
    if (result.rows.length === 0) {
      return res.status(410).json({ error: "Este link de recupera\xE7\xE3o expirou ou j\xE1 foi utilizado." });
    }
    return res.json({ message: "Senha atualizada com sucesso!" });
  } catch (error) {
    console.error("Erro ao redefinir senha com token:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel redefinir a senha." });
  }
});
publicRouter.post("/api/family-invitations/accept", async (req, res) => {
  const { token, name, password } = req.body;
  if (typeof token !== "string" || !token || typeof name !== "string" || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Informe um convite v\xE1lido e os dados de acesso solicitados." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invitationResult = await client.query(
      `SELECT token_hash, family_id, email, permissions, invited_by
       FROM family_invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashInvitationToken(token)]
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "Este convite expirou ou j\xE1 foi utilizado." });
    }
    const existingUserResult = await client.query(
      "SELECT id, name, email, password_hash, family_id, avatar_url FROM users WHERE LOWER(email) = $1 FOR UPDATE",
      [invitation.email]
    );
    let user = existingUserResult.rows[0];
    if (user) {
      if (user.family_id && String(user.family_id) !== String(invitation.family_id)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Esta conta j\xE1 est\xE1 vinculada a outra fam\xEDlia e n\xE3o pode ser transferida." });
      }
      if (!user.password_hash) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Esta conta foi criada com Google. Use \u201CContinuar com Google\u201D para aceitar o convite." });
      }
      if (!await import_bcrypt.default.compare(password, user.password_hash)) {
        await client.query("ROLLBACK");
        return res.status(401).json({ error: "A senha informada n\xE3o corresponde \xE0 conta existente." });
      }
      const existingMembership = await client.query(
        "SELECT family_id FROM family_members WHERE user_id = $1 FOR UPDATE",
        [String(user.id)]
      );
      if (existingMembership.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Esta conta j\xE1 est\xE1 vinculada a uma fam\xEDlia." });
      }
      if (!user.family_id) {
        const updatedUser = await client.query(
          "UPDATE users SET family_id = $1 WHERE id = $2 RETURNING id, name, email, family_id, avatar_url",
          [invitation.family_id, user.id]
        );
        user = updatedUser.rows[0];
      }
    } else {
      if (!name.trim() || password.length < 8) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Informe seu nome e uma senha com pelo menos 8 caracteres." });
      }
      const passwordHash = await import_bcrypt.default.hash(password, 10);
      const userResult = await client.query(
        `INSERT INTO users (name, email, password_hash, family_id, email_verified)
          VALUES ($1, $2, $3, $4, TRUE)
          RETURNING id, name, email, family_id, avatar_url`,
        [name.trim(), invitation.email, passwordHash, invitation.family_id]
      );
      user = userResult.rows[0];
    }
    await client.query(
      `INSERT INTO family_members (family_id, user_id, role, permissions, invited_by)
       VALUES ($1, $2, 'MEMBER', $3::jsonb, $4)`,
      [String(invitation.family_id), String(user.id), JSON.stringify(invitation.permissions), String(invitation.invited_by)]
    );
    await client.query(
      "UPDATE family_invitations SET accepted_at = NOW() WHERE token_hash = $1",
      [invitation.token_hash]
    );
    await client.query("COMMIT");
    const authToken = import_jsonwebtoken2.default.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET2,
      { expiresIn: "7d" }
    );
    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(201).json({ token: authToken, user: safeUser });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({ error: "Este e-mail j\xE1 est\xE1 vinculado a uma conta ou fam\xEDlia." });
    }
    console.error("Erro ao aceitar convite familiar:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel aceitar o convite." });
  } finally {
    client.release();
  }
});
publicRouter.get("/api/family-invitations/preview", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) return res.status(400).json({ error: "Token do convite n\xE3o informado." });
  try {
    const result = await pool.query(
      `SELECT i.email, i.expires_at, f.name AS family_name,
              (u.id IS NOT NULL) AS has_account,
              (u.password_hash IS NOT NULL) AS has_password
       FROM family_invitations i
       JOIN families f ON f.id::text = i.family_id
       LEFT JOIN users u ON LOWER(u.email) = i.email
       WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW()`,
      [hashInvitationToken(token)]
    );
    if (result.rows.length === 0) {
      return res.status(410).json({ error: "Este convite expirou ou j\xE1 foi utilizado." });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Erro ao consultar convite familiar:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel validar o convite." });
  }
});
router.get("/api/family/access", async (req, res) => {
  const access = req.familyAccess;
  try {
    const [settingsResult, familyResult] = await Promise.all([
      pool.query(
        `SELECT key, value FROM system_settings WHERE key IN ('global_broadcast_message', 'global_broadcast_type', 'tenant_support_phone')`
      ),
      pool.query(
        `SELECT f.name,
                f.registered_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at
         FROM families f
         WHERE f.id::text = $1`,
        [String(access.familyId)]
      )
    ]);
    const settingsMap = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));
    const familyRow = familyResult.rows[0];
    return res.json({
      familyId: access.familyId,
      role: access.role,
      permissions: access.role === "OWNER" ? Object.fromEntries(FAMILY_PERMISSIONS.map((permission) => [permission, true])) : access.permissions,
      broadcast: {
        message: settingsMap.global_broadcast_message || "",
        type: settingsMap.global_broadcast_type || "INFO"
      },
      subscription: {
        familyName: familyRow?.name || "Fam\xEDlia",
        planType: familyRow?.plan_type || "TRIAL",
        registeredAt: familyRow?.registered_at || null,
        trialEndsAt: familyRow?.trial_ends_at || null,
        subscriptionEndsAt: familyRow?.subscription_ends_at || null,
        contactPhone: settingsMap.tenant_support_phone || "(41) 0000-0000"
      }
    });
  } catch {
    return res.json({
      familyId: access.familyId,
      role: access.role,
      permissions: access.role === "OWNER" ? Object.fromEntries(FAMILY_PERMISSIONS.map((permission) => [permission, true])) : access.permissions,
      broadcast: { message: "", type: "INFO" }
    });
  }
});
router.get("/api/family/bootstrap", async (req, res) => {
  const access = req.familyAccess;
  const familyIdStr = String(access.familyId);
  const canRead = access.role === "OWNER" || access.permissions?.family_read === true;
  try {
    const [
      settingsResult,
      familyResult,
      profileResult,
      accountsResult,
      categoriesResult,
      creditCardsResult,
      transactionsResult
    ] = await Promise.all([
      pool.query(
        `SELECT key, value FROM system_settings WHERE key IN ('global_broadcast_message', 'global_broadcast_type', 'tenant_support_phone')`
      ),
      pool.query(
        `SELECT f.name,
                f.registered_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at
         FROM families f
         WHERE f.id::text = $1`,
        [familyIdStr]
      ),
      pool.query(
        `SELECT id, name, email, avatar_url, phone, birth_date, bio,
                (password_hash IS NOT NULL) AS has_password
         FROM users WHERE id::text = $1`,
        [access.userId]
      ),
      canRead ? pool.query(
        `SELECT id, name, bank_name, agency, account_number, pix_key, initial_balance, balance
             FROM accounts
             WHERE family_id::text = $1
             ORDER BY name ASC`,
        [familyIdStr]
      ) : Promise.resolve({ rows: [] }),
      canRead ? pool.query(
        `SELECT c.*, COUNT(t.id)::int AS transaction_count
             FROM categories c
             LEFT JOIN transactions t ON t.category_id = c.id
             WHERE c.family_id::text = $1
             GROUP BY c.id
             ORDER BY c.name ASC`,
        [familyIdStr]
      ) : Promise.resolve({ rows: [] }),
      canRead ? pool.query(
        `SELECT * FROM credit_cards WHERE family_id::text = $1 ORDER BY name ASC`,
        [familyIdStr]
      ) : Promise.resolve({ rows: [] }),
      canRead ? pool.query(
        `SELECT t.*, c.name AS category_name, a.name AS account_name, cc.name AS credit_card_name
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id
             LEFT JOIN accounts a ON t.account_id = a.id
             LEFT JOIN credit_cards cc ON t.credit_card_id = cc.id
             WHERE t.family_id::text = $1
             ORDER BY t.due_date DESC`,
        [familyIdStr]
      ) : Promise.resolve({ rows: [] })
    ]);
    const settingsMap = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));
    const familyRow = familyResult.rows[0];
    let categories = categoriesResult.rows;
    if (canRead && !categories.some((c) => String(c.name || "").toLowerCase() === "investimento")) {
      try {
        const invRes = await pool.query(
          `INSERT INTO categories (family_id, name, flow_type)
           VALUES ($1, 'Investimento', 'EXPENSE')
           RETURNING *`,
          [familyIdStr]
        );
        if (invRes.rows[0]) {
          categories = [...categories, { ...invRes.rows[0], transaction_count: 0 }].sort(
            (a, b) => String(a.name).localeCompare(String(b.name), "pt-BR")
          );
        }
      } catch {
      }
    }
    return res.json({
      access: {
        familyId: access.familyId,
        role: access.role,
        permissions: access.role === "OWNER" ? Object.fromEntries(FAMILY_PERMISSIONS.map((permission) => [permission, true])) : access.permissions,
        broadcast: {
          message: settingsMap.global_broadcast_message || "",
          type: settingsMap.global_broadcast_type || "INFO"
        },
        subscription: {
          familyName: familyRow?.name || "Fam\xEDlia",
          planType: familyRow?.plan_type || "TRIAL",
          registeredAt: familyRow?.registered_at || null,
          trialEndsAt: familyRow?.trial_ends_at || null,
          subscriptionEndsAt: familyRow?.subscription_ends_at || null,
          contactPhone: settingsMap.tenant_support_phone || "(41) 0000-0000"
        }
      },
      profile: profileResult.rows[0] || null,
      accounts: accountsResult.rows,
      categories,
      creditCards: creditCardsResult.rows,
      transactions: transactionsResult.rows
    });
  } catch (error) {
    console.error("Erro no bootstrap do dashboard:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel carregar os dados iniciais da fam\xEDlia." });
  }
});
router.get("/api/internal/tenants", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    const [tenantsResult, settingsResult, leadsResult] = await Promise.all([
      pool.query(
        `SELECT f.id,
                f.name,
                f.registered_at,
                f.blocked_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at,
                COALESCE(f.admin_notes, '') AS admin_notes,
                u.id AS owner_id,
                u.name AS owner_name,
                u.email AS owner_email,
                u.phone AS owner_phone,
                (SELECT COUNT(*)::int FROM family_members fm2 WHERE fm2.family_id = f.id::text) AS members_count,
                (SELECT COUNT(*)::int FROM accounts a WHERE a.family_id::text = f.id::text) AS accounts_count,
                (SELECT COUNT(*)::int FROM credit_cards cc WHERE cc.family_id::text = f.id::text) AS cards_count,
                (SELECT COUNT(*)::int FROM transactions t WHERE t.family_id::text = f.id::text) AS transactions_count,
                (SELECT MAX(t.transaction_date)::text FROM transactions t WHERE t.family_id::text = f.id::text) AS last_transaction_date
         FROM families f
         LEFT JOIN family_members fm
           ON fm.family_id = f.id::text AND fm.role = 'OWNER'
         LEFT JOIN users u ON u.id::text = fm.user_id
         ORDER BY f.registered_at DESC NULLS LAST, f.id DESC`
      ),
      pool.query(
        `SELECT key, value FROM system_settings WHERE key IN ('tenant_support_phone', 'global_broadcast_message', 'global_broadcast_type')`
      ),
      pool.query(
        `SELECT ml.id,
                ml.name,
                ml.email,
                ml.whatsapp,
                ml.source,
                ml.status,
                COALESCE(ml.notes, '') AS notes,
                ml.download_count,
                ml.created_at,
                ml.updated_at,
                u.id AS matched_user_id,
                f.id AS matched_family_id,
                f.name AS matched_family_name,
                COALESCE(f.plan_type, 'TRIAL') AS matched_plan_type
         FROM marketing_leads ml
         LEFT JOIN users u ON LOWER(u.email) = LOWER(ml.email)
         LEFT JOIN families f ON f.id::text = u.family_id::text
         ORDER BY ml.created_at DESC`
      )
    ]);
    const settingsMap = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));
    return res.json({
      tenants: tenantsResult.rows,
      leads: leadsResult.rows,
      contactPhone: settingsMap.tenant_support_phone || "(41) 0000-0000",
      broadcastMessage: settingsMap.global_broadcast_message || "",
      broadcastType: settingsMap.global_broadcast_type || "INFO"
    });
  } catch (error) {
    console.error("Erro ao carregar relat\xF3rio interno de tenants:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel carregar o relat\xF3rio interno." });
  }
});
router.patch("/api/internal/leads/:leadId", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    const leadId = String(req.params.leadId);
    const rawStatus = typeof req.body?.status === "string" ? req.body.status.toUpperCase() : void 0;
    const status = rawStatus && VALID_LEAD_STATUSES.includes(rawStatus) ? rawStatus : void 0;
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 1e3) : void 0;
    const result = await pool.query(
      `UPDATE marketing_leads
       SET status = COALESCE($1, status),
           notes = COALESCE($2, notes),
           updated_at = NOW()
       WHERE id::text = $3
       RETURNING id, name, email, whatsapp, source, status, COALESCE(notes, '') AS notes, download_count, created_at, updated_at`,
      [status ?? null, notes ?? null, leadId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Lead n\xE3o encontrado." });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Erro ao atualizar lead comercial:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel atualizar o lead." });
  }
});
router.delete("/api/internal/leads/:leadId", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    const leadId = String(req.params.leadId);
    const result = await pool.query(
      `DELETE FROM marketing_leads WHERE id::text = $1 RETURNING id`,
      [leadId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Lead n\xE3o encontrado." });
    }
    return res.json({ message: "Lead removido." });
  } catch (error) {
    console.error("Erro ao excluir lead comercial:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel excluir o lead." });
  }
});
router.put("/api/internal/contact-phone", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    const contactPhone = typeof req.body?.contact_phone === "string" ? req.body.contact_phone.trim() : "";
    const digitCount = contactPhone.replace(/\D/g, "").length;
    if (!/^[\d+().\-\s]{8,30}$/.test(contactPhone) || digitCount < 8) {
      return res.status(400).json({ error: "Informe um telefone v\xE1lido com pelo menos 8 d\xEDgitos." });
    }
    const result = await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('tenant_support_phone', $1, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING value`,
      [contactPhone]
    );
    return res.json({ contactPhone: result.rows[0].value });
  } catch (error) {
    console.error("Erro ao atualizar o telefone de contato interno:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel salvar o telefone de contato." });
  }
});
router.put("/api/internal/broadcast", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const rawType = typeof req.body?.type === "string" ? req.body.type.toUpperCase() : "INFO";
    const type = VALID_BROADCAST_TYPES.includes(rawType) ? rawType : "INFO";
    if (message.length > 400) {
      return res.status(400).json({ error: "O comunicado deve ter at\xE9 400 caracteres." });
    }
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('global_broadcast_message', $1, NOW()),
              ('global_broadcast_type', $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [message, type]
    );
    return res.json({ broadcastMessage: message, broadcastType: type });
  } catch (error) {
    console.error("Erro ao salvar comunicado global:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel salvar o comunicado global." });
  }
});
router.patch("/api/internal/tenants/:familyId/status", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    if (typeof req.body?.blocked !== "boolean") {
      return res.status(400).json({ error: "Informe se o tenant deve ser bloqueado ou desbloqueado." });
    }
    const result = await pool.query(
      `UPDATE families f
       SET blocked_at = CASE
         WHEN $2::boolean THEN COALESCE(f.blocked_at, NOW())
         ELSE NULL
       END
       WHERE f.id::text = $1
         AND NOT EXISTS (
           SELECT 1
           FROM family_members fm
           JOIN users u ON u.id::text = fm.user_id
           WHERE fm.family_id = f.id::text
             AND fm.role = 'OWNER'
             AND LOWER(u.email) = $3
         )
       RETURNING f.id, f.blocked_at`,
      [req.params.familyId, req.body.blocked, INTERNAL_ADMIN_EMAIL]
    );
    if (result.rows.length === 0) {
      const familyExists = await pool.query(
        "SELECT 1 FROM families WHERE id::text = $1",
        [req.params.familyId]
      );
      return familyExists.rows.length ? res.status(403).json({ error: "O tenant da conta administrativa n\xE3o pode ser bloqueado." }) : res.status(404).json({ error: "Tenant n\xE3o encontrado." });
    }
    invalidateAuthMembershipCache();
    return res.json({
      id: result.rows[0].id,
      blocked_at: result.rows[0].blocked_at
    });
  } catch (error) {
    console.error("Erro ao alterar o acesso do tenant:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel alterar o acesso do tenant." });
  }
});
router.patch("/api/internal/tenants/:familyId/commercial", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    const familyId = String(req.params.familyId);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentRes = await client.query(
        `SELECT f.id,
                f.registered_at,
                f.blocked_at,
                COALESCE(f.plan_type, 'TRIAL') AS plan_type,
                COALESCE(f.trial_ends_at, f.registered_at + INTERVAL '10 days', NOW() + INTERVAL '10 days') AS trial_ends_at,
                f.subscription_ends_at::text AS subscription_ends_at,
                COALESCE(f.admin_notes, '') AS admin_notes,
                u.id AS owner_id,
                u.phone AS owner_phone
         FROM families f
         LEFT JOIN family_members fm ON fm.family_id = f.id::text AND fm.role = 'OWNER'
         LEFT JOIN users u ON u.id::text = fm.user_id
         WHERE f.id::text = $1
         FOR UPDATE OF f`,
        [familyId]
      );
      const current = currentRes.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Tenant n\xE3o encontrado." });
      }
      let nextPlanType = current.plan_type;
      if (typeof body.plan_type === "string" && VALID_PLAN_TYPES.includes(body.plan_type)) {
        nextPlanType = body.plan_type;
      }
      let nextTrialEndsAt = current.trial_ends_at;
      if (typeof body.extend_trial_days === "number" && Number.isFinite(body.extend_trial_days)) {
        const baseTime = Math.max(Date.now(), new Date(current.trial_ends_at).getTime());
        nextTrialEndsAt = new Date(baseTime + body.extend_trial_days * 24 * 60 * 60 * 1e3).toISOString();
      } else if (typeof body.trial_ends_at === "string" && body.trial_ends_at.trim()) {
        const parsedTrial = new Date(body.trial_ends_at);
        if (Number.isNaN(parsedTrial.getTime())) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Data de t\xE9rmino do teste inv\xE1lida." });
        }
        nextTrialEndsAt = parsedTrial.toISOString();
      }
      let nextSubscriptionEndsAt = current.subscription_ends_at;
      if (body.subscription_ends_at === null || body.subscription_ends_at === "") {
        nextSubscriptionEndsAt = null;
      } else if (typeof body.subscription_ends_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.subscription_ends_at)) {
        nextSubscriptionEndsAt = body.subscription_ends_at;
      }
      if (body.activate_cycle === "MONTHLY" || body.activate_cycle === "ANNUAL") {
        nextPlanType = body.activate_cycle;
        const baseDate = nextSubscriptionEndsAt && (/* @__PURE__ */ new Date(`${nextSubscriptionEndsAt}T00:00:00Z`)).getTime() > Date.now() ? /* @__PURE__ */ new Date(`${nextSubscriptionEndsAt}T00:00:00Z`) : /* @__PURE__ */ new Date();
        if (body.activate_cycle === "MONTHLY") {
          baseDate.setUTCMonth(baseDate.getUTCMonth() + 1);
        } else {
          baseDate.setUTCFullYear(baseDate.getUTCFullYear() + 1);
        }
        nextSubscriptionEndsAt = baseDate.toISOString().slice(0, 10);
      }
      const nextAdminNotes = typeof body.admin_notes === "string" ? body.admin_notes.trim().slice(0, 1e3) : current.admin_notes;
      const unblockOnActivate = Boolean(body.activate_cycle);
      const updatedFamilyRes = await client.query(
        `UPDATE families
         SET plan_type = $1,
             trial_ends_at = $2,
             subscription_ends_at = $3,
             admin_notes = $4,
             blocked_at = CASE WHEN $5::boolean THEN NULL ELSE blocked_at END
         WHERE id::text = $6
         RETURNING id,
                   plan_type,
                   trial_ends_at,
                   subscription_ends_at::text AS subscription_ends_at,
                   COALESCE(admin_notes, '') AS admin_notes,
                   blocked_at`,
        [nextPlanType, nextTrialEndsAt, nextSubscriptionEndsAt, nextAdminNotes, unblockOnActivate, familyId]
      );
      let nextOwnerPhone = current.owner_phone || null;
      if (typeof body.owner_phone === "string" && current.owner_id) {
        const cleanPhone = body.owner_phone.trim().slice(0, 30);
        const phoneRes = await client.query(
          `UPDATE users SET phone = $1 WHERE id::text = $2 RETURNING phone`,
          [cleanPhone || null, String(current.owner_id)]
        );
        nextOwnerPhone = phoneRes.rows[0]?.phone || null;
      }
      await client.query("COMMIT");
      invalidateAuthMembershipCache();
      return res.json({
        ...updatedFamilyRes.rows[0],
        owner_phone: nextOwnerPhone
      });
    } catch (txError) {
      await client.query("ROLLBACK");
      throw txError;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Erro ao atualizar dados comerciais do tenant:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel salvar os dados comerciais do tenant." });
  }
});
router.post("/api/internal/tenants/:familyId/reset-password", async (req, res) => {
  try {
    if (!await isInternalAdmin(req.familyAccess.userId)) {
      return res.status(403).json({ error: "Acesso n\xE3o autorizado." });
    }
    const familyId = String(req.params.familyId);
    const newPassword = typeof req.body?.new_password === "string" ? req.body.new_password.trim() : "";
    if (newPassword.length < 6 || newPassword.length > 64) {
      return res.status(400).json({ error: "A senha tempor\xE1ria deve ter entre 6 e 64 caracteres." });
    }
    const ownerResult = await pool.query(
      `SELECT u.id, u.email, u.name
       FROM family_members fm
       JOIN users u ON u.id::text = fm.user_id
       WHERE fm.family_id = $1 AND fm.role = 'OWNER'
       LIMIT 1`,
      [familyId]
    );
    const owner = ownerResult.rows[0];
    if (!owner) {
      return res.status(404).json({ error: "Respons\xE1vel pela fam\xEDlia n\xE3o encontrado." });
    }
    const passwordHash = await import_bcrypt.default.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id::text = $2`,
      [passwordHash, String(owner.id)]
    );
    return res.json({
      message: `Senha redefinida com sucesso para ${owner.email}.`,
      owner_email: owner.email
    });
  } catch (error) {
    console.error("Erro ao redefinir senha administrativa do tenant:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel redefinir a senha do respons\xE1vel." });
  }
});
router.get("/api/family/profile", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, avatar_url, phone, birth_date, bio,
              (password_hash IS NOT NULL) AS has_password
       FROM users WHERE id::text = $1`,
      [req.familyAccess.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Perfil do usu\xE1rio n\xE3o encontrado." });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Erro ao carregar perfil do usu\xE1rio:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel carregar seu perfil." });
  }
});
router.put("/api/family/password", async (req, res) => {
  const currentPassword = typeof req.body?.current_password === "string" ? req.body.current_password : "";
  const newPassword = typeof req.body?.new_password === "string" ? req.body.new_password : "";
  if (newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: "A nova senha deve ter entre 6 e 64 caracteres." });
  }
  try {
    const userRes = await pool.query(
      "SELECT id, password_hash FROM users WHERE id::text = $1",
      [req.familyAccess.userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: "Usu\xE1rio n\xE3o encontrado." });
    }
    if (user.password_hash) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Informe sua senha atual para confirmar a altera\xE7\xE3o." });
      }
      const matches = await import_bcrypt.default.compare(currentPassword, user.password_hash);
      if (!matches) {
        return res.status(401).json({ error: "A senha atual informada est\xE1 incorreta." });
      }
    }
    const nextHash = await import_bcrypt.default.hash(newPassword, 10);
    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id::text = $2",
      [nextHash, req.familyAccess.userId]
    );
    return res.json({
      message: user.password_hash ? "Sua senha foi alterada com sucesso!" : "Senha de acesso criada com sucesso! Agora voc\xEA tamb\xE9m pode entrar com e-mail e senha.",
      has_password: true
    });
  } catch (error) {
    console.error("Erro ao atualizar senha do perfil:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel atualizar sua senha agora." });
  }
});
router.put("/api/family/profile", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const optionalFields = ["phone", "avatar_url", "birth_date", "bio"];
  if (optionalFields.some((field) => body[field] !== void 0 && typeof body[field] !== "string")) {
    return res.status(400).json({ error: "Os campos do perfil devem ser enviados como texto." });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const avatarUrl = typeof body.avatar_url === "string" ? body.avatar_url.trim() : "";
  const birthDate = typeof body.birth_date === "string" ? body.birth_date.trim() : "";
  const bio = typeof body.bio === "string" ? body.bio.trim() : "";
  if (!name || name.length > 100) {
    return res.status(400).json({ error: "O nome de exibi\xE7\xE3o \xE9 obrigat\xF3rio e deve ter at\xE9 100 caracteres." });
  }
  if (phone.length > 30) {
    return res.status(400).json({ error: "O telefone deve ter at\xE9 30 caracteres." });
  }
  if (avatarUrl.length > 2048) {
    return res.status(400).json({ error: "O endere\xE7o da foto deve ter at\xE9 2048 caracteres." });
  }
  if (avatarUrl) {
    try {
      const parsedAvatarUrl = new URL(avatarUrl);
      if (parsedAvatarUrl.protocol !== "https:") throw new Error("Unsupported protocol");
    } catch {
      return res.status(400).json({ error: "Informe um endere\xE7o HTTPS v\xE1lido para a foto de perfil." });
    }
  }
  if (birthDate) {
    const parsedBirthDate = /* @__PURE__ */ new Date(`${birthDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(parsedBirthDate.getTime()) || parsedBirthDate.toISOString().slice(0, 10) !== birthDate || parsedBirthDate.getTime() > Date.now()) {
      return res.status(400).json({ error: "Informe uma data de nascimento v\xE1lida, que n\xE3o seja futura." });
    }
  }
  if (bio.length > 280) {
    return res.status(400).json({ error: "A descri\xE7\xE3o pessoal deve ter at\xE9 280 caracteres." });
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET name = $1, phone = $2, avatar_url = $3, birth_date = $4, bio = $5
       WHERE id::text = $6
       RETURNING id, name, email, avatar_url, phone, birth_date, bio`,
      [
        name,
        phone || null,
        avatarUrl || null,
        birthDate || null,
        bio || null,
        req.familyAccess.userId
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Perfil do usu\xE1rio n\xE3o encontrado." });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Erro ao atualizar perfil do usu\xE1rio:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel salvar as altera\xE7\xF5es do perfil." });
  }
});
router.get("/api/family/members", requireFamilyPermission("members_manage"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.avatar_url, fm.role, fm.permissions, fm.created_at
       FROM family_members fm
       JOIN users u ON u.id::text = fm.user_id
       WHERE fm.family_id = $1
       ORDER BY CASE WHEN fm.role = 'OWNER' THEN 0 ELSE 1 END, u.name ASC`,
      [req.familyAccess.familyId]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("Erro ao carregar membros da fam\xEDlia:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel carregar os membros da fam\xEDlia." });
  }
});
router.get("/api/family/invitations", requireFamilyPermission("members_manage"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT email, created_at, expires_at
       FROM family_invitations
       WHERE family_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.familyAccess.familyId]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error("Erro ao carregar convites familiares:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel carregar os convites." });
  }
});
router.post("/api/family/invitations", requireFamilyPermission("members_manage"), async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const requestedPermissions = req.body.permissions;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !requestedPermissions || typeof requestedPermissions !== "object") {
    return res.status(400).json({ error: "Informe um e-mail v\xE1lido e as permiss\xF5es para o membro." });
  }
  const permissions = Object.fromEntries(
    FAMILY_PERMISSIONS.map((permission) => [
      permission,
      permission === "members_manage" ? false : requestedPermissions[permission] === true
    ])
  );
  const access = req.familyAccess;
  const { token, tokenHash } = createInvitationToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingMember = await client.query(
      `SELECT 1 FROM family_members fm JOIN users u ON u.id::text = fm.user_id
       WHERE fm.family_id = $1 AND LOWER(u.email) = $2`,
      [access.familyId, email]
    );
    if (existingMember.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Este e-mail j\xE1 pertence a um membro da fam\xEDlia." });
    }
    const existingUser = await client.query(
      "SELECT family_id FROM users WHERE LOWER(email) = $1",
      [email]
    );
    if (existingUser.rows.length > 0 && existingUser.rows[0].family_id && String(existingUser.rows[0].family_id) !== String(access.familyId)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Este e-mail j\xE1 est\xE1 vinculado a outra fam\xEDlia e n\xE3o pode ser transferido." });
    }
    await client.query(
      `DELETE FROM family_invitations
       WHERE family_id = $1 AND email = $2 AND accepted_at IS NULL`,
      [access.familyId, email]
    );
    const result = await client.query(
      `INSERT INTO family_invitations
         (token_hash, family_id, email, permissions, invited_by, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW() + INTERVAL '7 days')
       RETURNING email, expires_at`,
      [tokenHash, access.familyId, email, JSON.stringify(permissions), access.userId]
    );
    await client.query("COMMIT");
    return res.status(201).json({ ...result.rows[0], token });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Erro ao criar convite familiar:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel criar o convite." });
  } finally {
    client.release();
  }
});
router.put("/api/family/members/:userId/permissions", requireFamilyPermission("members_manage"), async (req, res) => {
  const userId = String(req.params.userId);
  const requestedPermissions = req.body.permissions;
  if (!requestedPermissions || typeof requestedPermissions !== "object") {
    return res.status(400).json({ error: "Informe as permiss\xF5es do membro." });
  }
  const permissions = Object.fromEntries(
    FAMILY_PERMISSIONS.map((permission) => [
      permission,
      permission === "members_manage" ? false : requestedPermissions[permission] === true
    ])
  );
  try {
    const result = await pool.query(
      `UPDATE family_members SET permissions = $1::jsonb
       WHERE family_id = $2 AND user_id = $3 AND role = 'MEMBER'
       RETURNING user_id`,
      [JSON.stringify(permissions), req.familyAccess.familyId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Membro n\xE3o encontrado ou sem permiss\xE3o para editar." });
    }
    invalidateAuthMembershipCache(userId);
    return res.json({ message: "Permiss\xF5es atualizadas." });
  } catch (error) {
    console.error("Erro ao atualizar permiss\xF5es do membro:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel atualizar as permiss\xF5es." });
  }
});
router.delete("/api/family/invitations/:email", requireFamilyPermission("members_manage"), async (req, res) => {
  const email = String(req.params.email).trim().toLowerCase();
  try {
    const result = await pool.query(
      `DELETE FROM family_invitations
       WHERE family_id = $1 AND email = $2 AND accepted_at IS NULL
       RETURNING email`,
      [req.familyAccess.familyId, email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Convite pendente n\xE3o encontrado." });
    }
    return res.json({ message: "Convite revogado." });
  } catch (error) {
    console.error("Erro ao revogar convite familiar:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel revogar o convite." });
  }
});
router.delete("/api/family/members/:userId", requireFamilyPermission("members_manage"), async (req, res) => {
  const userId = String(req.params.userId);
  try {
    const result = await pool.query(
      `DELETE FROM family_members
       WHERE family_id = $1 AND user_id = $2 AND role = 'MEMBER'
       RETURNING user_id`,
      [req.familyAccess.familyId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Membro n\xE3o encontrado ou n\xE3o pode ser removido." });
    }
    invalidateAuthMembershipCache(userId);
    return res.json({ message: "Membro removido da fam\xEDlia." });
  } catch (error) {
    console.error("Erro ao remover membro da fam\xEDlia:", error);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel remover o membro." });
  }
});
var familyRoutes_default = router;

// src/annualProvisions.ts
var import_express2 = require("express");
var router2 = (0, import_express2.Router)();
var EXPENSE_TYPES = ["IPTU", "IPVA", "LICENCIAMENTO", "OTHER"];
function isExpenseType(value) {
  return typeof value === "string" && EXPENSE_TYPES.includes(value);
}
function parseAmount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999e-2) return null;
  const roundedAmount = Math.round(amount * 100) / 100;
  return roundedAmount > 0 ? roundedAmount : null;
}
function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function addYearsToDate(dateValue, years) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
function validateProvisionInput(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const targetAmount = parseAmount(body.target_amount);
  if (!title || title.length > 120) {
    return { error: "Informe uma descri\xE7\xE3o de at\xE9 120 caracteres." };
  }
  if (!isExpenseType(body.expense_type)) {
    return { error: "Selecione um tipo de despesa anual v\xE1lido." };
  }
  if (targetAmount === null) {
    return { error: "Informe um valor estimado maior que zero." };
  }
  if (!isValidDate(body.due_date)) {
    return { error: "Informe uma data de vencimento v\xE1lida." };
  }
  return {
    value: {
      title,
      expenseType: body.expense_type,
      targetAmount,
      dueDate: body.due_date
    }
  };
}
router2.get(
  "/",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT p.id, p.title, p.expense_type, p.target_amount, p.saved_amount,
                TO_CHAR(p.due_date, 'YYYY-MM-DD') AS due_date, p.status,
                p.actual_amount, TO_CHAR(p.paid_date, 'YYYY-MM-DD') AS paid_date,
                p.renewed_from_id, child.id AS renewed_provision_id, p.created_at,
                COALESCE(
                  JSON_AGG(
                    JSON_BUILD_OBJECT(
                      'id', c.id,
                      'amount', c.amount,
                      'contribution_date', TO_CHAR(c.contribution_date, 'YYYY-MM-DD'),
                      'created_at', c.created_at
                    ) ORDER BY c.contribution_date DESC, c.id DESC
                  ) FILTER (WHERE c.id IS NOT NULL),
                  '[]'::json
                ) AS contributions
         FROM annual_provisions p
         LEFT JOIN annual_provisions child ON child.renewed_from_id = p.id
         LEFT JOIN annual_provision_contributions c ON c.provision_id = p.id
         WHERE p.family_id = $1
         GROUP BY p.id, child.id
         ORDER BY p.status ASC, p.due_date ASC, p.created_at DESC`,
        [req.familyAccess.familyId]
      );
      return res.json(result.rows);
    } catch (error) {
      console.error("Erro ao carregar provis\xF5es anuais:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel carregar as provis\xF5es anuais." });
    }
  }
);
router2.post(
  "/",
  requireFamilyPermission("provisions_manage"),
  async (req, res) => {
    const validation = validateProvisionInput(req.body ?? {});
    if ("error" in validation) return res.status(400).json({ error: validation.error });
    try {
      const result = await pool.query(
        `INSERT INTO annual_provisions
           (family_id, title, expense_type, target_amount, due_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, paid_date, renewed_from_id, created_at`,
        [
          req.familyAccess.familyId,
          validation.value.title,
          validation.value.expenseType,
          validation.value.targetAmount,
          validation.value.dueDate
        ]
      );
      return res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error("Erro ao criar provis\xE3o anual:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel criar a provis\xE3o anual." });
    }
  }
);
router2.put(
  "/:id",
  requireFamilyPermission("provisions_manage"),
  async (req, res) => {
    const validation = validateProvisionInput(req.body ?? {});
    if ("error" in validation) return res.status(400).json({ error: validation.error });
    try {
      const result = await pool.query(
        `UPDATE annual_provisions
         SET title = $1, expense_type = $2, target_amount = $3, due_date = $4,
             updated_at = NOW()
         WHERE id = $5 AND family_id = $6 AND status = 'ACTIVE'
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, paid_date, renewed_from_id, created_at`,
        [
          validation.value.title,
          validation.value.expenseType,
          validation.value.targetAmount,
          validation.value.dueDate,
          req.params.id,
          req.familyAccess.familyId
        ]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Provis\xE3o ativa n\xE3o encontrada." });
      }
      return res.json(result.rows[0]);
    } catch (error) {
      console.error("Erro ao atualizar provis\xE3o anual:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel atualizar a provis\xE3o anual." });
    }
  }
);
router2.post(
  "/:id/contributions",
  requireFamilyPermission("provisions_manage"),
  async (req, res) => {
    const amount = parseAmount(req.body?.amount);
    const contributionDate = req.body?.contribution_date;
    if (amount === null) {
      return res.status(400).json({ error: "Informe um valor reservado maior que zero." });
    }
    if (!isValidDate(contributionDate)) {
      return res.status(400).json({ error: "Informe uma data v\xE1lida para a reserva." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const provision = await client.query(
        `SELECT id FROM annual_provisions
         WHERE id = $1 AND family_id = $2 AND status = 'ACTIVE'
         FOR UPDATE`,
        [req.params.id, req.familyAccess.familyId]
      );
      if (provision.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Provis\xE3o ativa n\xE3o encontrada." });
      }
      const contribution = await client.query(
        `INSERT INTO annual_provision_contributions
           (provision_id, family_id, amount, contribution_date, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, amount, TO_CHAR(contribution_date, 'YYYY-MM-DD') AS contribution_date`,
        [
          provision.rows[0].id,
          req.familyAccess.familyId,
          amount,
          contributionDate,
          req.familyAccess.userId
        ]
      );
      await client.query(
        `UPDATE annual_provisions
         SET saved_amount = saved_amount + $1, updated_at = NOW()
         WHERE id = $2 AND family_id = $3`,
        [amount, provision.rows[0].id, req.familyAccess.familyId]
      );
      await client.query("COMMIT");
      return res.status(201).json(contribution.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Erro ao registrar valor reservado:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel registrar o valor reservado." });
    } finally {
      client.release();
    }
  }
);
router2.delete(
  "/:id/contributions/:contributionId",
  requireFamilyPermission("provisions_manage"),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const provision = await client.query(
        `SELECT id FROM annual_provisions
         WHERE id = $1 AND family_id = $2 AND status = 'ACTIVE'
         FOR UPDATE`,
        [req.params.id, req.familyAccess.familyId]
      );
      if (provision.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Provis\xE3o ativa n\xE3o encontrada." });
      }
      const deleted = await client.query(
        `DELETE FROM annual_provision_contributions
         WHERE id = $1 AND provision_id = $2 AND family_id = $3
         RETURNING id, amount`,
        [req.params.contributionId, req.params.id, req.familyAccess.familyId]
      );
      if (deleted.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Registro de reserva n\xE3o encontrado." });
      }
      await client.query(
        `UPDATE annual_provisions
         SET saved_amount = GREATEST(0, saved_amount - $1), updated_at = NOW()
         WHERE id = $2 AND family_id = $3`,
        [deleted.rows[0].amount, req.params.id, req.familyAccess.familyId]
      );
      await client.query("COMMIT");
      return res.json({ message: "Reserva removida com sucesso." });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Erro ao remover valor reservado:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel remover o valor reservado." });
    } finally {
      client.release();
    }
  }
);
router2.delete(
  "/:id",
  requireFamilyPermission("provisions_manage"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `DELETE FROM annual_provisions
         WHERE id = $1 AND family_id = $2
         RETURNING id`,
        [req.params.id, req.familyAccess.familyId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Provis\xE3o n\xE3o encontrada." });
      }
      return res.json({ message: "Provis\xE3o exclu\xEDda com sucesso." });
    } catch (error) {
      console.error("Erro ao excluir provis\xE3o anual:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel excluir a provis\xE3o anual." });
    }
  }
);
router2.post(
  "/:id/settle",
  requireFamilyPermission("provisions_manage"),
  async (req, res) => {
    const actualAmount = parseAmount(req.body?.actual_amount);
    const paidDate = req.body?.paid_date ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    if (actualAmount === null) {
      return res.status(400).json({ error: "Informe o valor efetivamente pago, maior que zero." });
    }
    if (!isValidDate(paidDate)) {
      return res.status(400).json({ error: "Informe uma data v\xE1lida para o pagamento." });
    }
    try {
      const result = await pool.query(
        `UPDATE annual_provisions
         SET status = 'PAID', actual_amount = $1, paid_date = $2, updated_at = NOW()
         WHERE id = $3 AND family_id = $4 AND status = 'ACTIVE'
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, TO_CHAR(paid_date, 'YYYY-MM-DD') AS paid_date,
                   renewed_from_id, created_at`,
        [actualAmount, paidDate, req.params.id, req.familyAccess.familyId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Provis\xE3o ativa n\xE3o encontrada." });
      }
      return res.json(result.rows[0]);
    } catch (error) {
      console.error("Erro ao concluir provis\xE3o anual:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel concluir a provis\xE3o anual." });
    }
  }
);
router2.post(
  "/:id/renew",
  requireFamilyPermission("provisions_manage"),
  async (req, res) => {
    const customTargetAmount = req.body?.target_amount !== void 0 && req.body?.target_amount !== null && req.body?.target_amount !== "" ? parseAmount(req.body.target_amount) : void 0;
    if (customTargetAmount === null) {
      return res.status(400).json({ error: "Informe um valor estimado v\xE1lido maior que zero para a renova\xE7\xE3o." });
    }
    const customDueDate = req.body?.due_date !== void 0 && req.body?.due_date !== null && req.body?.due_date !== "" ? req.body.due_date : void 0;
    if (customDueDate !== void 0 && !isValidDate(customDueDate)) {
      return res.status(400).json({ error: "Informe uma data de vencimento v\xE1lida para a renova\xE7\xE3o." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sourceResult = await client.query(
        `SELECT id, family_id, title, expense_type, target_amount, actual_amount,
                TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status
         FROM annual_provisions
         WHERE id = $1 AND family_id = $2
         FOR UPDATE`,
        [req.params.id, req.familyAccess.familyId]
      );
      const source = sourceResult.rows[0];
      if (!source) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Provis\xE3o n\xE3o encontrada." });
      }
      if (source.status !== "PAID") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Conclua o pagamento antes de renovar a provis\xE3o." });
      }
      const existingRenewal = await client.query(
        `SELECT id FROM annual_provisions WHERE renewed_from_id = $1`,
        [source.id]
      );
      if (existingRenewal.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Esta provis\xE3o j\xE1 foi renovada." });
      }
      let dueDate = customDueDate ?? addYearsToDate(source.due_date, 1);
      if (customDueDate === void 0) {
        const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        while (dueDate <= today) dueDate = addYearsToDate(dueDate, 1);
      }
      const nextTargetAmount = customTargetAmount ?? source.actual_amount ?? source.target_amount;
      const renewal = await client.query(
        `INSERT INTO annual_provisions
           (family_id, title, expense_type, target_amount, due_date, renewed_from_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, expense_type, target_amount, saved_amount,
                   TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, status,
                   actual_amount, paid_date, renewed_from_id, created_at`,
        [
          source.family_id,
          source.title,
          source.expense_type,
          nextTargetAmount,
          dueDate,
          source.id
        ]
      );
      await client.query("COMMIT");
      return res.status(201).json(renewal.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Erro ao renovar provis\xE3o anual:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel renovar a provis\xE3o anual." });
    } finally {
      client.release();
    }
  }
);
var annualProvisions_default = router2;

// src/shoppingRoutes.ts
var import_express3 = require("express");
var router3 = (0, import_express3.Router)();
var SHOPPING_TEMPLATES = {
  COMPRA_MES: [
    { name: "Arroz 5kg", aisle_category: "Mercearia", quantity: 2, unit: "pct" },
    { name: "Feij\xE3o 1kg", aisle_category: "Mercearia", quantity: 3, unit: "pct" },
    { name: "A\xE7\xFAcar 5kg", aisle_category: "Mercearia", quantity: 1, unit: "pct" },
    { name: "Caf\xE9 500g", aisle_category: "Mercearia", quantity: 2, unit: "pct" },
    { name: "\xD3leo de Soja 900ml", aisle_category: "Mercearia", quantity: 3, unit: "un" },
    { name: "Azeite de Oliva 500ml", aisle_category: "Mercearia", quantity: 1, unit: "un" },
    { name: "Macarr\xE3o 500g", aisle_category: "Mercearia", quantity: 4, unit: "pct" },
    { name: "Molho de Tomate", aisle_category: "Mercearia", quantity: 4, unit: "un" },
    { name: "Farinha de Trigo 1kg", aisle_category: "Mercearia", quantity: 1, unit: "pct" },
    { name: "Sal 1kg", aisle_category: "Mercearia", quantity: 1, unit: "pct" },
    { name: "Leite Integral 1L", aisle_category: "Latic\xEDnios & Padaria", quantity: 12, unit: "un" },
    { name: "Manteiga / Margarina", aisle_category: "Latic\xEDnios & Padaria", quantity: 2, unit: "un" },
    { name: "Queijo Mussarela", aisle_category: "Latic\xEDnios & Padaria", quantity: 0.5, unit: "kg" },
    { name: "Ovos (D\xFAzia/Cartela)", aisle_category: "Hortifr\xFAti", quantity: 2, unit: "cx" },
    { name: "Peito de Frango", aisle_category: "A\xE7ougue & Frios", quantity: 3, unit: "kg" },
    { name: "Carne Mo\xEDda", aisle_category: "A\xE7ougue & Frios", quantity: 2, unit: "kg" },
    { name: "Carne para Bife/Panela", aisle_category: "A\xE7ougue & Frios", quantity: 2, unit: "kg" },
    { name: "Sab\xE3o em P\xF3 / L\xEDquido", aisle_category: "Limpeza", quantity: 1, unit: "un" },
    { name: "Amaciante de Roupas", aisle_category: "Limpeza", quantity: 1, unit: "un" },
    { name: "Detergente Lava-lou\xE7as", aisle_category: "Limpeza", quantity: 4, unit: "un" },
    { name: "\xC1gua Sanit\xE1ria", aisle_category: "Limpeza", quantity: 2, unit: "un" },
    { name: "Desinfetante", aisle_category: "Limpeza", quantity: 2, unit: "un" },
    { name: "Esponja de Lou\xE7a", aisle_category: "Limpeza", quantity: 1, unit: "pct" },
    { name: "Saco de Lixo", aisle_category: "Limpeza", quantity: 2, unit: "pct" },
    { name: "Papel Higi\xEAnico (Fardo)", aisle_category: "Higiene & Farm\xE1cia", quantity: 2, unit: "pct" },
    { name: "Creme Dental", aisle_category: "Higiene & Farm\xE1cia", quantity: 3, unit: "un" },
    { name: "Sabonete", aisle_category: "Higiene & Farm\xE1cia", quantity: 6, unit: "un" },
    { name: "Shampoo / Condicionador", aisle_category: "Higiene & Farm\xE1cia", quantity: 2, unit: "un" }
  ],
  FEIRA: [
    { name: "Banana", aisle_category: "Hortifr\xFAti", quantity: 1.5, unit: "kg" },
    { name: "Ma\xE7\xE3", aisle_category: "Hortifr\xFAti", quantity: 1, unit: "kg" },
    { name: "Laranja / Lim\xE3o", aisle_category: "Hortifr\xFAti", quantity: 2, unit: "kg" },
    { name: "Mam\xE3o / Mel\xE3o", aisle_category: "Hortifr\xFAti", quantity: 1, unit: "un" },
    { name: "Tomate", aisle_category: "Hortifr\xFAti", quantity: 1.5, unit: "kg" },
    { name: "Batata Inglesa", aisle_category: "Hortifr\xFAti", quantity: 2, unit: "kg" },
    { name: "Cebola", aisle_category: "Hortifr\xFAti", quantity: 1, unit: "kg" },
    { name: "Alho", aisle_category: "Hortifr\xFAti", quantity: 0.3, unit: "kg" },
    { name: "Cenoura", aisle_category: "Hortifr\xFAti", quantity: 1, unit: "kg" },
    { name: "Alface / Folhas Verdes", aisle_category: "Hortifr\xFAti", quantity: 2, unit: "un" },
    { name: "Br\xF3colis / Couve-flor", aisle_category: "Hortifr\xFAti", quantity: 1, unit: "un" },
    { name: "Ovos (Cartela)", aisle_category: "Hortifr\xFAti", quantity: 1, unit: "cx" }
  ],
  LIMPEZA: [
    { name: "Sab\xE3o L\xEDquido / P\xF3", aisle_category: "Limpeza", quantity: 2, unit: "un" },
    { name: "Amaciante Concentrado", aisle_category: "Limpeza", quantity: 1, unit: "un" },
    { name: "Detergente Lava-lou\xE7as", aisle_category: "Limpeza", quantity: 6, unit: "un" },
    { name: "Desinfetante", aisle_category: "Limpeza", quantity: 3, unit: "un" },
    { name: "\xC1gua Sanit\xE1ria 2L", aisle_category: "Limpeza", quantity: 2, unit: "un" },
    { name: "Limpador Multiuso", aisle_category: "Limpeza", quantity: 2, unit: "un" },
    { name: "Papel Toalha", aisle_category: "Limpeza", quantity: 2, unit: "pct" },
    { name: "Saco de Lixo 50L/100L", aisle_category: "Limpeza", quantity: 2, unit: "pct" },
    { name: "Papel Higi\xEAnico", aisle_category: "Higiene & Farm\xE1cia", quantity: 2, unit: "pct" },
    { name: "Sabonete", aisle_category: "Higiene & Farm\xE1cia", quantity: 6, unit: "un" },
    { name: "Creme Dental", aisle_category: "Higiene & Farm\xE1cia", quantity: 3, unit: "un" },
    { name: "Desodorante", aisle_category: "Higiene & Farm\xE1cia", quantity: 2, unit: "un" }
  ],
  CHURRASCO: [
    { name: "Picanha / Alcatra / Contrafil\xE9", aisle_category: "A\xE7ougue & Frios", quantity: 2.5, unit: "kg" },
    { name: "Lingui\xE7a Toscana", aisle_category: "A\xE7ougue & Frios", quantity: 1, unit: "kg" },
    { name: "Asinha / Tulipa de Frango", aisle_category: "A\xE7ougue & Frios", quantity: 1, unit: "kg" },
    { name: "P\xE3o de Alho", aisle_category: "Latic\xEDnios & Padaria", quantity: 2, unit: "pct" },
    { name: "Queijo Coalho", aisle_category: "Latic\xEDnios & Padaria", quantity: 1, unit: "pct" },
    { name: "Carv\xE3o 4kg/5kg", aisle_category: "Pet & Outros", quantity: 1, unit: "pct" },
    { name: "Sal Grosso", aisle_category: "Mercearia", quantity: 1, unit: "pct" },
    { name: "Farofa Pronta", aisle_category: "Mercearia", quantity: 1, unit: "pct" },
    { name: "Refrigerante / Suco", aisle_category: "Bebidas", quantity: 4, unit: "un" },
    { name: "Cerveja (Pack)", aisle_category: "Bebidas", quantity: 2, unit: "cx" }
  ]
};
function normalizeItemName(name) {
  return name.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
}
function getCardInvoiceDueDate(transactionDate, closingDay, dueDay) {
  const [y, m, d] = transactionDate.slice(0, 10).split("-").map(Number);
  let targetYear = y;
  let targetMonth = m;
  if (d >= closingDay) {
    targetMonth += 1;
  }
  if (dueDay < closingDay) {
    targetMonth += 1;
  }
  while (targetMonth > 12) {
    targetMonth -= 12;
    targetYear += 1;
  }
  const maxDaysInMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(dueDay, 1), maxDaysInMonth);
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
}
async function ensureSupermarketCategory(client, familyId) {
  const existing = await client.query(
    `SELECT id FROM categories
     WHERE family_id::text = $1
       AND flow_type = 'EXPENSE'
       AND (LOWER(name) LIKE '%mercado%' OR LOWER(name) LIKE '%alimenta%')
     ORDER BY CASE WHEN LOWER(name) LIKE '%mercado%' THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [String(familyId)]
  );
  if (existing.rows.length > 0) {
    return String(existing.rows[0].id);
  }
  const inserted = await client.query(
    `INSERT INTO categories (family_id, name, flow_type)
     VALUES ($1, 'Supermercado', 'EXPENSE')
     RETURNING id`,
    [familyId]
  );
  return String(inserted.rows[0].id);
}
router3.get(
  "/overview",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    try {
      const [listsRes, itemsRes, historyRes] = await Promise.all([
        pool.query(
          `SELECT id, family_id, name, store_name, budget_limit, status,
                  completed_at, total_spent, linked_transaction_id, created_at, updated_at
           FROM shopping_lists
           WHERE family_id = $1
           ORDER BY CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END, created_at DESC`,
          [familyId]
        ),
        pool.query(
          `SELECT id, list_id, family_id, name, aisle_category, quantity, unit,
                  unit_price, last_paid_price, is_checked, notes, created_at
           FROM shopping_list_items
           WHERE family_id = $1
           ORDER BY is_checked ASC, aisle_category ASC, name ASC, id ASC`,
          [familyId]
        ),
        pool.query(
          `SELECT id, normalized_name, display_name, aisle_category, unit,
                  last_price, previous_price, min_price, max_price,
                  last_store, purchase_count, updated_at
           FROM shopping_price_history
           WHERE family_id = $1
           ORDER BY purchase_count DESC, updated_at DESC`,
          [familyId]
        )
      ]);
      const itemsByList = /* @__PURE__ */ new Map();
      for (const item of itemsRes.rows) {
        const key = String(item.list_id);
        const listItems = itemsByList.get(key) || [];
        listItems.push({
          ...item,
          quantity: Number(item.quantity || 1),
          unit_price: Number(item.unit_price || 0),
          last_paid_price: item.last_paid_price !== null ? Number(item.last_paid_price) : null
        });
        itemsByList.set(key, listItems);
      }
      const lists = listsRes.rows.map((list) => {
        const listItems = itemsByList.get(String(list.id)) || [];
        const estimatedTotal = listItems.reduce(
          (sum, it) => sum + Number(it.quantity || 0) * Number(it.unit_price || 0),
          0
        );
        const cartTotal = listItems.filter((it) => it.is_checked).reduce((sum, it) => sum + Number(it.quantity || 0) * Number(it.unit_price || 0), 0);
        return {
          ...list,
          budget_limit: Number(list.budget_limit || 0),
          total_spent: Number(list.total_spent || 0),
          total_items: listItems.length,
          checked_items: listItems.filter((it) => it.is_checked).length,
          estimated_total: Math.round(estimatedTotal * 100) / 100,
          cart_total: Math.round(cartTotal * 100) / 100,
          items: listItems
        };
      });
      return res.json({
        lists,
        priceHistory: historyRes.rows.map((row) => ({
          ...row,
          last_price: Number(row.last_price || 0),
          previous_price: row.previous_price !== null ? Number(row.previous_price) : null,
          min_price: Number(row.min_price || 0),
          max_price: Number(row.max_price || 0),
          purchase_count: Number(row.purchase_count || 1)
        }))
      });
    } catch (error) {
      console.error("Erro ao carregar m\xF3dulo de mercado:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel carregar suas listas de mercado." });
    }
  }
);
router3.post(
  "/lists",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    const { name, store_name, budget_limit, template } = req.body ?? {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName || cleanName.length > 140) {
      return res.status(400).json({ error: "Informe um nome v\xE1lido para a lista de compras." });
    }
    const parsedBudget = Math.max(0, Number(budget_limit) || 0);
    const cleanStore = typeof store_name === "string" ? store_name.trim().slice(0, 120) || null : null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const listRes = await client.query(
        `INSERT INTO shopping_lists (family_id, name, store_name, budget_limit, status)
         VALUES ($1, $2, $3, $4, 'OPEN')
         RETURNING id, family_id, name, store_name, budget_limit, status, created_at`,
        [familyId, cleanName, cleanStore, parsedBudget]
      );
      const createdList = listRes.rows[0];
      const templateItems = typeof template === "string" && SHOPPING_TEMPLATES[template] ? SHOPPING_TEMPLATES[template] : [];
      if (templateItems.length > 0) {
        const historyRes = await client.query(
          `SELECT normalized_name, last_price FROM shopping_price_history WHERE family_id = $1`,
          [familyId]
        );
        const priceMap = /* @__PURE__ */ new Map();
        for (const h of historyRes.rows) {
          priceMap.set(String(h.normalized_name), Number(h.last_price));
        }
        for (const item of templateItems) {
          const norm = normalizeItemName(item.name);
          const historicalPrice = priceMap.get(norm) ?? null;
          await client.query(
            `INSERT INTO shopping_list_items (
               list_id, family_id, name, aisle_category, quantity, unit, unit_price, last_paid_price
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              createdList.id,
              familyId,
              item.name,
              item.aisle_category,
              item.quantity,
              item.unit,
              historicalPrice ?? 0,
              historicalPrice
            ]
          );
        }
      }
      await client.query("COMMIT");
      return res.status(201).json({
        message: "Lista de compras criada com sucesso!",
        listId: String(createdList.id)
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Erro ao criar lista de compras:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel criar a lista de compras." });
    } finally {
      client.release();
    }
  }
);
router3.put(
  "/lists/:id",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    const listId = req.params.id;
    const { name, store_name, budget_limit } = req.body ?? {};
    const cleanName = typeof name === "string" ? name.trim() : "";
    if (!cleanName) {
      return res.status(400).json({ error: "Informe um nome para a lista." });
    }
    try {
      const result = await pool.query(
        `UPDATE shopping_lists
         SET name = $1,
             store_name = $2,
             budget_limit = $3,
             updated_at = NOW()
         WHERE id = $4 AND family_id = $5
         RETURNING *`,
        [
          cleanName.slice(0, 140),
          typeof store_name === "string" ? store_name.trim().slice(0, 120) || null : null,
          Math.max(0, Number(budget_limit) || 0),
          listId,
          familyId
        ]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Lista n\xE3o encontrada." });
      }
      return res.json(result.rows[0]);
    } catch (error) {
      console.error("Erro ao atualizar lista:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel atualizar a lista." });
    }
  }
);
router3.delete(
  "/lists/:id",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    try {
      await pool.query("DELETE FROM shopping_lists WHERE id = $1 AND family_id = $2", [
        req.params.id,
        familyId
      ]);
      return res.json({ message: "Lista removida com sucesso." });
    } catch (error) {
      console.error("Erro ao excluir lista:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel excluir a lista." });
    }
  }
);
router3.post(
  "/lists/:id/duplicate",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    const sourceListId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sourceRes = await client.query(
        "SELECT * FROM shopping_lists WHERE id = $1 AND family_id = $2",
        [sourceListId, familyId]
      );
      if (sourceRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Lista original n\xE3o encontrada." });
      }
      const source = sourceRes.rows[0];
      const newName = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : `${source.name} (Nova Compra)`;
      const newListRes = await client.query(
        `INSERT INTO shopping_lists (family_id, name, store_name, budget_limit, status)
         VALUES ($1, $2, $3, $4, 'OPEN')
         RETURNING id`,
        [familyId, newName.slice(0, 140), source.store_name, source.budget_limit]
      );
      const newListId = newListRes.rows[0].id;
      await client.query(
        `INSERT INTO shopping_list_items (
           list_id, family_id, name, aisle_category, quantity, unit,
           unit_price, last_paid_price, is_checked, notes
         )
         SELECT $1, family_id, name, aisle_category, quantity, unit,
                unit_price,
                CASE WHEN unit_price > 0 THEN unit_price ELSE last_paid_price END,
                FALSE,
                notes
         FROM shopping_list_items
         WHERE list_id = $2 AND family_id = $3`,
        [newListId, sourceListId, familyId]
      );
      await client.query("COMMIT");
      return res.status(201).json({
        message: "Lista reaproveitada com os \xFAltimos pre\xE7os salvos!",
        listId: String(newListId)
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Erro ao duplicar lista:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel duplicar a lista." });
    } finally {
      client.release();
    }
  }
);
router3.post(
  "/lists/:id/items",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    const listId = req.params.id;
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (rawItems.length === 0) {
      return res.status(400).json({ error: "Informe ao menos um item." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const listCheck = await client.query(
        "SELECT id FROM shopping_lists WHERE id = $1 AND family_id = $2",
        [listId, familyId]
      );
      if (listCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Lista n\xE3o encontrada." });
      }
      const historyRes = await client.query(
        "SELECT normalized_name, last_price FROM shopping_price_history WHERE family_id = $1",
        [familyId]
      );
      const priceMap = /* @__PURE__ */ new Map();
      for (const h of historyRes.rows) {
        priceMap.set(String(h.normalized_name), Number(h.last_price));
      }
      const createdItems = [];
      for (const raw of rawItems) {
        const cleanName = typeof raw?.name === "string" ? raw.name.trim() : "";
        if (!cleanName) continue;
        const norm = normalizeItemName(cleanName);
        const historicalPrice = priceMap.get(norm) ?? null;
        const providedPrice = Number(raw?.unit_price);
        const finalPrice = Number.isFinite(providedPrice) && providedPrice > 0 ? providedPrice : historicalPrice ?? 0;
        const inserted = await client.query(
          `INSERT INTO shopping_list_items (
             list_id, family_id, name, aisle_category, quantity, unit,
             unit_price, last_paid_price, is_checked, notes
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            listId,
            familyId,
            cleanName.slice(0, 140),
            typeof raw?.aisle_category === "string" && raw.aisle_category.trim() ? raw.aisle_category.trim() : "Mercearia",
            Math.max(0.01, Number(raw?.quantity) || 1),
            typeof raw?.unit === "string" && raw.unit.trim() ? raw.unit.trim().slice(0, 20) : "un",
            Math.max(0, finalPrice),
            historicalPrice,
            Boolean(raw?.is_checked),
            typeof raw?.notes === "string" ? raw.notes.trim().slice(0, 200) || null : null
          ]
        );
        createdItems.push(inserted.rows[0]);
      }
      await client.query("COMMIT");
      return res.status(201).json({ items: createdItems });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Erro ao adicionar item \xE0 lista:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel adicionar o item." });
    } finally {
      client.release();
    }
  }
);
router3.put(
  "/items/:itemId",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    const itemId = req.params.itemId;
    const { name, aisle_category, quantity, unit, unit_price, is_checked, notes } = req.body ?? {};
    try {
      const currentRes = await pool.query(
        "SELECT * FROM shopping_list_items WHERE id = $1 AND family_id = $2",
        [itemId, familyId]
      );
      if (currentRes.rows.length === 0) {
        return res.status(404).json({ error: "Item n\xE3o encontrado." });
      }
      const current = currentRes.rows[0];
      const nextName = typeof name === "string" && name.trim() ? name.trim().slice(0, 140) : current.name;
      const nextAisle = typeof aisle_category === "string" && aisle_category.trim() ? aisle_category.trim() : current.aisle_category;
      const nextQuantity = quantity !== void 0 ? Math.max(1e-3, Number(quantity) || 1) : Number(current.quantity);
      const nextUnit = typeof unit === "string" && unit.trim() ? unit.trim().slice(0, 20) : current.unit;
      const nextUnitPrice = unit_price !== void 0 ? Math.max(0, Number(unit_price) || 0) : Number(current.unit_price);
      const nextChecked = is_checked !== void 0 ? Boolean(is_checked) : Boolean(current.is_checked);
      const nextNotes = notes !== void 0 ? typeof notes === "string" ? notes.trim().slice(0, 200) || null : null : current.notes;
      const updated = await pool.query(
        `UPDATE shopping_list_items
         SET name = $1,
             aisle_category = $2,
             quantity = $3,
             unit = $4,
             unit_price = $5,
             is_checked = $6,
             notes = $7
         WHERE id = $8 AND family_id = $9
         RETURNING *`,
        [
          nextName,
          nextAisle,
          nextQuantity,
          nextUnit,
          nextUnitPrice,
          nextChecked,
          nextNotes,
          itemId,
          familyId
        ]
      );
      return res.json(updated.rows[0]);
    } catch (error) {
      console.error("Erro ao atualizar item da lista:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel atualizar o item." });
    }
  }
);
router3.delete(
  "/items/:itemId",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    try {
      await pool.query("DELETE FROM shopping_list_items WHERE id = $1 AND family_id = $2", [
        req.params.itemId,
        familyId
      ]);
      return res.json({ message: "Item removido." });
    } catch (error) {
      console.error("Erro ao remover item:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel remover o item." });
    }
  }
);
router3.post(
  "/lists/:id/checkout",
  requireFamilyPermission("family_read"),
  async (req, res) => {
    const familyId = String(req.familyAccess.familyId);
    const listId = req.params.id;
    const {
      store_name,
      total_spent_override,
      create_transaction = true,
      payment_target = "ACCOUNT",
      // 'ACCOUNT' | 'CARD'
      account_id,
      credit_card_id,
      category_id,
      payment_method = "PIX",
      settle_immediately = true,
      purchase_date
    } = req.body ?? {};
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const listRes = await client.query(
        "SELECT * FROM shopping_lists WHERE id = $1 AND family_id = $2 FOR UPDATE",
        [listId, familyId]
      );
      if (listRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Lista de compras n\xE3o encontrada." });
      }
      const list = listRes.rows[0];
      const finalStore = typeof store_name === "string" && store_name.trim() ? store_name.trim().slice(0, 120) : list.store_name;
      const itemsRes = await client.query(
        "SELECT * FROM shopping_list_items WHERE list_id = $1 AND family_id = $2",
        [listId, familyId]
      );
      const allItems = itemsRes.rows;
      const checkedItems = allItems.filter((it) => it.is_checked);
      const itemsToProcess = checkedItems.length > 0 ? checkedItems : allItems;
      const calculatedTotal = itemsToProcess.reduce(
        (sum, it) => sum + Number(it.quantity || 0) * Number(it.unit_price || 0),
        0
      );
      const finalTotal = Number.isFinite(Number(total_spent_override)) && Number(total_spent_override) > 0 ? Math.round(Number(total_spent_override) * 100) / 100 : Math.round(calculatedTotal * 100) / 100;
      for (const item of itemsToProcess) {
        const unitPrice = Number(item.unit_price || 0);
        if (unitPrice <= 0) continue;
        const norm = normalizeItemName(item.name);
        await client.query(
          `INSERT INTO shopping_price_history (
             family_id, normalized_name, display_name, aisle_category, unit,
             last_price, previous_price, min_price, max_price, last_store, purchase_count, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $6, $6, $7, 1, NOW())
           ON CONFLICT (family_id, normalized_name)
           DO UPDATE SET
             display_name = EXCLUDED.display_name,
             aisle_category = EXCLUDED.aisle_category,
             unit = EXCLUDED.unit,
             previous_price = shopping_price_history.last_price,
             last_price = EXCLUDED.last_price,
             min_price = LEAST(shopping_price_history.min_price, EXCLUDED.last_price),
             max_price = GREATEST(shopping_price_history.max_price, EXCLUDED.last_price),
             last_store = COALESCE(EXCLUDED.last_store, shopping_price_history.last_store),
             purchase_count = shopping_price_history.purchase_count + 1,
             updated_at = NOW()`,
          [
            familyId,
            norm,
            item.name,
            item.aisle_category || "Mercearia",
            item.unit || "un",
            unitPrice,
            finalStore
          ]
        );
      }
      let linkedTransactionId = null;
      const txDate = typeof purchase_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(purchase_date) ? purchase_date : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      if (create_transaction && finalTotal > 0) {
        const resolvedCategoryId = category_id ? String(category_id) : await ensureSupermarketCategory(client, familyId);
        const txDescription = finalStore ? `Mercado: ${list.name} (${finalStore})` : `Mercado: ${list.name}`;
        if (payment_target === "CARD" && credit_card_id) {
          const cardRes = await client.query(
            "SELECT id, closing_day, due_day FROM credit_cards WHERE id = $1 AND family_id = $2",
            [credit_card_id, familyId]
          );
          if (cardRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Cart\xE3o de cr\xE9dito selecionado inv\xE1lido." });
          }
          const card = cardRes.rows[0];
          const dueDate = getCardInvoiceDueDate(
            txDate,
            Number(card.closing_day || 1),
            Number(card.due_day || 10)
          );
          const txInsert = await client.query(
            `INSERT INTO transactions (
               family_id, credit_card_id, category_id, description, amount,
               transaction_date, due_date, type, status, payment_method
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'EXPENSE', 'PENDING', 'CARD')
             RETURNING id`,
            [familyId, credit_card_id, resolvedCategoryId, txDescription, finalTotal, txDate, dueDate]
          );
          linkedTransactionId = String(txInsert.rows[0].id);
        } else {
          const isPaid = Boolean(settle_immediately && account_id);
          const txInsert = await client.query(
            `INSERT INTO transactions (
               family_id, account_id, category_id, description, amount, paid_amount,
               transaction_date, due_date, type, status, payment_method
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'EXPENSE', $8, $9)
             RETURNING id`,
            [
              familyId,
              account_id || null,
              resolvedCategoryId,
              txDescription,
              finalTotal,
              isPaid ? finalTotal : null,
              txDate,
              isPaid ? "PAID" : "PENDING",
              payment_method || "PIX"
            ]
          );
          linkedTransactionId = String(txInsert.rows[0].id);
          if (isPaid && account_id) {
            await client.query(
              "UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND family_id = $3",
              [finalTotal, account_id, familyId]
            );
          }
        }
      }
      await client.query(
        `UPDATE shopping_lists
         SET status = 'COMPLETED',
             store_name = $1,
             total_spent = $2,
             completed_at = NOW(),
             linked_transaction_id = $3,
             updated_at = NOW()
         WHERE id = $4 AND family_id = $5`,
        [finalStore, finalTotal, linkedTransactionId, listId, familyId]
      );
      await client.query("COMMIT");
      return res.json({
        message: create_transaction ? "Compra finalizada e lan\xE7ada automaticamente no financeiro da fam\xEDlia!" : "Compra conclu\xEDda e pre\xE7os salvos no hist\xF3rico da casa!",
        linkedTransactionId,
        totalSpent: finalTotal
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Erro ao finalizar compra de mercado:", error);
      return res.status(500).json({ error: "N\xE3o foi poss\xEDvel finalizar a compra." });
    } finally {
      client.release();
    }
  }
);
var shoppingRoutes_default = router3;

// src/route.ts
var router4 = (0, import_express4.Router)();
var JWT_SECRET3 = process.env.JWT_SECRET || "finanfamily_secreto_2026";
var GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
var googleClient = new import_google_auth_library.OAuth2Client(GOOGLE_CLIENT_ID);
function addMonthsToDate(dateValue, monthOffset) {
  const [year, month, day] = dateValue.slice(0, 10).split("-").map(Number);
  const targetMonth = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  const lastDayOfMonth = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  targetMonth.setUTCDate(Math.min(day, lastDayOfMonth));
  return targetMonth.toISOString().split("T")[0];
}
router4.get("/", (req, res) => {
  if (req.query.warmup) {
    pool.query("SELECT 1").catch(() => {
    });
  }
  return res.status(200).json({ status: "online", message: "API FinanFamily a funcionar perfeitamente!" });
});
async function ensureInvestmentCategory(client, familyId) {
  let catRes = await client.query(
    `SELECT id FROM categories WHERE family_id = $1 AND LOWER(name) = 'investimento' FOR UPDATE`,
    [familyId]
  );
  if (catRes.rows.length > 0) {
    await client.query(
      "UPDATE categories SET flow_type = 'EXPENSE' WHERE id = $1",
      [catRes.rows[0].id]
    );
    return catRes.rows[0].id;
  }
  const newCat = await client.query(
    `INSERT INTO categories (family_id, name, flow_type) VALUES ($1, 'Investimento', 'EXPENSE') RETURNING id`,
    [familyId]
  );
  return newCat.rows[0].id;
}
router4.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "E-mail e palavra-passe s\xE3o obrigat\xF3rios." });
  }
  try {
    const result = await pool.query("SELECT * FROM users WHERE LOWER(email) = $1", [email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "Credenciais inv\xE1lidas." });
    }
    const isPasswordValid = await import_bcrypt2.default.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Credenciais inv\xE1lidas." });
    }
    if (user.family_id) {
      const tenantStatus = await getTenantAccessStatus(user.family_id);
      if (tenantStatus.blocked) {
        return res.status(403).json({
          code: "TENANT_BLOCKED",
          error: "Seu acesso est\xE1 temporariamente indispon\xEDvel.",
          contact_phone: tenantStatus.contactPhone
        });
      }
    }
    const token = import_jsonwebtoken3.default.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET3,
      { expiresIn: "7d" }
    );
    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(200).json({ token, user: safeUser });
  } catch (err) {
    console.error("Erro no login:", err);
    return res.status(500).json({ error: "Erro interno no servidor." });
  }
});
router4.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: "Token do Google n\xE3o fornecido." });
  const client = await pool.connect();
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID || void 0
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: "Falha ao ler dados do Google." });
    }
    const { email, name, sub: googleId, picture: avatarUrl } = payload;
    const cleanEmail = email.toLowerCase();
    const invitationToken = typeof req.body.invitation_token === "string" ? req.body.invitation_token : "";
    await client.query("BEGIN");
    const invitationResult = invitationToken ? await client.query(
      `SELECT token_hash, family_id, email, permissions, invited_by
           FROM family_invitations
           WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
           FOR UPDATE`,
      [hashInvitationToken(invitationToken)]
    ) : { rows: [] };
    const invitation = invitationResult.rows[0];
    if (invitationToken && (!invitation || invitation.email !== cleanEmail)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "O convite n\xE3o \xE9 v\xE1lido para esta conta Google ou expirou." });
    }
    const existingUserResult = await client.query(
      "SELECT id, name, email, family_id, avatar_url, google_id FROM users WHERE LOWER(email) = $1 FOR UPDATE",
      [cleanEmail]
    );
    let user = existingUserResult.rows[0];
    if (user && invitation && user.family_id && String(user.family_id) !== String(invitation.family_id)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Esta conta j\xE1 pertence a outra fam\xEDlia. Ainda n\xE3o \xE9 poss\xEDvel vincular uma conta a m\xFAltiplas fam\xEDlias." });
    }
    if (user) {
      if (!user.google_id || !user.avatar_url) {
        const updateResult = await client.query(
          `UPDATE users
           SET google_id = COALESCE(google_id, $1), avatar_url = COALESCE($2, avatar_url), email_verified = TRUE
           WHERE id = $3
           RETURNING id, name, email, family_id, avatar_url, google_id`,
          [googleId, avatarUrl || null, user.id]
        );
        user = updateResult.rows[0];
      }
      if (user.family_id) {
        const tenantStatusResult = await client.query(
          `SELECT f.blocked_at,
                  (SELECT value FROM system_settings WHERE key = 'tenant_support_phone') AS contact_phone
           FROM families f
           WHERE f.id::text = $1`,
          [String(user.family_id)]
        );
        const tenantStatus = tenantStatusResult.rows[0];
        if (tenantStatus?.blocked_at) {
          await client.query("ROLLBACK");
          return res.status(403).json({
            code: "TENANT_BLOCKED",
            error: "Seu acesso est\xE1 temporariamente indispon\xEDvel.",
            contact_phone: tenantStatus.contact_phone || "(41) 0000-0000"
          });
        }
      }
      if (invitation) {
        if (!user.family_id) {
          const familyUpdate = await client.query(
            "UPDATE users SET family_id = $1 WHERE id = $2 RETURNING id, name, email, family_id, avatar_url, google_id",
            [invitation.family_id, user.id]
          );
          user = familyUpdate.rows[0];
        }
        const membershipResult = await client.query(
          "SELECT family_id, role FROM family_members WHERE user_id = $1 FOR UPDATE",
          [String(user.id)]
        );
        const membership = membershipResult.rows[0];
        if (membership && String(membership.family_id) !== String(invitation.family_id)) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Esta conta j\xE1 est\xE1 vinculada a outra fam\xEDlia." });
        }
        if (!membership) {
          await client.query(
            `INSERT INTO family_members (family_id, user_id, role, permissions, invited_by)
             VALUES ($1, $2, 'MEMBER', $3::jsonb, $4)`,
            [String(invitation.family_id), String(user.id), JSON.stringify(invitation.permissions), String(invitation.invited_by)]
          );
        }
      }
    } else if (invitation) {
      const userRes = await client.query(
        `INSERT INTO users (name, email, google_id, avatar_url, family_id, email_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, name, email, family_id, avatar_url`,
        [name || "Utilizador", cleanEmail, googleId, avatarUrl || null, invitation.family_id]
      );
      user = userRes.rows[0];
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role, permissions, invited_by)
         VALUES ($1, $2, 'MEMBER', $3::jsonb, $4)`,
        [String(invitation.family_id), String(user.id), JSON.stringify(invitation.permissions), String(invitation.invited_by)]
      );
    } else {
      const familyRes = await client.query(
        `INSERT INTO families (name, registered_at, plan_type, trial_ends_at)
         VALUES ($1, NOW(), 'TRIAL', NOW() + INTERVAL '10 days')
         RETURNING id`,
        [`Fam\xEDlia de ${name || "Utilizador"}`]
      );
      const familyId = familyRes.rows[0].id;
      await seedDefaultFamilyResources(client, familyId);
      const userRes = await client.query(
        `INSERT INTO users (name, email, google_id, avatar_url, family_id, email_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, name, email, family_id, avatar_url`,
        [name || "Utilizador", cleanEmail, googleId, avatarUrl || null, familyId]
      );
      user = userRes.rows[0];
      const ownerPermissions = Object.fromEntries(FAMILY_PERMISSIONS.map((permission) => [permission, true]));
      await client.query(
        `INSERT INTO family_members (family_id, user_id, role, permissions)
         VALUES ($1, $2, 'OWNER', $3::jsonb)`,
        [String(familyId), String(user.id), JSON.stringify(ownerPermissions)]
      );
    }
    const leadMatch = await client.query(
      `UPDATE marketing_leads
       SET status = 'CONVERTED', updated_at = NOW()
       WHERE LOWER(email) = $1
       RETURNING whatsapp`,
      [cleanEmail]
    );
    if (leadMatch.rows[0]?.whatsapp) {
      await client.query(
        `UPDATE users SET phone = COALESCE(NULLIF(phone, ''), $1) WHERE id = $2`,
        [leadMatch.rows[0].whatsapp, user.id]
      );
    }
    if (invitation) {
      await client.query(
        "UPDATE family_invitations SET accepted_at = NOW() WHERE token_hash = $1",
        [invitation.token_hash]
      );
    }
    await client.query("COMMIT");
    const token = import_jsonwebtoken3.default.sign(
      { id: user.id, family_id: user.family_id },
      JWT_SECRET3,
      { expiresIn: "7d" }
    );
    const { password_hash, verification_token, reset_token, ...safeUser } = user;
    return res.status(200).json({ token, user: safeUser });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro no Google Auth:", err);
    return res.status(500).json({ error: "Erro ao autenticar com o Google." });
  } finally {
    client.release();
  }
});
router4.use(publicRouter);
router4.use("/api", authenticateFamilyMember);
router4.use(familyRoutes_default);
router4.use("/api/annual-provisions", annualProvisions_default);
router4.use("/api/shopping", shoppingRoutes_default);
router4.get("/api/accounts", requireFamilyPermission("family_read"), async (req, res) => {
  const family_id = req.familyAccess.familyId;
  try {
    const result = await pool.query(
      `SELECT id, name, bank_name, agency, account_number, pix_key,
              initial_balance, balance
       FROM accounts
       WHERE family_id = $1
       ORDER BY name ASC`,
      [String(family_id)]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.post("/api/accounts", requireFamilyPermission("accounts_manage"), async (req, res) => {
  const { bank_name, agency, account_number, pix_key, initial_balance } = req.body;
  const normalizedBank = typeof bank_name === "string" ? bank_name.trim() : "";
  const normalizedAccount = typeof account_number === "string" ? account_number.trim() : "";
  const openingBalance = Math.round(Number(initial_balance) * 100) / 100;
  if (!normalizedBank || !normalizedAccount || !Number.isFinite(openingBalance)) {
    return res.status(400).json({ error: "Informe um banco, n\xFAmero da conta e saldo inicial v\xE1lidos." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO accounts (
         family_id, name, bank_name, agency, account_number, pix_key, initial_balance, balance
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id, name, bank_name, agency, account_number, pix_key, initial_balance, balance`,
      [
        req.familyAccess.familyId,
        `${normalizedBank} \u2022 ${normalizedAccount}`,
        normalizedBank,
        typeof agency === "string" ? agency.trim() || null : null,
        normalizedAccount,
        typeof pix_key === "string" ? pix_key.trim() || null : null,
        openingBalance
      ]
    );
    return res.status(201).json({ message: "Conta banc\xE1ria cadastrada.", account: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.put("/api/accounts/:id", requireFamilyPermission("accounts_manage"), async (req, res) => {
  const { bank_name, agency, account_number, pix_key, initial_balance } = req.body;
  const normalizedBank = typeof bank_name === "string" ? bank_name.trim() : "";
  const normalizedAccount = typeof account_number === "string" ? account_number.trim() : "";
  const openingBalance = Math.round(Number(initial_balance) * 100) / 100;
  if (!normalizedBank || !normalizedAccount || !Number.isFinite(openingBalance)) {
    return res.status(400).json({ error: "Informe um banco, n\xFAmero da conta e saldo inicial v\xE1lidos." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      "SELECT id, balance, initial_balance FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [req.params.id, req.familyAccess.familyId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Conta banc\xE1ria n\xE3o encontrada." });
    }
    const balanceAdjustment = openingBalance - Number(current.initial_balance);
    const result = await client.query(
      `UPDATE accounts
       SET name = $1, bank_name = $2, agency = $3, account_number = $4,
           pix_key = $5, initial_balance = $6, balance = balance + $7
       WHERE id = $8 AND family_id = $9
       RETURNING id, name, bank_name, agency, account_number, pix_key, initial_balance, balance`,
      [
        `${normalizedBank} \u2022 ${normalizedAccount}`,
        normalizedBank,
        typeof agency === "string" ? agency.trim() || null : null,
        normalizedAccount,
        typeof pix_key === "string" ? pix_key.trim() || null : null,
        openingBalance,
        balanceAdjustment,
        req.params.id,
        req.familyAccess.familyId
      ]
    );
    await client.query("COMMIT");
    return res.json({ message: "Conta banc\xE1ria atualizada.", account: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.delete("/api/accounts/:id", requireFamilyPermission("accounts_manage"), async (req, res) => {
  try {
    const accountResult = await pool.query(
      "SELECT id FROM accounts WHERE id = $1 AND family_id = $2",
      [req.params.id, req.familyAccess.familyId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: "Conta banc\xE1ria n\xE3o encontrada." });
    }
    const transactionResult = await pool.query(
      "SELECT 1 FROM transactions WHERE account_id = $1 AND family_id = $2 LIMIT 1",
      [req.params.id, req.familyAccess.familyId]
    );
    if (transactionResult.rows.length > 0) {
      return res.status(409).json({ error: "N\xE3o \xE9 poss\xEDvel excluir uma conta vinculada a lan\xE7amentos." });
    }
    await pool.query(
      "DELETE FROM accounts WHERE id = $1 AND family_id = $2",
      [req.params.id, req.familyAccess.familyId]
    );
    return res.json({ message: "Conta banc\xE1ria exclu\xEDda." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.get("/api/categories", requireFamilyPermission("family_read"), async (req, res) => {
  const family_id = String(req.familyAccess.familyId);
  try {
    const result = await pool.query(
      `SELECT c.*, COUNT(t.id)::int AS transaction_count
       FROM categories c
       LEFT JOIN transactions t ON t.category_id = c.id
       WHERE c.family_id::text = $1
       GROUP BY c.id
       ORDER BY c.name ASC`,
      [family_id]
    );
    let rows = result.rows;
    if (!rows.some((c) => String(c.name || "").toLowerCase() === "investimento")) {
      const invRes = await pool.query(
        `INSERT INTO categories (family_id, name, flow_type)
         VALUES ($1, 'Investimento', 'EXPENSE')
         RETURNING *`,
        [family_id]
      );
      if (invRes.rows[0]) {
        rows = [...rows, { ...invRes.rows[0], transaction_count: 0 }].sort(
          (a, b) => String(a.name).localeCompare(String(b.name), "pt-BR")
        );
      }
    }
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.post("/api/categories", requireFamilyPermission("categories_manage"), async (req, res) => {
  const { name, type = "VARIABLE", flow_type = "EXPENSE", color = "#10b981" } = req.body;
  const budgetAmount = req.body.budget_amount === "" || req.body.budget_amount === null || req.body.budget_amount === void 0 ? null : Number(req.body.budget_amount);
  const family_id = req.familyAccess.familyId;
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!family_id || !normalizedName) {
    return res.status(400).json({ error: "family_id e name s\xE3o obrigat\xF3rios." });
  }
  if (!["EXPENSE", "INCOME"].includes(flow_type) || !["FIXED", "VARIABLE"].includes(type)) {
    return res.status(400).json({ error: "Tipo e fluxo da categoria s\xE3o inv\xE1lidos." });
  }
  if (budgetAmount !== null && (!Number.isFinite(budgetAmount) || budgetAmount <= 0 || flow_type !== "EXPENSE")) {
    return res.status(400).json({ error: "O or\xE7amento deve ser maior que zero e s\xF3 pode ser definido para categorias de despesa." });
  }
  if (normalizedName.toLocaleLowerCase("pt-BR") === "investimento") {
    return res.status(409).json({ error: "A categoria Investimento j\xE1 \xE9 pr\xE9-cadastrada e reservada." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO categories (family_id, name, type, flow_type, color, budget_amount)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [family_id, normalizedName, type, flow_type, color, budgetAmount]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.put("/api/categories/:id", requireFamilyPermission("categories_manage"), async (req, res) => {
  const { id } = req.params;
  const { name, type, flow_type, color } = req.body;
  const hasBudgetAmount = Object.prototype.hasOwnProperty.call(req.body, "budget_amount");
  const budgetAmount = req.body.budget_amount === "" || req.body.budget_amount === null || req.body.budget_amount === void 0 ? null : Number(req.body.budget_amount);
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName || !["FIXED", "VARIABLE"].includes(type) || !["EXPENSE", "INCOME"].includes(flow_type) || typeof color !== "string") {
    return res.status(400).json({ error: "Nome, natureza, fluxo e cor da categoria s\xE3o obrigat\xF3rios." });
  }
  if (hasBudgetAmount && budgetAmount !== null && (!Number.isFinite(budgetAmount) || budgetAmount <= 0 || flow_type !== "EXPENSE")) {
    return res.status(400).json({ error: "O or\xE7amento deve ser maior que zero e s\xF3 pode ser definido para categorias de despesa." });
  }
  if (normalizedName.toLocaleLowerCase("pt-BR") === "investimento") {
    return res.status(409).json({ error: "A categoria Investimento \xE9 reservada e n\xE3o pode ser renomeada." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const categoryResult = await client.query(
      "SELECT id, name, flow_type, budget_amount FROM categories WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [id, req.familyAccess.familyId]
    );
    const category = categoryResult.rows[0];
    if (!category) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Categoria n\xE3o encontrada." });
    }
    if (String(category.name).toLocaleLowerCase("pt-BR") === "investimento") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A categoria Investimento \xE9 reservada e n\xE3o pode ser editada." });
    }
    const linkedResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM transactions WHERE category_id = $1) AS has_transactions",
      [id]
    );
    if (linkedResult.rows[0].has_transactions && flow_type !== category.flow_type) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "O fluxo n\xE3o pode ser alterado enquanto houver lan\xE7amentos vinculados \xE0 categoria."
      });
    }
    const nextBudgetAmount = flow_type === "INCOME" ? null : hasBudgetAmount ? budgetAmount : category.budget_amount;
    const result = await client.query(
      `UPDATE categories
       SET name = $1, type = $2, flow_type = $3, color = $4, budget_amount = $5
       WHERE id = $6 AND family_id = $7 RETURNING *`,
      [normalizedName, type, flow_type, color, nextBudgetAmount, id, req.familyAccess.familyId]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.delete("/api/categories/:id", requireFamilyPermission("categories_manage"), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const categoryResult = await client.query(
      "SELECT id, name FROM categories WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [id, req.familyAccess.familyId]
    );
    const category = categoryResult.rows[0];
    if (!category) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Categoria n\xE3o encontrada." });
    }
    if (String(category.name).toLocaleLowerCase("pt-BR") === "investimento") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A categoria Investimento \xE9 reservada e n\xE3o pode ser exclu\xEDda." });
    }
    const linkedResult = await client.query(
      "SELECT COUNT(*)::int AS transaction_count FROM transactions WHERE category_id = $1",
      [id]
    );
    const transactionCount = linkedResult.rows[0].transaction_count;
    if (transactionCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Esta categoria possui ${transactionCount} lan\xE7amento(s) vinculado(s) e n\xE3o pode ser exclu\xEDda.`
      });
    }
    await client.query("DELETE FROM categories WHERE id = $1 AND family_id = $2", [id, req.familyAccess.familyId]);
    await client.query("COMMIT");
    return res.json({ message: "Categoria exclu\xEDda com sucesso." });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.get("/api/credit-cards", requireFamilyPermission("family_read"), async (req, res) => {
  const family_id = req.familyAccess.familyId;
  try {
    const result = await pool.query(`SELECT * FROM credit_cards WHERE family_id = $1 ORDER BY name ASC`, [String(family_id)]);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.post("/api/credit-cards", requireFamilyPermission("cards_manage"), async (req, res) => {
  const { name, brand, total_limit, closing_day, due_day } = req.body;
  const family_id = req.familyAccess.familyId;
  const parsedLimit = Number(total_limit) || 0;
  if (!family_id || !name || !brand || parsedLimit <= 0) {
    return res.status(400).json({ error: "family_id, name, brand e total_limit s\xE3o obrigat\xF3rios." });
  }
  try {
    const query = `
      INSERT INTO credit_cards (family_id, name, brand, total_limit, closing_day, due_day)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
    `;
    const result = await pool.query(query, [family_id, name, brand, parsedLimit, Number(closing_day) || 1, Number(due_day) || 10]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.put("/api/credit-cards/:id", requireFamilyPermission("cards_manage"), async (req, res) => {
  const { id } = req.params;
  const { name, brand, total_limit, closing_day, due_day } = req.body;
  const parsedLimit = Number(total_limit);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return res.status(400).json({ error: "Informe um limite v\xE1lido maior que zero." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cardResult = await client.query(
      "SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [id, req.familyAccess.familyId]
    );
    if (cardResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cart\xE3o n\xE3o encontrado." });
    }
    const pendingResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM transactions WHERE credit_card_id = $1 AND status IS DISTINCT FROM 'PAID') AS has_pending_transactions",
      [id]
    );
    const hasPendingTransactions = pendingResult.rows[0].has_pending_transactions;
    if (hasPendingTransactions) {
      const fields = Object.keys(req.body);
      if (fields.some((field) => field !== "total_limit")) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "O cart\xE3o possui lan\xE7amentos pendentes. Apenas o limite pode ser alterado."
        });
      }
      const result2 = await client.query(
        "UPDATE credit_cards SET total_limit = $1 WHERE id = $2 AND family_id = $3 RETURNING *",
        [parsedLimit, id, req.familyAccess.familyId]
      );
      await client.query("COMMIT");
      return res.json(result2.rows[0]);
    }
    const parsedClosingDay = Number(closing_day);
    const parsedDueDay = Number(due_day);
    if (typeof name !== "string" || !name.trim() || typeof brand !== "string" || !brand.trim() || !Number.isInteger(parsedClosingDay) || parsedClosingDay < 1 || parsedClosingDay > 31 || !Number.isInteger(parsedDueDay) || parsedDueDay < 1 || parsedDueDay > 31) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Informe identifica\xE7\xE3o, bandeira, fechamento e vencimento v\xE1lidos." });
    }
    const result = await client.query(
      `UPDATE credit_cards
       SET name = $1, brand = $2, total_limit = $3, closing_day = $4, due_day = $5
       WHERE id = $6 AND family_id = $7 RETURNING *`,
      [name.trim(), brand.trim(), parsedLimit, parsedClosingDay, parsedDueDay, id, req.familyAccess.familyId]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.delete("/api/credit-cards/:id", requireFamilyPermission("cards_manage"), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cardResult = await client.query(
      "SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [id, req.familyAccess.familyId]
    );
    if (cardResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Cart\xE3o n\xE3o encontrado." });
    }
    const pendingResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM transactions WHERE credit_card_id = $1 AND status IS DISTINCT FROM 'PAID') AS has_pending_transactions",
      [id]
    );
    if (pendingResult.rows[0].has_pending_transactions) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "O cart\xE3o possui lan\xE7amentos pendentes e n\xE3o pode ser exclu\xEDdo."
      });
    }
    await client.query(
      "UPDATE transactions SET credit_card_id = NULL WHERE credit_card_id = $1 AND family_id = $2 AND status = 'PAID'",
      [id, req.familyAccess.familyId]
    );
    await client.query("DELETE FROM credit_cards WHERE id = $1 AND family_id = $2", [id, req.familyAccess.familyId]);
    await client.query("COMMIT");
    return res.json({ message: "Cart\xE3o de cr\xE9dito removido com sucesso." });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.get("/api/transactions", requireFamilyPermission("family_read"), async (req, res) => {
  const family_id = req.familyAccess.familyId;
  try {
    const result = await pool.query(
      `SELECT t.*, c.name AS category_name, a.name AS account_name, cc.name AS credit_card_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN credit_cards cc ON t.credit_card_id = cc.id
       WHERE t.family_id = $1 ORDER BY t.due_date DESC`,
      [String(family_id)]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.post("/api/transactions", requireFamilyPermission("transactions_create"), async (req, res) => {
  const {
    account_id,
    credit_card_id,
    category_id,
    description,
    amount,
    transaction_date,
    due_date,
    type,
    status = "PENDING",
    total_installments = 1,
    start_installment = 1,
    recurrence_months = 1,
    payment_method = "BOLETO"
  } = req.body;
  const family_id = req.familyAccess.familyId;
  const transactionAmount = Number(amount);
  if (!family_id || !description || !Number.isFinite(transactionAmount) || transactionAmount <= 0 || !transaction_date || !due_date || !type) {
    return res.status(400).json({ error: "family_id, description, amount, transaction_date, due_date e type s\xE3o obrigat\xF3rios." });
  }
  if (status !== "PENDING") {
    return res.status(400).json({ error: "Novos lan\xE7amentos devem come\xE7ar pendentes. Use a a\xE7\xE3o de baixa para registrar o pagamento." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (category_id) {
      const categoryResult = await client.query(
        "SELECT id FROM categories WHERE id = $1 AND family_id = $2 AND flow_type = $3 FOR SHARE",
        [category_id, family_id, type]
      );
      if (categoryResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A categoria selecionada n\xE3o pertence a esta fam\xEDlia ou ao tipo do lan\xE7amento." });
      }
    }
    if (payment_method === "CARD" && credit_card_id) {
      const cardResult = await client.query(
        "SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE",
        [credit_card_id, family_id]
      );
      if (cardResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "O cart\xE3o selecionado n\xE3o pertence a esta fam\xEDlia." });
      }
    }
    const totalInst = Number(total_installments);
    const startInst = Number(start_installment);
    const recurrenceMonths = Number(recurrence_months);
    if (!Number.isInteger(totalInst) || totalInst < 1 || !Number.isInteger(startInst) || startInst < 1 || startInst > totalInst) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "O total de parcelas e a parcela inicial devem formar um intervalo v\xE1lido." });
    }
    if (!Number.isInteger(recurrenceMonths) || recurrenceMonths < 1 || recurrenceMonths > 120 || recurrenceMonths > 1 && (totalInst !== 1 || startInst !== 1)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "A recorr\xEAncia deve ter entre 1 e 120 meses e n\xE3o pode ser combinada com parcelamento." });
    }
    const isRecurring = recurrenceMonths > 1;
    const installmentAmount = Math.round(transactionAmount / totalInst * 100) / 100;
    const creationCount = isRecurring ? recurrenceMonths : totalInst - startInst + 1;
    let parentId = null;
    const createdTransactions = [];
    for (let occurrence = 0; occurrence < creationCount; occurrence++) {
      const installmentNumber = isRecurring ? 1 : startInst + occurrence;
      const formattedDueDate = addMonthsToDate(due_date, occurrence);
      const formattedTransactionDate = isRecurring ? addMonthsToDate(transaction_date, occurrence) : transaction_date;
      const transactionDescription = !isRecurring && totalInst > 1 ? `${description} (${installmentNumber}/${totalInst})` : description;
      const result = await client.query(
        `INSERT INTO transactions (
          family_id, account_id, credit_card_id, category_id,
          description, amount, type, status, transaction_date, due_date,
          installment_number, total_installments, parent_transaction_id, payment_method
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *;`,
        [
          family_id,
          payment_method === "CARD" ? null : account_id || null,
          payment_method === "CARD" ? credit_card_id || null : null,
          category_id || null,
          transactionDescription,
          isRecurring ? transactionAmount : installmentAmount,
          type,
          status,
          formattedTransactionDate,
          formattedDueDate,
          isRecurring ? 1 : installmentNumber,
          isRecurring ? 1 : totalInst,
          isRecurring ? null : parentId,
          payment_method
        ]
      );
      if (!isRecurring && occurrence === 0) {
        parentId = result.rows[0].id;
      }
      createdTransactions.push(result.rows[0]);
    }
    await client.query("COMMIT");
    return res.status(201).json({
      message: isRecurring ? `${createdTransactions.length} lan\xE7amentos mensais criados com sucesso!` : "Lan\xE7amento(s) criado(s) com sucesso!",
      transactions: createdTransactions
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.post("/api/transactions/batch", requireFamilyPermission("transactions_create"), async (req, res) => {
  const family_id = req.familyAccess.familyId;
  const canSettle = req.familyAccess.role === "OWNER" || req.familyAccess.permissions?.transactions_settle === true;
  const targetType = req.body?.target_type === "CARD" ? "CARD" : "ACCOUNT";
  const accountId = req.body?.account_id ? String(req.body.account_id) : null;
  const creditCardId = req.body?.credit_card_id ? String(req.body.credit_card_id) : null;
  const settleImmediately = Boolean(req.body?.settle_immediately) && targetType === "ACCOUNT" && canSettle;
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rawItems.length === 0 || rawItems.length > 300) {
    return res.status(400).json({ error: "Selecione entre 1 e 300 lan\xE7amentos para importar por vez." });
  }
  if (targetType === "ACCOUNT" && !accountId) {
    return res.status(400).json({ error: "Selecione a conta banc\xE1ria de destino para importar." });
  }
  if (targetType === "CARD" && !creditCardId) {
    return res.status(400).json({ error: "Selecione o cart\xE3o de cr\xE9dito de destino para importar." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (targetType === "ACCOUNT" && accountId) {
      const accCheck = await client.query(
        "SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE",
        [accountId, family_id]
      );
      if (accCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A conta banc\xE1ria selecionada n\xE3o pertence a esta fam\xEDlia." });
      }
    }
    if (targetType === "CARD" && creditCardId) {
      const cardCheck = await client.query(
        "SELECT id FROM credit_cards WHERE id = $1 AND family_id = $2 FOR UPDATE",
        [creditCardId, family_id]
      );
      if (cardCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "O cart\xE3o selecionado n\xE3o pertence a esta fam\xEDlia." });
      }
    }
    const categoriesRes = await client.query(
      "SELECT id, flow_type FROM categories WHERE family_id = $1",
      [family_id]
    );
    const validCategories = new Map(
      categoriesRes.rows.map((row) => [String(row.id), String(row.flow_type)])
    );
    const createdTransactions = [];
    let netBalanceAdjustment = 0;
    for (const rawItem of rawItems) {
      const description = typeof rawItem?.description === "string" ? rawItem.description.trim().slice(0, 180) : "";
      const amount = Math.round(Math.abs(Number(rawItem?.amount)) * 100) / 100;
      const type = rawItem?.type === "INCOME" && targetType === "ACCOUNT" ? "INCOME" : "EXPENSE";
      const txDate = typeof rawItem?.transaction_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawItem.transaction_date) ? rawItem.transaction_date : (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const dueDate = typeof rawItem?.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawItem.due_date) ? rawItem.due_date : txDate;
      const requestedCatId = rawItem?.category_id ? String(rawItem.category_id) : null;
      const categoryId = requestedCatId && validCategories.get(requestedCatId) === type ? requestedCatId : null;
      if (!description || !Number.isFinite(amount) || amount <= 0) {
        continue;
      }
      const status = settleImmediately ? "PAID" : "PENDING";
      const paidAmount = settleImmediately ? amount : null;
      const paymentMethod = targetType === "CARD" ? "CARD" : typeof rawItem?.payment_method === "string" && rawItem.payment_method ? rawItem.payment_method : "PIX";
      const insertRes = await client.query(
        `INSERT INTO transactions (
           family_id, account_id, credit_card_id, category_id,
           description, amount, paid_amount, type, status,
           transaction_date, due_date, installment_number, total_installments, payment_method
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 1, $12)
         RETURNING *`,
        [
          family_id,
          targetType === "ACCOUNT" ? accountId : null,
          targetType === "CARD" ? creditCardId : null,
          categoryId,
          description,
          amount,
          paidAmount,
          type,
          status,
          txDate,
          dueDate,
          paymentMethod
        ]
      );
      createdTransactions.push(insertRes.rows[0]);
      if (settleImmediately) {
        netBalanceAdjustment += type === "INCOME" ? amount : -amount;
      }
    }
    if (createdTransactions.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Nenhum lan\xE7amento v\xE1lido foi encontrado para importar." });
    }
    if (settleImmediately && accountId && netBalanceAdjustment !== 0) {
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3",
        [Math.round(netBalanceAdjustment * 100) / 100, accountId, family_id]
      );
    }
    await client.query("COMMIT");
    return res.status(201).json({
      message: `${createdTransactions.length} lan\xE7amento(s) importado(s) com sucesso!`,
      imported_count: createdTransactions.length,
      transactions: createdTransactions
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro na importa\xE7\xE3o em lote:", err);
    return res.status(500).json({ error: "N\xE3o foi poss\xEDvel concluir a importa\xE7\xE3o em lote." });
  } finally {
    client.release();
  }
});
router4.get("/api/goals", requireFamilyPermission("family_read"), async (req, res) => {
  const family_id = req.familyAccess.familyId;
  try {
    const result = await pool.query(`SELECT * FROM goals WHERE family_id = $1 ORDER BY created_at DESC`, [String(family_id)]);
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router4.post("/api/goals", requireFamilyPermission("goals_manage"), async (req, res) => {
  const { title, target_amount, months } = req.body;
  const family_id = req.familyAccess.familyId;
  if (!family_id || !title || !target_amount || !months) {
    return res.status(400).json({ error: "family_id, title, target_amount e months s\xE3o obrigat\xF3rios." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const goalRes = await client.query(
      `INSERT INTO goals (family_id, title, target_amount, months) VALUES ($1, $2, $3, $4) RETURNING *;`,
      [family_id, title, target_amount, months]
    );
    const investmentCategoryId = await ensureInvestmentCategory(client, Number(family_id));
    const totalInst = Math.max(1, Number(months));
    const instAmount = Math.round(Number(target_amount) / totalInst * 100) / 100;
    const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    let parentId = null;
    for (let i = 1; i <= totalInst; i++) {
      const [year, month, day] = today.split("-");
      const targetDate = new Date(Number(year), Number(month) - 1 + (i - 1), Number(day));
      const formattedDueDate = targetDate.toISOString().split("T")[0];
      const txDesc = `Objetivo: ${title} (${i}/${totalInst})`;
      const txRes = await client.query(
        `INSERT INTO transactions (
          family_id, category_id, description, amount, type, status, transaction_date, due_date,
          installment_number, total_installments, parent_transaction_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;`,
        [
          family_id,
          investmentCategoryId,
          txDesc,
          instAmount,
          "EXPENSE",
          "PENDING",
          today,
          formattedDueDate,
          i,
          totalInst,
          parentId
        ]
      );
      if (i === 1) {
        parentId = txRes.rows[0].id;
      }
    }
    await client.query("COMMIT");
    return res.status(201).json({ message: "Objetivo criado com sucesso!", goal: goalRes.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.put("/api/transactions/:id", requireFamilyPermission("transactions_edit"), async (req, res) => {
  const { id } = req.params;
  const { description, amount, due_date, status, category_id, account_id, payment_method } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transactionResult = await client.query(
      "SELECT family_id, type, status, amount, paid_amount, account_id FROM transactions WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [id, req.familyAccess.familyId]
    );
    const transaction = transactionResult.rows[0];
    if (!transaction) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transa\xE7\xE3o n\xE3o encontrada." });
    }
    const nextStatus = status ?? transaction.status;
    if (nextStatus !== transaction.status) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Use as a\xE7\xF5es de baixa ou estorno para alterar o status do lan\xE7amento." });
    }
    const parsedAmount = Number(amount);
    if (typeof description !== "string" || !description.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0 || typeof due_date !== "string" || !due_date) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Informe descri\xE7\xE3o, valor e vencimento v\xE1lidos." });
    }
    if (category_id) {
      const categoryResult = await client.query(
        "SELECT id FROM categories WHERE id = $1 AND family_id = $2 AND flow_type = $3 FOR SHARE",
        [category_id, transaction.family_id, transaction.type]
      );
      if (categoryResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A categoria selecionada n\xE3o pertence a esta fam\xEDlia ou ao tipo do lan\xE7amento." });
      }
    }
    const nextAccountId = payment_method === "CARD" && transaction.status !== "PAID" ? null : account_id || transaction.account_id || null;
    const previousPaidAmount = Number(transaction.paid_amount ?? transaction.amount);
    const nextPaidAmount = transaction.status === "PAID" ? Math.max(parsedAmount, previousPaidAmount + parsedAmount - Number(transaction.amount)) : null;
    if (nextAccountId) {
      const accountResult = await client.query(
        "SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE",
        [nextAccountId, req.familyAccess.familyId]
      );
      if (accountResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "A conta selecionada n\xE3o pertence a esta fam\xEDlia." });
      }
    }
    if (transaction.status === "PAID" && (previousPaidAmount !== nextPaidAmount || String(transaction.account_id) !== String(nextAccountId))) {
      if (!transaction.account_id || !nextAccountId) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "N\xE3o \xE9 poss\xEDvel ajustar o saldo de um lan\xE7amento pago sem uma conta vinculada." });
      }
      const previousAccountResult = await client.query(
        "SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE",
        [transaction.account_id, req.familyAccess.familyId]
      );
      if (previousAccountResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "A conta vinculada ao lan\xE7amento pago n\xE3o pertence mais a esta fam\xEDlia." });
      }
      const balanceSign = transaction.type === "INCOME" ? 1 : -1;
      if (String(transaction.account_id) === String(nextAccountId)) {
        await client.query(
          "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3",
          [balanceSign * (Number(nextPaidAmount) - previousPaidAmount), nextAccountId, req.familyAccess.familyId]
        );
      } else {
        await client.query(
          "UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND family_id = $3",
          [balanceSign * previousPaidAmount, transaction.account_id, req.familyAccess.familyId]
        );
        await client.query(
          "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3",
          [balanceSign * Number(nextPaidAmount), nextAccountId, req.familyAccess.familyId]
        );
      }
    }
    const result = await client.query(
      `UPDATE transactions
       SET description = $1, amount = $2, due_date = $3, category_id = $4, account_id = $5, payment_method = $6, paid_amount = $7
       WHERE id = $8 AND family_id = $9 RETURNING *`,
      [
        description.trim(),
        parsedAmount,
        due_date,
        category_id || null,
        nextAccountId,
        payment_method || "BOLETO",
        nextPaidAmount,
        id,
        req.familyAccess.familyId
      ]
    );
    await client.query("COMMIT");
    return res.json({ message: "Transa\xE7\xE3o atualizada.", transaction: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.patch("/api/transactions/:id/pay", requireFamilyPermission("transactions_settle"), async (req, res) => {
  const { id } = req.params;
  const { account_id, paid_amount } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transactionResult = await client.query(
      "SELECT id, family_id, amount, type, status, account_id FROM transactions WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [id, req.familyAccess.familyId]
    );
    const transaction = transactionResult.rows[0];
    if (!transaction) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transa\xE7\xE3o n\xE3o encontrada." });
    }
    if (transaction.status === "PAID") {
      await client.query("COMMIT");
      return res.json({ message: "Lan\xE7amento j\xE1 est\xE1 pago.", transaction });
    }
    const finalAmount = Number(paid_amount ?? transaction.amount);
    const validPaidAmount = Number.isFinite(finalAmount) && finalAmount > 0 && (transaction.type === "EXPENSE" ? finalAmount >= Number(transaction.amount) : finalAmount === Number(transaction.amount));
    if (!validPaidAmount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "O valor pago deve ser v\xE1lido e n\xE3o pode ser inferior ao valor do lan\xE7amento." });
    }
    let accountId = account_id || transaction.account_id;
    if (!accountId) {
      const defaultAccountResult = await client.query(
        "SELECT id FROM accounts WHERE family_id = $1 ORDER BY name ASC LIMIT 1 FOR UPDATE",
        [transaction.family_id]
      );
      accountId = defaultAccountResult.rows[0]?.id;
    }
    if (!accountId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Selecione uma conta para registrar o pagamento." });
    }
    const accountResult = await client.query(
      "SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [accountId, transaction.family_id]
    );
    if (accountResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "A conta selecionada n\xE3o pertence \xE0 fam\xEDlia deste lan\xE7amento." });
    }
    const balanceChange = transaction.type === "INCOME" ? finalAmount : -finalAmount;
    await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3",
      [balanceChange, accountId, req.familyAccess.familyId]
    );
    const updatedTransaction = await client.query(
      "UPDATE transactions SET status = 'PAID', account_id = $2, paid_amount = $3 WHERE id = $1 AND family_id = $4 RETURNING *",
      [id, accountId, finalAmount, req.familyAccess.familyId]
    );
    await client.query("COMMIT");
    return res.json({ message: "Lan\xE7amento baixado com sucesso.", transaction: updatedTransaction.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.patch("/api/transactions/:id/unpay", requireFamilyPermission("transactions_settle"), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transactionResult = await client.query(
      "SELECT id, family_id, amount, paid_amount, type, status, account_id FROM transactions WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [id, req.familyAccess.familyId]
    );
    const transaction = transactionResult.rows[0];
    if (!transaction) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transa\xE7\xE3o n\xE3o encontrada." });
    }
    if (transaction.status !== "PAID") {
      await client.query("COMMIT");
      return res.json({ message: "Lan\xE7amento j\xE1 est\xE1 pendente.", transaction });
    }
    if (!transaction.account_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "N\xE3o \xE9 poss\xEDvel estornar este lan\xE7amento porque ele n\xE3o possui uma conta vinculada." });
    }
    const accountResult = await client.query(
      "SELECT id FROM accounts WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [transaction.account_id, req.familyAccess.familyId]
    );
    if (accountResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A conta vinculada ao lan\xE7amento n\xE3o pertence mais a esta fam\xEDlia." });
    }
    const settledAmount = Number(transaction.paid_amount ?? transaction.amount);
    const balanceChange = transaction.type === "INCOME" ? -settledAmount : settledAmount;
    await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3",
      [balanceChange, transaction.account_id, req.familyAccess.familyId]
    );
    const updatedTransaction = await client.query(
      "UPDATE transactions SET status = 'PENDING', paid_amount = NULL WHERE id = $1 AND family_id = $2 RETURNING *",
      [id, req.familyAccess.familyId]
    );
    await client.query("COMMIT");
    return res.json({ message: "Baixa estornada com sucesso.", transaction: updatedTransaction.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
router4.delete("/api/transactions/:id", requireFamilyPermission("transactions_delete"), async (req, res) => {
  const { id } = req.params;
  const { scope, parent_id } = req.query;
  const deleteSeries = scope === "all" && parent_id && parent_id !== "null";
  const transactionFilter = deleteSeries ? "id = $1 OR parent_transaction_id = $1 OR id = $2 OR parent_transaction_id = $2" : "id = $1";
  const transactionParams = deleteSeries ? [parent_id, id] : [id];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT id FROM transactions WHERE (${transactionFilter}) AND family_id = $${transactionParams.length + 1} FOR UPDATE`,
      [...transactionParams, req.familyAccess.familyId]
    );
    const paidTransactionBalances = await client.query(
      `SELECT account_id, family_id, type, SUM(COALESCE(paid_amount, amount)) AS amount_to_restore
       FROM transactions
       WHERE (${transactionFilter}) AND family_id = $${transactionParams.length + 1}
         AND type IN ('EXPENSE', 'INCOME') AND status = 'PAID' AND account_id IS NOT NULL
       GROUP BY account_id, family_id, type
       ORDER BY account_id`,
      [...transactionParams, req.familyAccess.familyId]
    );
    for (const transaction of paidTransactionBalances.rows) {
      const balanceChange = transaction.type === "INCOME" ? -Number(transaction.amount_to_restore) : Number(transaction.amount_to_restore);
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND family_id = $3",
        [balanceChange, transaction.account_id, transaction.family_id]
      );
    }
    await client.query(
      `DELETE FROM transactions WHERE (${transactionFilter}) AND family_id = $${transactionParams.length + 1}`,
      [...transactionParams, req.familyAccess.familyId]
    );
    await client.query("COMMIT");
    return res.json({ message: "Transa\xE7\xE3o apagada com sucesso." });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
var route_default = router4;

// src/server.ts
import_dotenv2.default.config();
var app = (0, import_express5.default)();
app.use((0, import_cors.default)());
app.use(import_express5.default.json());
app.use(route_default);
var PORT = process.env.PORT || 4e3;
initializeAccessControl().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor FinanFamily rodando na porta ${PORT}`);
  });
}).catch((error) => {
  console.error("Falha ao preparar permiss\xF5es familiares:", error);
  process.exit(1);
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  pool
});
