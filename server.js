const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();

app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configuración de email - Versión mejorada
let emailTransporter = null;

const setupEmailTransporter = () => {
    // Para Gmail
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            tls: {
                rejectUnauthorized: false
            }
        });
        console.log('✅ Email configurado con Gmail');
    }
    // Para otros servicios (Outlook, etc.)
    else if (process.env.EMAIL_HOST && process.env.EMAIL_PORT && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        emailTransporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: parseInt(process.env.EMAIL_PORT),
            secure: process.env.EMAIL_SECURE === 'true',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        console.log('✅ Email configurado con SMTP');
    } else {
        console.log('⚠️ Email no configurado. Las notificaciones no se enviarán');
    }
};

setupEmailTransporter();

const sendEmail = async (to, subject, html) => {
    if (!emailTransporter) {
        console.log('⚠️ Email no configurado, no se puede enviar correo a:', to);
        return false;
    }
    
    if (!to || to.trim() === '') {
        console.log('⚠️ Destinatario de email vacío');
        return false;
    }
    
    try {
        const info = await emailTransporter.sendMail({
            from: `"ByteSnack ITESCO" <${process.env.EMAIL_USER}>`,
            to: to,
            subject: subject,
            html: html
        });
        console.log(`✅ Correo enviado a ${to} - Message ID: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error('❌ Error enviando correo:', error.message);
        return false;
    }
};

// Pool de conexiones MySQL
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

const promiseDb = db.promise();

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error de conexión a MySQL:', err.message);
        process.exit(1);
    }
    console.log('✅ Conectado a MySQL correctamente');
    connection.release();
});

// ==================== MIDDLEWARE ====================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'No se proporcionó token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expirado' });
        }
        return res.status(403).json({ message: 'Token inválido' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'Acceso denegado' });
    }
    next();
};

// ==================== RUTAS DE AUTENTICACIÓN ====================
app.post('/api/auth/register', async (req, res) => {
    const { role, numeroControl, nombreCompleto, carrera, email, telefono, password, codigoAcceso, credencialFotos, isVendedorTambien } = req.body;
    if (!numeroControl || !nombreCompleto || !role) {
        return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    try {
        if (role === 'Vendedor') {
            const vendedorRegex = /^\d{8}V$/i;
            if (!vendedorRegex.test(numeroControl)) {
                return res.status(400).json({ message: 'Formato inválido para vendedor. Debe ser 8 dígitos seguidos de V' });
            }
        } else if (role === 'Comprador') {
            const compradorRegex = /^\d{8}C$/i;
            if (!compradorRegex.test(numeroControl)) {
                return res.status(400).json({ message: 'Formato inválido para comprador. Debe ser 8 dígitos seguidos de C' });
            }
        }
        const [existing] = await promiseDb.query('SELECT id FROM users WHERE numeroControl = ?', [numeroControl]);
        if (existing.length > 0) {
            return res.status(400).json({ message: 'Este número de control ya está registrado' });
        }
        let hashedPassword = null;
        if (password) hashedPassword = await bcrypt.hash(password, 10);
        if (role === 'Administrador' && codigoAcceso !== process.env.ADMIN_SECRET_CODE) {
            return res.status(403).json({ message: 'Código de acceso inválido' });
        }
        const isActive = role === 'Comprador';
        const [result] = await promiseDb.query(
            `INSERT INTO users (role, numeroControl, nombreCompleto, carrera, email, telefono, password, codigoAcceso, credencialFotos, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0, 0, 0)`,
            [role, numeroControl, nombreCompleto, carrera || null, email || null, telefono || null, hashedPassword, codigoAcceso || null, credencialFotos ? JSON.stringify(credencialFotos) : null, isVendedorTambien || false, isActive]
        );
        const token = jwt.sign({ userId: result.insertId, role: role }, process.env.JWT_SECRET, { expiresIn: '7d' });
        const [users] = await promiseDb.query(`SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras FROM users WHERE id = ?`, [result.insertId]);
        res.status(201).json({ token, user: users[0], message: 'Usuario registrado exitosamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al registrar usuario' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { numeroControl, password, codigoAcceso, role } = req.body;
    if (!numeroControl) return res.status(400).json({ message: 'Número de control requerido' });
    try {
        const [users] = await promiseDb.query(`SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, password, codigoAcceso, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras FROM users WHERE numeroControl = ?`, [numeroControl]);
        if (users.length === 0) return res.status(401).json({ message: 'Credenciales incorrectas' });
        const user = users[0];
        if (!user.isActive) return res.status(401).json({ message: 'Cuenta desactivada o pendiente de aprobación' });
        if (user.role !== role) return res.status(401).json({ message: `No tienes una cuenta de ${role}` });
        let isValid = false;
        if (role === 'Administrador') {
            isValid = user.codigoAcceso === codigoAcceso;
        } else {
            isValid = await bcrypt.compare(password, user.password);
        }
        if (!isValid) return res.status(401).json({ message: 'Credenciales incorrectas' });
        const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
        const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, { expiresIn: '30d' });
        delete user.password;
        delete user.codigoAcceso;
        res.json({ token, refreshToken, user, message: 'Inicio de sesión exitoso' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al iniciar sesión' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ message: 'Sesión cerrada exitosamente' });
});

// ==================== RUTAS DE PRODUCTOS ====================
app.get('/api/products', async (req, res) => {
    const { category, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = `SELECT p.*, u.nombreCompleto as sellerName FROM products p JOIN users u ON p.sellerId = u.id WHERE p.status = 'approved' AND p.isAvailable = TRUE AND u.isActive = TRUE`;
    const params = [];
    if (category && category !== 'Todos') { query += ' AND p.category = ?'; params.push(category); }
    if (search && search.trim()) { query += ' AND (p.name LIKE ? OR p.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY p.createdAt DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    db.query(query, params, (err, products) => {
        if (err) return res.status(500).json({ message: 'Error al cargar productos' });
        const parsedProducts = products.map(p => ({ ...p, images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []) }));
        res.json(parsedProducts);
    });
});

app.get('/api/admin/pending-products', authenticateToken, isAdmin, (req, res) => {
    db.query(`SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail, u.numeroControl as sellerControl FROM products p JOIN users u ON p.sellerId = u.id WHERE p.status = 'pending' ORDER BY p.createdAt ASC`, (err, products) => {
        if (err) return res.status(500).json({ message: 'Error' });
        const parsedProducts = products.map(p => ({ ...p, images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []) }));
        res.json({ products: parsedProducts });
    });
});

app.post('/api/products', authenticateToken, (req, res) => {
    const { name, price, description, sellerId, sellerName, images, stock, location, category } = req.body;
    if (sellerId !== req.userId && req.userRole !== 'Administrador') return res.status(403).json({ message: 'No puedes crear productos para otro usuario' });
    db.query('SELECT id FROM users WHERE id = ? AND isActive = TRUE', [sellerId], (err, userRows) => {
        if (err || userRows.length === 0) return res.status(400).json({ message: 'El vendedor no existe o está inactivo' });
        db.query(`INSERT INTO products (name, price, description, sellerId, sellerName, images, stock, location, category, status, isAvailable, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', FALSE, NOW())`, [name, price, description, sellerId, sellerName, JSON.stringify(images || []), stock, location, category], (err, result) => {
            if (err) return res.status(500).json({ message: 'Error al crear producto' });
            res.status(201).json({ id: result.insertId, message: 'Producto creado. Pendiente de aprobación.' });
        });
    });
});

