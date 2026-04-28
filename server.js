const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

if (!process.env.JWT_SECRET) {
    console.warn('⚠️ ADVERTENCIA: JWT_SECRET no está definido. Usando valor por defecto');
    process.env.JWT_SECRET = 'bytesnack-super-secret-key-change-in-production';
}

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

pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ ERROR conectando a MySQL:', err.message);
    } else {
        console.log('✅ Conectado a MySQL correctamente');
        connection.release();
        inicializarBaseDatos();
    }
});

async function inicializarBaseDatos() {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS users (
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
        )`);
        console.log('✅ Tabla users verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS products (
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
            FULLTEXT INDEX idx_search (name, description)
        )`);
        console.log('✅ Tabla products verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS cart_items (
            id INT PRIMARY KEY AUTO_INCREMENT,
            userId INT NOT NULL,
            productId INT NOT NULL,
            quantity INT NOT NULL DEFAULT 1,
            addedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE,
            UNIQUE KEY unique_cart_item (userId, productId)
        )`);
        console.log('✅ Tabla cart_items verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS orders (
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
        )`);
        console.log('✅ Tabla orders verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS order_items (
            id INT PRIMARY KEY AUTO_INCREMENT,
            orderId INT NOT NULL,
            productId INT NOT NULL,
            productName VARCHAR(200) NOT NULL,
            quantity INT NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            imageUrl VARCHAR(500),
            FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
            INDEX idx_orderId (orderId)
        )`);
        console.log('✅ Tabla order_items verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS notifications (
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
        )`);
        console.log('✅ Tabla notifications verificada');

        const [admins] = await db.query('SELECT id FROM users WHERE role = "Administrador" LIMIT 1');
        if (admins.length === 0) {
            const bcrypt = require('bcryptjs');
            const hashedPassword = await bcrypt.hash('Admin123*', 10);
            await db.query(`INSERT INTO users (role, numeroControl, nombreCompleto, email, password, codigoAcceso, isActive, createdAt)
                VALUES ('Administrador', 'ADMIN001', 'Administrador ByteSnack', 'admin@bytesnack.com', ?, 'Admin123*', TRUE, NOW())`, [hashedPassword]);
            console.log('✅ Usuario administrador creado (ADMIN001 / Admin123*)');
        }

        console.log('📦 Base de datos inicializada correctamente');
    } catch (error) {
        console.error('❌ Error inicializando BD:', error.message);
    }
}

// ============ RUTAS ============
app.get('/', (req, res) => {
    res.json({ message: 'ByteSnack API - Servidor funcionando', version: '2.0.0', status: 'online' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// Importar rutas (AHORA SÍ ENCONTRARÁ LOS ARCHIVOS)
const authRouter = require('./routes/auth')(db);
const productsRouter = require('./routes/products')(db);
const adminRouter = require('./routes/admin')(db);
const ordersRouter = require('./routes/orders')(db);
const usersRouter = require('./routes/users')(db);
const cartRouter = require('./routes/cart')(db);
const salesRouter = require('./routes/sales')(db);
const notificationsRouter = require('./routes/notifications')(db);

app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/users', usersRouter);
app.use('/api/cart', cartRouter);
app.use('/api/sales', salesRouter);
app.use('/api/notifications', notificationsRouter);

app.use('*', (req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada', message: `La ruta ${req.originalUrl} no existe` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});