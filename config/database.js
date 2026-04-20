const mysql = require('mysql2');
require('dotenv').config();

let pool;

// Usar DATABASE_URL si existe (conexión externa)
if (process.env.DATABASE_URL) {
    console.log('📡 Conectando usando DATABASE_URL');
    pool = mysql.createPool(process.env.DATABASE_URL);
} 
// Usar variables MYSQL* de Railway (conexión interna)
else if (process.env.MYSQLHOST || process.env.DB_HOST) {
    console.log('📡 Conectando usando variables de Railway');
    pool = mysql.createPool({
        host: process.env.MYSQLHOST || process.env.DB_HOST,
        user: process.env.MYSQLUSER || process.env.DB_USER,
        password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
        database: process.env.MYSQLDATABASE || process.env.DB_NAME,
        port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306'),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
} 
// Fallback local para desarrollo
else {
    console.log('📡 Conectando usando configuración local (desarrollo)');
    pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'bytesnack',
        port: 3306,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
}

// Probar conexión al iniciar
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR conectando a MySQL:');
        console.error('   Mensaje:', err.message);
        console.error('   Código:', err.code);
        console.error('\n📌 Verifica:');
        console.error('   1. Que la base de datos "bytesnack" existe');
        console.error('   2. Que las credenciales son correctas');
        console.error('   3. Que la IP está permitida\n');
    } else {
        console.log('✅ Conectado a MySQL correctamente');
        console.log(`   Base de datos: ${connection.config.database}`);
        console.log(`   Host: ${connection.config.host}:${connection.config.port}`);
        connection.release();
    }
});

module.exports = pool.promise();