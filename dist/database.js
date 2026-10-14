"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const connectionString = process.env.DATABASE_URL;
exports.pool = new pg_1.Pool(connectionString
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
    });
// Teste de conexão opcional ao iniciar
exports.pool.on('connect', () => {
    console.log(' Conectado com sucesso ao banco PostgreSQL (Neon)!');
});
exports.pool.on('error', (err) => {
    console.error(' Erro inesperado no cliente do pool PostgreSQL:', err);
});
