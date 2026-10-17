// Uso: npm run seed -- admin@empresa.com SenhaForte123 "Nome do Admin"
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

(async () => {
  const [, , email, password, name = 'Administrador'] = process.argv;
  if (!email || !password || password.length < 8) {
    console.error('Informe e-mail e uma senha com 8+ caracteres.');
    process.exit(1);
  }
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'crm',
  });
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin') ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash)",
    [name, email, hash]
  );
  console.log('Administrador pronto:', email);
  await db.end();
})();
