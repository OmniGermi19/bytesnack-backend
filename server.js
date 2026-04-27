const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============ CONEXIÓN A MySQL ============
let pool;

if (process.env.DATABASE_URL) {
    console.log('📡 Conectando usando DATABASE_URL');
    pool = mysql.createPool(process.env.DATABASE_URL);
} else {
    console.log('📡 Conectando usando variables individuales');
    pool = mysql.createPool({
        host: process.env.MYSQLHOST || process.env.DB_HOST || 'mysql.railway.internal',
        port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306'),
        user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
        password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
        database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'railway',
        waitForConnections: true,
        connectionLimit: 15,
        queueLimit: 0,
        ssl: false
    });
}

const db = pool.promise();

// Probar conexión
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR conectando a MySQL:');
        console.error('   Mensaje:', err.message);
        console.error('   Código:', err.code);
    } else {
        console.log('✅ Conectado a MySQL correctamente');
        connection.release();
        inicializarBaseDatos();
    }
});

// Función para inicializar la base de datos
async function inicializarBaseDatos() {
    try {
        // Crear tabla users
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                role ENUM('Comprador', 'Vendedor', 'Administrador') NOT NULL DEFAULT 'Comprador',
                numeroControl VARCHAR(20) UNIQUE NOT NULL,
                nombreCompleto VARCHAR(100) NOT NULL,
                carrera VARCHAR(100),
                email VARCHAR(100),
                telefono VARCHAR(20),
                password VARCHAR(255),
                codigoAcceso VARCHAR(255),
                credencialFotos JSON,
                isVendedorTambien BOOLEAN DEFAULT FALSE,
                direccion TEXT,
                calificacion DECIMAL(3,2) DEFAULT 0,
                totalVentas INT DEFAULT 0,
                totalCompras INT DEFAULT 0,
                isActive BOOLEAN DEFAULT FALSE,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_numeroControl (numeroControl),
                INDEX idx_role (role),
                INDEX idx_isActive (isActive)
            )
        `);
        console.log('✅ Tabla users verificada/creada');

        // Crear tabla products
        await db.query(`
            CREATE TABLE IF NOT EXISTS products (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(200) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                description TEXT,
                sellerId INT NOT NULL,
                sellerName VARCHAR(100) NOT NULL,
                images JSON,
                stock INT DEFAULT 0,
                location VARCHAR(200),
                category VARCHAR(50) DEFAULT 'Otros',
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                isAvailable BOOLEAN DEFAULT FALSE,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (sellerId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_status (status),
                INDEX idx_category (category),
                INDEX idx_sellerId (sellerId),
                FULLTEXT INDEX idx_search (name, description)
            )
        `);
        console.log('✅ Tabla products verificada/creada');

        // Crear tabla cart_items
        await db.query(`
            CREATE TABLE IF NOT EXISTS cart_items (
                id INT PRIMARY KEY AUTO_INCREMENT,
                userId INT NOT NULL,
                productId INT NOT NULL,
                quantity INT NOT NULL DEFAULT 1,
                addedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE,
                UNIQUE KEY unique_cart_item (userId, productId)
            )
        `);
        console.log('✅ Tabla cart_items verificada/creada');

        // Crear tabla orders
        await db.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id INT PRIMARY KEY AUTO_INCREMENT,
                userId INT NOT NULL,
                total DECIMAL(10,2) NOT NULL,
                paymentMethod VARCHAR(50) DEFAULT 'Efectivo',
                shippingAddress TEXT,
                status ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_userId (userId),
                INDEX idx_status (status)
            )
        `);
        console.log('✅ Tabla orders verificada/creada');

        // Crear tabla order_items
        await db.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id INT PRIMARY KEY AUTO_INCREMENT,
                orderId INT NOT NULL,
                productId INT NOT NULL,
                productName VARCHAR(200) NOT NULL,
                quantity INT NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                imageUrl VARCHAR(500),
                FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
                INDEX idx_orderId (orderId)
            )
        `);
        console.log('✅ Tabla order_items verificada/creada');

        // Crear tabla notifications
        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INT PRIMARY KEY AUTO_INCREMENT,
                userId INT NOT NULL,
                title VARCHAR(200),
                body TEXT,
                type VARCHAR(50),
                isRead BOOLEAN DEFAULT FALSE,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_userId (userId),
                INDEX idx_isRead (isRead)
            )
        `);
        console.log('✅ Tabla notifications verificada/creada');

        // Verificar si existe admin, si no crearlo
        const [admins] = await db.query('SELECT id FROM users WHERE role = "Administrador" LIMIT 1');
        if (admins.length === 0) {
            await db.query(`
                INSERT INTO users (role, numeroControl, nombreCompleto, email, password, codigoAcceso, isActive, createdAt)
                VALUES ('Administrador', 'ADMIN001', 'Administrador ByteSnack', 'admin@bytesnack.com', 
                        '$2a$10$N9qo8uLOickgx2ZMRZoMy.Mr/.b7TJqFzYI8Zz5KqKqKqKqKqKqK', 
                        'Admin123*', TRUE, NOW())
            `);
            console.log('✅ Usuario administrador creado (ADMIN001 / Admin123*)');
        }

        console.log('📦 Base de datos inicializada correctamente');
    } catch (error) {
        console.error('❌ Error inicializando base de datos:', error.message);
    }
}

// ============ RUTAS PRINCIPALES ============

// Ruta raíz - IMPORTANTE: Esto soluciona el error "Cannot GET /"
app.get('/', (req, res) => {
    res.json({
        message: 'ByteSnack API - Servidor funcionando correctamente',
        version: '2.0.0',
        status: 'online',
        endpoints: {
            auth: '/api/auth',
            products: '/api/products',
            admin: '/api/admin',
            orders: '/api/orders',
            users: '/api/users',
            cart: '/api/cart',
            sales: '/api/sales',
            notifications: '/api/notifications',
            health: '/api/health'
        }
    });
});

// Endpoint de health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============ IMPORTAR ROUTERS MODULARES ============
const authRouter = require('./routes/auth')(db);
const productsRouter = require('./routes/products')(db);
const adminRouter = require('./routes/admin')(db);
const ordersRouter = require('./routes/orders')(db);
const usersRouter = require('./routes/users')(db);
const cartRouter = require('./routes/cart')(db);
const salesRouter = require('./routes/sales')(db);
const notificationsRouter = require('./routes/notifications')(db);

// ============ USAR ROUTERS ============
app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/users', usersRouter);
app.use('/api/cart', cartRouter);
app.use('/api/sales', salesRouter);
app.use('/api/notifications', notificationsRouter);

// ============ MANEJO DE RUTAS NO ENCONTRADAS ============
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        message: `La ruta ${req.originalUrl} no existe`,
        availableEndpoints: [
            'GET /',
            'GET /api/health',
            'POST /api/auth/login',
            'POST /api/auth/register',
            'GET /api/products',
            'POST /api/products',
            'GET /api/admin/stats',
            'GET /api/orders',
            'POST /api/orders',
            'GET /api/users',
            'GET /api/cart',
            'PUT /api/cart/:productId',
            'GET /api/sales',
            'GET /api/notifications'
        ]
    });
});

// ============ INICIAR SERVIDOR ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📡 API disponible en: http://localhost:${PORT}/api`);
    console.log(`🔗 Ruta raíz: http://localhost:${PORT}/`);
    console.log(`❤️ Health check: http://localhost:${PORT}/api/health`);
});