const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// MySQL connection pool
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

const promiseDb = db.promise();

// Email setup (optional)
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
}

// ============ MIDDLEWARE ============
const auth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'No token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        next();
    } catch (e) {
        return res.status(401).json({ message: 'Invalid token' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.userRole !== 'Administrador') return res.status(403).json({ message: 'Admin only' });
    next();
};

// ============ AUTH ============
app.post('/api/auth/register', async (req, res) => {
    const { role, numeroControl, nombreCompleto, carrera, email, telefono, password, codigoAcceso, credencialFotos } = req.body;
    try {
        if (role === 'Vendedor' && !/^\d{8}V$/i.test(numeroControl))
            return res.status(400).json({ message: 'Formato inválido: 8 dígitos + V' });
        if (role === 'Comprador' && !/^\d{8}C$/i.test(numeroControl))
            return res.status(400).json({ message: 'Formato inválido: 8 dígitos + C' });

        const [exist] = await promiseDb.query('SELECT id FROM users WHERE numeroControl = ?', [numeroControl]);
        if (exist.length) return res.status(400).json({ message: 'Ya registrado' });

        const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
        const isActive = role === 'Comprador';

        const [result] = await promiseDb.query(
            `INSERT INTO users (role, numeroControl, nombreCompleto, carrera, email, telefono, password, codigoAcceso, credencialFotos, isActive)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [role, numeroControl, nombreCompleto, carrera, email, telefono, hashedPassword, codigoAcceso, JSON.stringify(credencialFotos || []), isActive]
        );

        const token = jwt.sign({ userId: result.insertId, role }, process.env.JWT_SECRET, { expiresIn: '7d' });
        const [user] = await promiseDb.query('SELECT id, role, numeroControl, nombreCompleto, email, isActive FROM users WHERE id = ?', [result.insertId]);

        res.status(201).json({ token, user: user[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error en registro' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { numeroControl, password, codigoAcceso, role } = req.body;
    try {
        const [users] = await promiseDb.query('SELECT * FROM users WHERE numeroControl = ?', [numeroControl]);
        if (!users.length) return res.status(401).json({ message: 'Credenciales incorrectas' });

        const user = users[0];
        if (!user.isActive) return res.status(401).json({ message: 'Cuenta inactiva' });
        if (user.role !== role) return res.status(401).json({ message: `No eres ${role}` });

        let valid = false;
        if (role === 'Administrador') valid = user.codigoAcceso === codigoAcceso;
        else valid = await bcrypt.compare(password, user.password);

        if (!valid) return res.status(401).json({ message: 'Credenciales incorrectas' });

        const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
        delete user.password;
        delete user.codigoAcceso;

        res.json({ token, user });
    } catch (err) {
        res.status(500).json({ message: 'Error en login' });
    }
});

// ============ PRODUCTOS ============
app.get('/api/products', async (req, res) => {
    const { category, search } = req.query;
    let sql = `SELECT p.*, u.nombreCompleto as sellerName FROM products p JOIN users u ON p.sellerId = u.id WHERE p.status = 'approved' AND p.isAvailable = 1`;
    const params = [];
    if (category && category !== 'Todos') { sql += ' AND p.category = ?'; params.push(category); }
    if (search) { sql += ' AND (p.name LIKE ? OR p.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY p.createdAt DESC';

    db.query(sql, params, (err, rows) => {
        if (err) return res.status(500).json([]);
        const products = rows.map(p => ({ ...p, images: JSON.parse(p.images || '[]') }));
        res.json(products);
    });
});

app.get('/api/admin/pending-products', auth, isAdmin, (req, res) => {
    db.query(`SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail FROM products p JOIN users u ON p.sellerId = u.id WHERE p.status = 'pending' ORDER BY p.createdAt ASC`, (err, rows) => {
        if (err) return res.status(500).json({ products: [] });
        const products = rows.map(p => ({ ...p, images: JSON.parse(p.images || '[]') }));
        res.json({ products });
    });
});

app.post('/api/products', auth, (req, res) => {
    const { name, price, description, sellerId, sellerName, images, stock, location, category } = req.body;
    db.query(`INSERT INTO products (name, price, description, sellerId, sellerName, images, stock, location, category, status, isAvailable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
        [name, price, description, sellerId, sellerName, JSON.stringify(images), stock, location, category],
        (err, result) => {
            if (err) return res.status(500).json({ message: 'Error' });
            res.status(201).json({ id: result.insertId, message: 'Producto pendiente de aprobación' });
        });
});

app.put('/api/admin/approve-product/:id', auth, isAdmin, (req, res) => {
    const { approved } = req.body;
    db.query(`UPDATE products SET status = ?, isAvailable = ? WHERE id = ?`, [approved ? 'approved' : 'rejected', approved ? 1 : 0, req.params.id], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: approved ? 'Producto aprobado' : 'Producto rechazado' });
    });
});

