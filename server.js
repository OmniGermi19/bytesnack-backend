const express = require('express');
const http = require('http');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

if (!process.env.JWT_SECRET) {
    console.warn('⚠️ ADVERTENCIA: JWT_SECRET no definido. Usando valor por defecto');
    process.env.JWT_SECRET = 'bytesnack-super-secret-key-change-in-production';
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT') {
        const contentLength = req.headers['content-length'];
        if (contentLength) {
            console.log(`📡 [SERVER] ${req.method} ${req.url} - Tamaño: ${(parseInt(contentLength) / 1024 / 1024).toFixed(2)} MB`);
        }
    }
    next();
});

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

        // Agregar columnas de confirmación a orders
        await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sellerConfirmed BOOLEAN DEFAULT FALSE`);
        await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyerReceived BOOLEAN DEFAULT FALSE`);
        await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sellerConfirmedAt TIMESTAMP NULL`);
        await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyerReceivedAt TIMESTAMP NULL`);
        console.log('✅ Columnas de confirmación agregadas a orders');

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
            credencialFotos LONGTEXT,
            isVendedorTambien BOOLEAN DEFAULT FALSE,
            direccion TEXT,
            profileImage LONGTEXT,
            calificacion DECIMAL(3,2) DEFAULT 0,
            totalVentas INT DEFAULT 0,
            totalCompras INT DEFAULT 0,
            isActive BOOLEAN DEFAULT FALSE,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            deletedAt TIMESTAMP NULL,
            deletionReason TEXT,
            reportCount INT DEFAULT 0,
            isBanned BOOLEAN DEFAULT FALSE,
            banReason TEXT,
            bannedAt TIMESTAMP NULL,
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
            images LONGTEXT,
            stock INT DEFAULT 0,
            location VARCHAR(200),
            category VARCHAR(50) DEFAULT 'Otros',
            status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
            isAvailable BOOLEAN DEFAULT FALSE,
            isHidden BOOLEAN DEFAULT FALSE,
            hiddenReason TEXT,
            hiddenAt TIMESTAMP NULL,
            reportCount INT DEFAULT 0,
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

        await db.query(`CREATE TABLE IF NOT EXISTS pending_profile_changes (
            id INT PRIMARY KEY AUTO_INCREMENT,
            userId INT NOT NULL,
            nombreCompleto VARCHAR(100),
            carrera VARCHAR(100),
            email VARCHAR(100),
            telefono VARCHAR(20),
            direccion TEXT,
            profileImage LONGTEXT,
            status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewedAt TIMESTAMP NULL,
            rejectionReason TEXT,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_userId (userId),
            INDEX idx_status (status)
        )`);
        console.log('✅ Tabla pending_profile_changes verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS reviews (
            id INT PRIMARY KEY AUTO_INCREMENT,
            orderId INT NOT NULL,
            productId INT NOT NULL,
            productName VARCHAR(200) NOT NULL,
            userId INT NOT NULL,
            userName VARCHAR(100) NOT NULL,
            rating DECIMAL(2,1) NOT NULL,
            comment TEXT,
            images LONGTEXT,
            isVerifiedPurchase BOOLEAN DEFAULT FALSE,
            likes INT DEFAULT 0,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_productId (productId),
            INDEX idx_userId (userId),
            INDEX idx_rating (rating)
        )`);
        console.log('✅ Tabla reviews verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS review_replies (
            id INT PRIMARY KEY AUTO_INCREMENT,
            reviewId INT NOT NULL,
            userId INT NOT NULL,
            userName VARCHAR(100) NOT NULL,
            comment TEXT NOT NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (reviewId) REFERENCES reviews(id) ON DELETE CASCADE,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_reviewId (reviewId)
        )`);
        console.log('✅ Tabla review_replies verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS review_likes (
            id INT PRIMARY KEY AUTO_INCREMENT,
            reviewId INT NOT NULL,
            userId INT NOT NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (reviewId) REFERENCES reviews(id) ON DELETE CASCADE,
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE KEY unique_like (reviewId, userId)
        )`);
        console.log('✅ Tabla review_likes verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS chats (
            id INT PRIMARY KEY AUTO_INCREMENT,
            orderId INT NOT NULL,
            productId INT NOT NULL,
            productName VARCHAR(200) NOT NULL,
            buyerId INT NOT NULL,
            sellerId INT NOT NULL,
            lastMessage TEXT,
            lastMessageTime TIMESTAMP NULL,
            buyerUnreadCount INT DEFAULT 0,
            sellerUnreadCount INT DEFAULT 0,
            status ENUM('active', 'closed') DEFAULT 'active',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY (buyerId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (sellerId) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_orderId (orderId),
            INDEX idx_buyerId (buyerId),
            INDEX idx_sellerId (sellerId),
            UNIQUE KEY unique_chat (orderId, productId)
        )`);
        console.log('✅ Tabla chats verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS messages (
            id INT PRIMARY KEY AUTO_INCREMENT,
            chatId INT NOT NULL,
            senderId INT NOT NULL,
            senderName VARCHAR(100) NOT NULL,
            senderRole ENUM('Comprador', 'Vendedor', 'Administrador') NOT NULL,
            message TEXT NOT NULL,
            type ENUM('text', 'image') DEFAULT 'text',
            imageUrl VARCHAR(500),
            isRead BOOLEAN DEFAULT FALSE,
            readAt TIMESTAMP NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
            FOREIGN KEY (senderId) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_chatId (chatId),
            INDEX idx_createdAt (createdAt)
        )`);
        console.log('✅ Tabla messages verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS tracking_sessions (
            id INT PRIMARY KEY AUTO_INCREMENT,
            orderId INT UNIQUE NOT NULL,
            sellerId INT NULL,
            status ENUM('pending', 'active', 'ended') DEFAULT 'pending',
            startedAt TIMESTAMP NULL,
            endedAt TIMESTAMP NULL,
            lastLat DECIMAL(10,8) NULL,
            lastLng DECIMAL(11,8) NULL,
            lastAddress TEXT NULL,
            lastSpeed DECIMAL(10,2) NULL,
            lastAccuracy DECIMAL(10,2) NULL,
            lastLocationUpdate TIMESTAMP NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY (sellerId) REFERENCES users(id) ON DELETE SET NULL,
            INDEX idx_orderId (orderId),
            INDEX idx_status (status)
        )`);
        console.log('✅ Tabla tracking_sessions verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS tracking_locations (
            id INT PRIMARY KEY AUTO_INCREMENT,
            orderId INT NOT NULL,
            lat DECIMAL(10,8) NOT NULL,
            lng DECIMAL(11,8) NOT NULL,
            address TEXT,
            speed DECIMAL(10,2) NULL,
            accuracy DECIMAL(10,2) NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (orderId) REFERENCES orders(id) ON DELETE CASCADE,
            INDEX idx_orderId (orderId),
            INDEX idx_createdAt (createdAt)
        )`);
        console.log('✅ Tabla tracking_locations verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS reports (
            id INT PRIMARY KEY AUTO_INCREMENT,
            reporterId INT NOT NULL,
            reportedUserId INT NOT NULL,
            reason VARCHAR(100) NOT NULL,
            description TEXT,
            status ENUM('pending', 'reviewed', 'dismissed') DEFAULT 'pending',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewedAt TIMESTAMP NULL,
            reviewedBy INT NULL,
            adminNotes TEXT,
            FOREIGN KEY (reporterId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (reportedUserId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (reviewedBy) REFERENCES users(id) ON DELETE SET NULL,
            INDEX idx_status (status),
            INDEX idx_reportedUser (reportedUserId)
        )`);
        console.log('✅ Tabla reports verificada');

        await db.query(`CREATE TABLE IF NOT EXISTS product_reports (
            id INT PRIMARY KEY AUTO_INCREMENT,
            reporterId INT NOT NULL,
            productId INT NOT NULL,
            productName VARCHAR(200) NOT NULL,
            reason VARCHAR(100) NOT NULL,
            description TEXT,
            status ENUM('pending', 'reviewed', 'dismissed', 'product_removed') DEFAULT 'pending',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewedAt TIMESTAMP NULL,
            reviewedBy INT NULL,
            adminNotes TEXT,
            FOREIGN KEY (reporterId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (reviewedBy) REFERENCES users(id) ON DELETE SET NULL,
            INDEX idx_status (status),
            INDEX idx_productId (productId)
        )`);
        console.log('✅ Tabla product_reports verificada');

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