app.put('/api/admin/approve-product/:id', authenticateToken, isAdmin, (req, res) => {
    const { approved } = req.body;
    const status = approved ? 'approved' : 'rejected';
    db.query('UPDATE products SET status = ?, isAvailable = ? WHERE id = ?', [status, approved, req.params.id], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: `Producto ${approved ? 'aprobado' : 'rechazado'}` });
    });
});

// ==================== RUTAS DE ADMIN - VENDEDORES ====================
app.get('/api/admin/pending-vendors', authenticateToken, isAdmin, (req, res) => {
    db.query(`SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, credencialFotos, createdAt, isActive FROM users WHERE role = 'Vendedor' AND isActive = FALSE ORDER BY createdAt ASC`, (err, vendors) => {
        if (err) return res.status(500).json({ message: 'Error' });
        const parsedVendors = vendors.map(v => ({ ...v, credencialFotos: typeof v.credencialFotos === 'string' ? JSON.parse(v.credencialFotos || '[]') : (v.credencialFotos || []) }));
        res.json({ vendors: parsedVendors });
    });
});

app.post('/api/admin/approve-vendor', authenticateToken, isAdmin, async (req, res) => {
    const { userId, approved, rejectionReason } = req.body;

    try {
        await promiseDb.query('UPDATE users SET isActive = ? WHERE id = ?', [approved, userId]);
        
        const [vendors] = await promiseDb.query('SELECT email, nombreCompleto, numeroControl FROM users WHERE id = ?', [userId]);
        const vendor = vendors[0];
        
        if (approved) {
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '✅ Cuenta aprobada', 'Tu cuenta de vendedor ha sido aprobada. ¡Ya puedes iniciar sesión y publicar productos!', 'user_approval']
            );
            
            if (vendor && vendor.email) {
                const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head><meta charset="UTF-8"><title>Cuenta Aprobada</title></head>
                    <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
                        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; padding: 30px;">
                            <h1 style="color: #4CAF50;">✅ ¡Cuenta Aprobada!</h1>
                            <p>Hola <strong>${vendor.nombreCompleto}</strong>,</p>
                            <p>Tu cuenta de <strong>VENDEDOR</strong> ha sido aprobada exitosamente.</p>
                            <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <p><strong>📋 Tus credenciales:</strong></p>
                                <p>🔑 Número de control: <strong>${vendor.numeroControl}</strong></p>
                                <p>🔒 Contraseña: La que configuraste al registrarte</p>
                            </div>
                            <p>Ya puedes iniciar sesión y comenzar a publicar tus productos.</p>
                            <hr style="margin: 20px 0;">
                            <p style="font-size: 12px; color: #888;">ByteSnack ITESCO</p>
                        </div>
                    </body>
                    </html>
                `;
                await sendEmail(vendor.email, '✅ Tu cuenta de Vendedor ha sido aprobada', emailHtml);
                console.log(`Correo de aprobación enviado a: ${vendor.email}`);
            }
            res.json({ message: 'Vendedor aprobado exitosamente' });
        } else {
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '❌ Cuenta rechazada', `Tu cuenta ha sido rechazada. Motivo: ${rejectionReason || 'No especificado'}`, 'user_approval']
            );
            if (vendor && vendor.email) {
                const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head><meta charset="UTF-8"><title>Cuenta Rechazada</title></head>
                    <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
                        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; padding: 30px;">
                            <h1 style="color: #f44336;">❌ Cuenta Rechazada</h1>
                            <p>Hola <strong>${vendor.nombreCompleto}</strong>,</p>
                            <p>Tu solicitud de cuenta de vendedor ha sido rechazada.</p>
                            <div style="background: #fff3f3; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <p><strong>📝 Motivo:</strong> ${rejectionReason || 'No especificado'}</p>
                            </div>
                            <p>Puedes volver a intentar el registro corrigiendo la información.</p>
                            <hr style="margin: 20px 0;">
                            <p style="font-size: 12px; color: #888;">ByteSnack ITESCO</p>
                        </div>
                    </body>
                    </html>
                `;
                await sendEmail(vendor.email, '❌ Actualización sobre tu solicitud', emailHtml);
                console.log(`Correo de rechazo enviado a: ${vendor.email}`);
            }
            res.json({ message: 'Vendedor rechazado' });
        }
    } catch (error) {
        console.error('Error aprobando vendedor:', error);
        res.status(500).json({ message: 'Error al procesar la solicitud' });
    }
});

