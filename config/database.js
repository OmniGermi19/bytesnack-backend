const mysql = require('mysql2');
require('dotenv').config();

// Configuración usando variables de entorno de Railway
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql.railway.internal',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'railway',
    port: parseInt(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Probar conexión
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR conectando a MySQL:', err.message);
    } else {
        console.log('✅ Conectado a MySQL correctamente');
        console.log('   Host:', process.env.DB_HOST);
        console.log('   Database:', process.env.DB_NAME);
        connection.release();
    }
});

const promisePool = pool.promise();
module.exports = promisePool;