// Importar routers
const authRouter = require('./routes/auth')(db);
const productsRouter = require('./routes/products')(db);
const adminRouter = require('./routes/admin')(db);
const ordersRouter = require('./routes/orders')(db);
const usersRouter = require('./routes/users')(db);
const cartRouter = require('./routes/cart')(db);
const salesRouter = require('./routes/sales')(db);
const notificationsRouter = require('./routes/notifications')(db);
const reviewsRouter = require('./routes/reviews')(db);
const chatRouter = require('./routes/chat')(db);
const reportsRouter = require('./routes/reports')(db);

app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/users', usersRouter);
app.use('/api/cart', cartRouter);
app.use('/api/sales', salesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/reports', reportsRouter);

// Tracking
const TrackingService = require('./services/trackingService');
const trackingRouter = require('./routes/tracking');

const server = http.createServer(app);
const trackingService = new TrackingService(server);
const trackingRoutes = trackingRouter(db, trackingService);
app.use('/api/tracking', trackingRoutes);

app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        message: `La ruta ${req.originalUrl} no existe`
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📡 API disponible en: http://localhost:${PORT}/api`);
    console.log(`🔌 WebSocket disponible en: ws://localhost:${PORT}/ws/tracking`);
    console.log(`❤️ Health check: http://localhost:${PORT}/api/health`);
});