// ============ USUARIOS ============
app.get('/api/users', auth, isAdmin, (req, res) => {
    db.query(`SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, isActive, createdAt FROM users ORDER BY createdAt DESC`, (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

app.patch('/api/users/:userId/status', auth, isAdmin, (req, res) => {
    const { isActive } = req.body;
    db.query(`UPDATE users SET isActive = ? WHERE id = ?`, [isActive, req.params.userId], (err) => {
        if (err) return res.status(500).json({ message: 'Error' });
        res.json({ message: 'Estado actualizado' });
    });
});

// ============ CARRITO ============
app.get('/api/cart', auth, (req, res) => {
    db.query(`SELECT ci.*, p.name, p.price, p.images FROM cart_items ci JOIN products p ON ci.productId = p.id WHERE ci.userId = ?`, [req.userId], (err, rows) => {
        if (err) return res.status(500).json({ items: [] });
        const items = rows.map(i => ({ ...i, imageUrl: JSON.parse(i.images || '[]')[0] }));
        res.json({ items });
    });
});

app.put('/api/cart/:productId', auth, (req, res) => {
    const { quantity } = req.body;
    if (quantity === 0) {
        db.query(`DELETE FROM cart_items WHERE userId = ? AND productId = ?`, [req.userId, req.params.productId], () => res.json({ message: 'Eliminado' }));
    } else {
        db.query(`INSERT INTO cart_items (userId, productId, quantity) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE quantity = ?`, [req.userId, req.params.productId, quantity, quantity], () => res.json({ message: 'Actualizado' }));
    }
});

// ============ PEDIDOS ============
app.post('/api/orders', auth, async (req, res) => {
    const { items, total, paymentMethod, shippingAddress } = req.body;
    try {
        const [orderRes] = await promiseDb.query(`INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status) VALUES (?, ?, ?, ?, 'pending')`, [req.userId, total, paymentMethod, shippingAddress]);
        const orderId = orderRes.insertId;
        const orderItems = items.map(i => [orderId, i.productId, i.name, i.quantity, i.price, i.imageUrl]);
        await promiseDb.query(`INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?`, [orderItems]);
        for (const item of items) {
            await promiseDb.query(`UPDATE products SET stock = stock - ? WHERE id = ?`, [item.quantity, item.productId]);
        }
        await promiseDb.query(`DELETE FROM cart_items WHERE userId = ?`, [req.userId]);
        res.status(201).json({ id: orderId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error' });
    }
});

app.get('/api/orders', auth, (req, res) => {
    db.query(`SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC`, [req.userId], async (err, orders) => {
        if (err) return res.status(500).json([]);
        for (const order of orders) {
            const [items] = await promiseDb.query(`SELECT * FROM order_items WHERE orderId = ?`, [order.id]);
            order.items = items;
        }
        res.json(orders);
    });
});

// ============ ESTADÍSTICAS ============
app.get('/api/admin/stats', auth, isAdmin, (req, res) => {
    Promise.all([
        promiseDb.query('SELECT COUNT(*) as count FROM users'),
        promiseDb.query('SELECT COUNT(*) as count FROM products WHERE status = "approved"'),
        promiseDb.query('SELECT COUNT(*) as count FROM products WHERE status = "pending"'),
        promiseDb.query('SELECT COUNT(*) as count FROM orders'),
        promiseDb.query('SELECT SUM(total) as total FROM orders WHERE status = "delivered"')
    ]).then(([[u], [p], [pp], [o], [s]]) => {
        res.json({
            totalUsers: u[0].count,
            totalProducts: p[0].count,
            pendingProducts: pp[0].count,
            totalOrders: o[0].count,
            totalSales: s[0].total || 0
        });
    }).catch(() => res.status(500).json({}));
});

app.get('/api/admin/user-stats', auth, isAdmin, (req, res) => {
    Promise.all([
        promiseDb.query('SELECT COUNT(*) as count FROM users WHERE role = "Vendedor" AND isActive = 1'),
        promiseDb.query('SELECT COUNT(*) as count FROM users WHERE role = "Comprador" AND isActive = 1'),
        promiseDb.query('SELECT COUNT(*) as count FROM users WHERE role = "Vendedor" AND isActive = 0'),
        promiseDb.query('SELECT COUNT(*) as count FROM users WHERE role = "Administrador"'),
        promiseDb.query('SELECT COUNT(*) as count FROM products WHERE status = "pending"')
    ]).then(([[v], [c], [p], [a], [pp]]) => {
        res.json({
            totalVendedores: v[0].count,
            totalCompradores: c[0].count,
            totalPendientes: p[0].count,
            totalAdministradores: a[0].count,
            pendientesProductos: pp[0].count
        });
    }).catch(() => res.status(500).json({}));
});

// ============ NOTIFICACIONES ============
app.get('/api/notifications', auth, (req, res) => {
    db.query(`SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC`, [req.userId], (err, rows) => {
        res.json({ notifications: rows || [] });
    });
});

app.patch('/api/notifications/read-all', auth, (req, res) => {
    db.query(`UPDATE notifications SET isRead = 1 WHERE userId = ?`, [req.userId], () => res.json({ message: 'ok' }));
});

// ============ ADMIN - VENDEDORES PENDIENTES ============
app.get('/api/admin/pending-vendors', auth, isAdmin, (req, res) => {
    db.query(`SELECT id, nombreCompleto, numeroControl, carrera, email, credencialFotos, createdAt FROM users WHERE role = 'Vendedor' AND isActive = 0 ORDER BY createdAt ASC`, (err, rows) => {
        if (err) return res.status(500).json({ vendors: [] });
        const vendors = rows.map(v => ({ ...v, credencialFotos: JSON.parse(v.credencialFotos || '[]') }));
        res.json({ vendors });
    });
});

app.post('/api/admin/approve-vendor', auth, isAdmin, async (req, res) => {
    const { userId, approved, rejectionReason } = req.body;
    try {
        await promiseDb.query(`UPDATE users SET isActive = ? WHERE id = ?`, [approved, userId]);
        if (approved && transporter) {
            const [users] = await promiseDb.query(`SELECT email, nombreCompleto, numeroControl FROM users WHERE id = ?`, [userId]);
            if (users[0]?.email) {
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: users[0].email,
                    subject: '✅ Cuenta aprobada - ByteSnack',
                    html: `<h1>Hola ${users[0].nombreCompleto}</h1><p>Tu cuenta de vendedor ha sido aprobada. Ya puedes iniciar sesión con tu número de control: <strong>${users[0].numeroControl}</strong></p>`
                });
            }
        }
        res.json({ message: approved ? 'Aprobado' : 'Rechazado' });
    } catch (err) {
        res.status(500).json({ message: 'Error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));