// ==================== RUTAS DE USUARIOS ====================
app.get('/api/users', authenticateToken, isAdmin, (req, res) => {
    db.query(`SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras FROM users ORDER BY createdAt DESC`, (err, users) => {
        if (err) {
            console.error('Error obteniendo usuarios:', err);
            return res.status(500).json({ message: 'Error al obtener usuarios' });
        }
        res.json(users);
    });
});

app.patch('/api/users/:userId/status', authenticateToken, isAdmin, (req, res) => {
    const { isActive } = req.body;
    if (parseInt(req.params.userId) === req.userId) return res.status(400).json({ message: 'No puedes desactivar tu propia cuenta' });
    db.query('UPDATE users SET isActive = ? WHERE id = ?', [isActive, req.params.userId], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: `Usuario ${isActive ? 'activado' : 'desactivado'}` });
    });
});

app.put('/api/users/:userId/role', authenticateToken, isAdmin, (req, res) => {
    const { role } = req.body;
    const validRoles = ['Comprador', 'Vendedor', 'Administrador'];
    if (!validRoles.includes(role)) return res.status(400).json({ message: 'Rol inválido' });
    db.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.userId], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: 'Rol actualizado' });
    });
});

// ==================== RUTAS DE ESTADÍSTICAS ====================
app.get('/api/admin/user-stats', authenticateToken, isAdmin, (req, res) => {
    const queries = {
        totalVendedores: 'SELECT COUNT(*) as count FROM users WHERE role = "Vendedor" AND isActive = TRUE',
        totalCompradores: 'SELECT COUNT(*) as count FROM users WHERE role = "Comprador" AND isActive = TRUE',
        totalPendientes: 'SELECT COUNT(*) as count FROM users WHERE role = "Vendedor" AND isActive = FALSE',
        totalAdministradores: 'SELECT COUNT(*) as count FROM users WHERE role = "Administrador" AND isActive = TRUE',
        pendientesProductos: 'SELECT COUNT(*) as count FROM products WHERE status = "pending"'
    };
    const results = {};
    let completed = 0;
    const total = Object.keys(queries).length;
    for (const [key, query] of Object.entries(queries)) {
        db.query(query, (err, rows) => {
            if (err) results[key] = 0;
            else results[key] = rows[0]?.count || 0;
            completed++;
            if (completed === total) res.json(results);
        });
    }
});

