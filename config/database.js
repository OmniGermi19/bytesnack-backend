// backend/config/db.js
const mysql = require('mysql2/promise');

let pool = null;
let connection = null;

/**
 * Obtiene un pool de conexiones a MySQL
 * @returns {Promise<mysql.Pool>}
 */
async function getPool() {
    if (pool) return pool;
    
    try {
        let config;
        
        if (process.env.DATABASE_URL) {
            console.log('📡 [DB] Conectando usando DATABASE_URL');
            config = process.env.DATABASE_URL;
        } else {
            console.log('📡 [DB] Conectando usando variables individuales');
            config = {
                host: process.env.MYSQLHOST || process.env.DB_HOST || 'mysql.railway.internal',
                port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306'),
                user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
                password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
                database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'railway',
                waitForConnections: true,
                connectionLimit: 20,
                queueLimit: 0,
                enableKeepAlive: true,
                keepAliveInitialDelay: 0
            };
        }
        
        pool = mysql.createPool(config);
        
        // Probar conexión
        const testConn = await pool.getConnection();
        console.log('✅ [DB] Pool de conexiones establecido correctamente');
        testConn.release();
        
        return pool;
    } catch (error) {
        console.error('❌ [DB] Error creando pool de conexiones:', error.message);
        throw error;
    }
}

/**
 * Obtiene una conexión directa (para operaciones que requieren transacciones)
 * @returns {Promise<mysql.Connection>}
 */
async function getConnection() {
    if (connection && !connection.destroyed) {
        return connection;
    }
    
    const pool = await getPool();
    connection = await pool.getConnection();
    return connection;
}

/**
 * Ejecuta una consulta SQL usando el pool
 * @param {string} query - Consulta SQL
 * @param {Array} params - Parámetros para la consulta
 * @returns {Promise<[any, any]>}
 */
async function executeQuery(query, params = []) {
    const poolConn = await getPool();
    return poolConn.execute(query, params);
}

/**
 * Ejecuta una transacción con múltiples queries
 * @param {Function} callback - Función async que recibe la conexión
 * @returns {Promise<any>}
 */
async function transaction(callback) {
    const conn = await getConnection();
    
    try {
        await conn.beginTransaction();
        const result = await callback(conn);
        await conn.commit();
        return result;
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

/**
 * Cierra todas las conexiones (útil para graceful shutdown)
 */
async function closeConnections() {
    if (connection) {
        await connection.release();
        connection = null;
    }
    if (pool) {
        await pool.end();
        pool = null;
        console.log('🔌 [DB] Conexiones cerradas correctamente');
    }
}

// Manejar cierre de la aplicación
process.on('SIGINT', async () => {
    console.log('🛑 [DB] Cerrando conexiones por SIGINT...');
    await closeConnections();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 [DB] Cerrando conexiones por SIGTERM...');
    await closeConnections();
    process.exit(0);
});

module.exports = {
    getPool,
    getConnection,
    executeQuery,
    transaction,
    closeConnections
};