const mysql = require('mysql2');
require('dotenv').config();

console.log('📡 Conectando a MySQL...');

// Usar DATABASE_URL de Railway
let pool;

if (process.env.DATABASE_URL) {
    console.log('📡 Usando DATABASE_URL');
    pool = mysql.createPool(process.env.DATABASE_URL);
} else {
    console.log('📡 Usando variables individuales');
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'mysql.railway.internal',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'SnYXLbwsBLVeEDhyidgNrrpJcCHIXgmD',
        database: process.env.DB_NAME || 'bytesnack',
        port: parseInt(process.env.DB_PORT) || 3306,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
}

// Probar conexión
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR conectando a MySQL:');
        console.error('   Mensaje:', err.message);
        console.error('   Código:', err.code);
    } else {
        console.log('✅ Conectado a MySQL correctamente');
        console.log('   Base de datos:', process.env.DB_NAME || 'bytesnack');
        connection.release();
    }
});

module.exports = pool.promise();