app.get('/api/admin/stats', authenticateToken, isAdmin, (req, res) => {
    const queries = {
        totalUsers: 'SELECT COUNT(*) as count FROM users',
        totalProducts: 'SELECT COUNT(*) as count FROM products WHERE status = "approved"',
        pendingProducts: 'SELECT COUNT(*) as count FROM products WHERE status = "pending"',
        totalOrders: 'SELECT COUNT(*) as count FROM orders',
        totalSales: 'SELECT SUM(total) as total FROM orders WHERE status = "delivered"'
    };
    const results = {};
    let completed = 0;
    const total = Object.keys(queries).length;
    for (const [key, query] of Object.entries(queries)) {
        db.query(query, (err, rows) => {
            if (err) results[key] = 0;
            else results[key] = rows[0]?.count || rows[0]?.total || 0;
            completed++;
            if (completed === total) res.json(results);
        });
    }
});

// ==================== RUTAS DE NOTIFICACIONES ====================
app.get('/api/notifications', authenticateToken, (req, res) => {
    db.query('SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC', [req.userId], (err, notifications) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ notifications });
    });
});

app.patch('/api/notifications/:id/read', authenticateToken, (req, res) => {
    db.query('UPDATE notifications SET isRead = 1 WHERE id = ? AND userId = ?', [req.params.id, req.userId], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: 'Notificación marcada como leída' });
    });
});

app.patch('/api/notifications/read-all', authenticateToken, (req, res) => {
    db.query('UPDATE notifications SET isRead = 1 WHERE userId = ?', [req.userId], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: 'Todas marcadas como leídas' });
    });
});

app.delete('/api/notifications/:id', authenticateToken, (req, res) => {
    db.query('DELETE FROM notifications WHERE id = ? AND userId = ?', [req.params.id, req.userId], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: 'Notificación eliminada' });
    });
});

