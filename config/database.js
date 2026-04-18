const mysql = require('mysql2');
require('dotenv').config();

// Usar DATABASE_URL de Railway (la conexión automática)
let pool;

if (process.env.DATABASE_URL) {
    // Conexión usando URL completa
    pool = mysql.createPool(process.env.DATABASE_URL);
    console.log('📡 Conectando usando DATABASE_URL');
} else {
    // Fallback: variables individuales
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'mysql.railway.internal',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'railway',
        port: parseInt(process.env.DB_PORT) || 3306,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
    console.log('📡 Conectando usando variables individuales');
}

// Probar conexión
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR conectando a MySQL:', err.message);
    } else {
        console.log('✅ Conectado a MySQL correctamente');
        connection.release();
    }
});

module.exports = pool.promise();