app.post('/api/notifications/product-pending', authenticateToken, (req, res) => {
    const { productId, productName, sellerName } = req.body;
    db.query('SELECT id FROM users WHERE role = "Administrador" AND isActive = 1', (err, admins) => {
        if (err) return res.status(500).json({ message: 'Error' });
        for (const admin of admins) {
            db.query(`INSERT INTO notifications (userId, title, body, type, isRead, createdAt, data) VALUES (?, ?, ?, ?, 0, NOW(), ?)`, [admin.id, '📦 Nuevo producto pendiente', `El vendedor "${sellerName}" ha publicado: "${productName}"`, 'product_approval', JSON.stringify({ productId, productName, sellerName })]);
        }
        res.json({ message: 'Notificaciones enviadas' });
    });
});

// ==================== RUTAS DE CARRITO Y PEDIDOS ====================
app.get('/api/cart', authenticateToken, (req, res) => {
    db.query(`SELECT ci.*, p.name, p.price, p.images, p.sellerId, u.nombreCompleto as sellerName FROM cart_items ci JOIN products p ON ci.productId = p.id JOIN users u ON p.sellerId = u.id WHERE ci.userId = ?`, [req.userId], (err, items) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ items: items || [] });
    });
});

app.post('/api/cart/add', authenticateToken, (req, res) => {
    const { productId, quantity } = req.body;
    if (!productId || quantity < 1) return res.status(400).json({ message: 'Datos inválidos' });
    db.query(`INSERT INTO cart_items (userId, productId, quantity, addedAt) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE quantity = quantity + ?`, [req.userId, productId, quantity, quantity], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: 'Producto agregado' });
    });
});

app.put('/api/cart/:productId', authenticateToken, (req, res) => {
    const { quantity } = req.body;
    if (quantity === 0) {
        db.query('DELETE FROM cart_items WHERE userId = ? AND productId = ?', [req.userId, req.params.productId], (err) => {
            if (err) return res.status(500).json({ message: 'Error' });
            res.json({ message: 'Producto eliminado' });
        });
    } else {
        db.query('UPDATE cart_items SET quantity = ? WHERE userId = ? AND productId = ?', [quantity, req.userId, req.params.productId], (err) => {
            if (err) return res.status(500).json({ message: 'Error' });
            res.json({ message: 'Cantidad actualizada' });
        });
    }
});

app.delete('/api/cart/:productId', authenticateToken, (req, res) => {
    db.query('DELETE FROM cart_items WHERE userId = ? AND productId = ?', [req.userId, req.params.productId], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: 'Producto eliminado' });
    });
});

app.post('/api/orders', authenticateToken, async (req, res) => {
    const { items, total, paymentMethod, shippingAddress } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ message: 'Carrito vacío' });
    try {
        const [orderResult] = await promiseDb.query(`INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt) VALUES (?, ?, ?, ?, 'pending', NOW())`, [req.userId, total, paymentMethod, shippingAddress]);
        const orderId = orderResult.insertId;
        const orderItems = items.map(item => [orderId, item.productId, item.name, item.quantity, item.price, item.imageUrl]);
        await promiseDb.query('INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?', [orderItems]);
        await promiseDb.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
        res.status(201).json({ id: orderId, message: 'Pedido creado' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear pedido' });
    }
});

app.get('/api/orders', authenticateToken, (req, res) => {
    db.query('SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC', [req.userId], async (err, orders) => {
        if (err) return res.status(500).json({ message: 'Error' });
        for (const order of orders) {
            const [items] = await promiseDb.query('SELECT * FROM order_items WHERE orderId = ?', [order.id]);
            order.items = items;
        }
        res.json(orders);
    });
});

app.get('/api/sales', authenticateToken, (req, res) => {
    if (req.userRole !== 'Administrador' && req.userRole !== 'Vendedor') {
        return res.status(403).json({ message: 'Acceso denegado' });
    }
    db.query(`SELECT o.*, oi.productName, oi.quantity, oi.price, u.nombreCompleto as buyerName FROM orders o JOIN order_items oi ON o.id = oi.orderId JOIN products p ON oi.productId = p.id JOIN users u ON o.userId = u.id WHERE p.sellerId = ? ORDER BY o.createdAt DESC`, [req.userId], (err, sales) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ sales });
    });
});

// ==================== RUTA DE SALUD ====================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('*', (req, res) => {
    res.status(404).json({ message: `Ruta ${req.originalUrl} no encontrada` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});