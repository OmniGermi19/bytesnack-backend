const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();

// Middlewares
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configuración de email
let emailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    emailTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
    console.log('✅ Email configurado correctamente');
} else {
    console.log('⚠️ Email no configurado. Las notificaciones por correo no estarán disponibles');
}

// Función para enviar correo
const sendEmail = async (to, subject, html) => {
    if (!emailTransporter) {
        console.log('⚠️ Email no configurado. Omitiendo envío de correo a:', to);
        return false;
    }
    
    try {
        await emailTransporter.sendMail({
            from: `"ByteSnack ITESCO" <${process.env.EMAIL_USER}>`,
            to: to,
            subject: subject,
            html: html
        });
        console.log(`✅ Correo enviado a ${to}`);
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

// Verificar conexión
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

    if (!token) {
        return res.status(401).json({ message: 'No se proporcionó token de autenticación' });
    }

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
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de administrador.' });
    }
    next();
};

const isSeller = (req, res, next) => {
    if (req.userRole !== 'Vendedor' && req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de vendedor.' });
    }
    next();
};

// ==================== RUTAS DE AUTENTICACIÓN ====================
app.post('/api/auth/register', async (req, res) => {
    const {
        role,
        numeroControl,
        nombreCompleto,
        carrera,
        email,
        telefono,
        password,
        codigoAcceso,
        credencialFotos,
        isVendedorTambien
    } = req.body;

    if (!numeroControl || !nombreCompleto || !role) {
        return res.status(400).json({ message: 'Faltan campos requeridos' });
    }

    try {
        // Validar formato del número de control según el rol
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

        // Verificar si ya existe un usuario con el mismo número de control
        const [existing] = await promiseDb.query(
            'SELECT id FROM users WHERE numeroControl = ?',
            [numeroControl]
        );

        if (existing.length > 0) {
            return res.status(400).json({ message: 'Este número de control ya está registrado' });
        }

        let hashedPassword = null;
        if (password) {
            hashedPassword = await bcrypt.hash(password, 10);
        }

        if (role === 'Administrador') {
            if (codigoAcceso !== process.env.ADMIN_SECRET_CODE) {
                return res.status(403).json({ message: 'Código de acceso inválido' });
            }
        }

        // Compradores: isActive = true, Vendedores: isActive = false (pendiente aprobación)
        const isActive = role === 'Comprador';

        const [result] = await promiseDb.query(
            `INSERT INTO users 
            (role, numeroControl, nombreCompleto, carrera, email, telefono, password, 
             codigoAcceso, credencialFotos, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0, 0, 0)`,
            [
                role, numeroControl, nombreCompleto, carrera || null, email || null, 
                telefono || null, hashedPassword, codigoAcceso || null,
                credencialFotos ? JSON.stringify(credencialFotos) : null,
                isVendedorTambien || false, isActive
            ]
        );

        const token = jwt.sign(
            { userId: result.insertId, role: role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        const [users] = await promiseDb.query(
            `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                    isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras
             FROM users WHERE id = ?`,
            [result.insertId]
        );

        res.status(201).json({ token, user: users[0], message: 'Usuario registrado exitosamente' });

    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ message: 'Error al registrar usuario' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { numeroControl, password, codigoAcceso, role } = req.body;

    if (!numeroControl) {
        return res.status(400).json({ message: 'Número de control requerido' });
    }

    try {
        const [users] = await promiseDb.query(
            `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono,
                    password, codigoAcceso, isVendedorTambien, createdAt, isActive, 
                    calificacion, totalVentas, totalCompras
             FROM users WHERE numeroControl = ?`,
            [numeroControl]
        );

        if (users.length === 0) {
            return res.status(401).json({ message: 'Credenciales incorrectas' });
        }

        const user = users[0];

        if (!user.isActive) {
            return res.status(401).json({ message: 'Cuenta desactivada o pendiente de aprobación. Contacta al administrador.' });
        }

        if (user.role !== role) {
            return res.status(401).json({ message: `No tienes una cuenta de ${role}` });
        }

        let isValid = false;

        if (role === 'Administrador') {
            isValid = user.codigoAcceso === codigoAcceso;
        } else {
            if (!password || !user.password) {
                isValid = false;
            } else {
                isValid = await bcrypt.compare(password, user.password);
            }
        }

        if (!isValid) {
            return res.status(401).json({ message: 'Credenciales incorrectas' });
        }

        const token = jwt.sign(
            { userId: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        const refreshToken = jwt.sign(
            { userId: user.id },
            process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        delete user.password;
        delete user.codigoAcceso;

        res.json({ token, refreshToken, user, message: 'Inicio de sesión exitoso' });

    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ message: 'Error al iniciar sesión' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ message: 'Sesión cerrada exitosamente' });
});

app.post('/api/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        return res.status(401).json({ message: 'Refresh token requerido' });
    }

    try {
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
        
        const [users] = await promiseDb.query(
            'SELECT id, role FROM users WHERE id = ? AND isActive = TRUE',
            [decoded.userId]
        );

        if (users.length === 0) {
            return res.status(401).json({ message: 'Usuario no encontrado o inactivo' });
        }

        const newToken = jwt.sign(
            { userId: users[0].id, role: users[0].role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ token: newToken });
    } catch (error) {
        console.error('Error refrescando token:', error);
        res.status(401).json({ message: 'Refresh token inválido' });
    }
});

// ==================== RUTAS DE PRODUCTOS ====================
app.get('/api/products', async (req, res) => {
    const { category, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let query = `
        SELECT p.*, u.nombreCompleto as sellerName
        FROM products p
        JOIN users u ON p.sellerId = u.id
        WHERE p.status = 'approved' AND p.isAvailable = TRUE AND u.isActive = TRUE
    `;
    const params = [];
    
    if (category && category !== 'Todos') {
        query += ' AND p.category = ?';
        params.push(category);
    }
    
    if (search && search.trim()) {
        query += ' AND (p.name LIKE ? OR p.description LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY p.createdAt DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    
    db.query(query, params, (err, products) => {
        if (err) {
            console.error('Error obteniendo productos:', err);
            return res.status(500).json({ message: 'Error al cargar productos' });
        }
        const parsedProducts = products.map(p => ({
            ...p,
            images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || [])
        }));
        res.json(parsedProducts);
    });
});

app.get('/api/admin/pending-products', authenticateToken, isAdmin, (req, res) => {
    db.query(
        `SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail, u.numeroControl as sellerControl
         FROM products p
         JOIN users u ON p.sellerId = u.id
         WHERE p.status = 'pending'
         ORDER BY p.createdAt ASC`,
        (err, products) => {
            if (err) {
                console.error('Error obteniendo productos pendientes:', err);
                return res.status(500).json({ message: 'Error' });
            }
            const parsedProducts = products.map(p => ({
                ...p,
                images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || [])
            }));
            res.json({ products: parsedProducts });
        }
    );
});

app.post('/api/products', authenticateToken, (req, res) => {
    const { name, price, description, sellerId, sellerName, images, stock, location, category } = req.body;
    
    if (sellerId !== req.userId && req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'No puedes crear productos para otro usuario' });
    }
    
    db.query('SELECT id FROM users WHERE id = ? AND isActive = TRUE', [sellerId], (err, userRows) => {
        if (err) {
            console.error('Error verificando vendedor:', err);
            return res.status(500).json({ message: 'Error al validar vendedor' });
        }
        if (userRows.length === 0) {
            return res.status(400).json({ message: 'El vendedor especificado no existe o está inactivo.' });
        }
        
        db.query(
            `INSERT INTO products (name, price, description, sellerId, sellerName, images, stock, location, category, status, isAvailable, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', FALSE, NOW())`,
            [name, price, description, sellerId, sellerName, JSON.stringify(images || []), stock, location, category],
            (err, result) => {
                if (err) {
                    console.error('Error creando producto:', err);
                    return res.status(500).json({ message: 'Error al crear producto' });
                }
                res.status(201).json({ 
                    id: result.insertId, 
                    message: 'Producto creado. Pendiente de aprobación por el administrador.' 
                });
            }
        );
    });
});

app.put('/api/admin/approve-product/:id', authenticateToken, isAdmin, (req, res) => {
    const { approved } = req.body;
    const status = approved ? 'approved' : 'rejected';
    
    db.query(
        'UPDATE products SET status = ?, isAvailable = ? WHERE id = ?',
        [status, approved, req.params.id],
        (err) => {
            if (err) {
                console.error('Error procesando producto:', err);
                return res.status(500).json({ message: 'Error' });
            }
            res.json({ message: `Producto ${approved ? 'aprobado' : 'rechazado'}` });
        }
    );
});

app.put('/api/products/:id', authenticateToken, (req, res) => {
    const { name, price, description, images, stock, location, category, isAvailable } = req.body;
    
    db.query('SELECT sellerId FROM products WHERE id = ?', [req.params.id], (err, products) => {
        if (err || products.length === 0) {
            return res.status(404).json({ message: 'Producto no encontrado' });
        }
        
        if (products[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
            return res.status(403).json({ message: 'No tienes permiso para editar este producto' });
        }
        
        db.query(
            `UPDATE products SET name = ?, price = ?, description = ?, images = ?, stock = ?, 
                 location = ?, category = ?, isAvailable = ?, updatedAt = NOW() WHERE id = ?`,
            [name, price, description, JSON.stringify(images || []), stock, location, category, isAvailable, req.params.id],
            (err) => {
                if (err) {
                    console.error('Error actualizando producto:', err);
                    return res.status(500).json({ message: 'Error al actualizar' });
                }
                res.json({ message: 'Producto actualizado' });
            }
        );
    });
});

app.delete('/api/products/:id', authenticateToken, (req, res) => {
    db.query('SELECT sellerId FROM products WHERE id = ?', [req.params.id], (err, products) => {
        if (err || products.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
        
        if (products[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
            return res.status(403).json({ message: 'No tienes permiso para eliminar este producto' });
        }
        
        db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ message: 'Error al eliminar' });
            res.json({ message: 'Producto eliminado' });
        });
    });
});

// ==================== RUTAS DE CARRITO ====================
app.get('/api/cart', authenticateToken, (req, res) => {
    db.query(
        `SELECT ci.*, p.name, p.price, p.images, p.sellerId, u.nombreCompleto as sellerName,
                p.stock as availableStock
         FROM cart_items ci
         JOIN products p ON ci.productId = p.id
         JOIN users u ON p.sellerId = u.id
         WHERE ci.userId = ?`,
        [req.userId],
        (err, items) => {
            if (err) {
                console.error('Error obteniendo carrito:', err);
                return res.status(500).json({ message: 'Error al obtener carrito' });
            }

            const formattedItems = items.map(item => ({
                productId: item.productId.toString(),
                name: item.name,
                price: parseFloat(item.price),
                quantity: item.quantity,
                imageUrl: item.images ? (JSON.parse(item.images)[0] || null) : null,
                sellerId: item.sellerId.toString(),
                sellerName: item.sellerName,
                addedAt: item.addedAt
            }));

            res.json({ items: formattedItems });
        }
    );
});

app.post('/api/cart/add', authenticateToken, (req, res) => {
    const { productId, quantity } = req.body;

    if (!productId || !quantity || quantity < 1) {
        return res.status(400).json({ message: 'Datos inválidos' });
    }

    db.query('SELECT stock, status, isAvailable FROM products WHERE id = ?', [productId], (err, products) => {
        if (err || products.length === 0) {
            return res.status(404).json({ message: 'Producto no encontrado' });
        }

        const product = products[0];

        if (product.status !== 'approved' || !product.isAvailable) {
            return res.status(400).json({ message: 'Producto no disponible' });
        }

        if (product.stock < quantity) {
            return res.status(400).json({ message: 'Stock insuficiente' });
        }

        db.query(
            `INSERT INTO cart_items (userId, productId, quantity, addedAt)
             VALUES (?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
            [req.userId, productId, quantity, quantity],
            (err) => {
                if (err) {
                    console.error('Error agregando al carrito:', err);
                    return res.status(500).json({ message: 'Error al agregar al carrito' });
                }
                res.json({ message: 'Producto agregado al carrito' });
            }
        );
    });
});

app.put('/api/cart/:productId', authenticateToken, (req, res) => {
    const { quantity } = req.body;
    const productId = req.params.productId;

    if (quantity === undefined || quantity < 0) {
        return res.status(400).json({ message: 'Cantidad inválida' });
    }

    if (quantity === 0) {
        db.query('DELETE FROM cart_items WHERE userId = ? AND productId = ?', [req.userId, productId], (err) => {
            if (err) return res.status(500).json({ message: 'Error al actualizar' });
            res.json({ message: 'Producto eliminado del carrito' });
        });
    } else {
        db.query('SELECT stock FROM products WHERE id = ?', [productId], (err, products) => {
            if (err || products.length === 0) {
                return res.status(404).json({ message: 'Producto no encontrado' });
            }

            if (products[0].stock < quantity) {
                return res.status(400).json({ message: 'Stock insuficiente' });
            }

            db.query('UPDATE cart_items SET quantity = ? WHERE userId = ? AND productId = ?', [quantity, req.userId, productId], (err) => {
                if (err) return res.status(500).json({ message: 'Error al actualizar' });
                res.json({ message: 'Cantidad actualizada' });
            });
        });
    }
});

app.delete('/api/cart/:productId', authenticateToken, (req, res) => {
    db.query('DELETE FROM cart_items WHERE userId = ? AND productId = ?', [req.userId, req.params.productId], (err) => {
        if (err) return res.status(500).json({ message: 'Error al eliminar' });
        res.json({ message: 'Producto eliminado del carrito' });
    });
});

app.delete('/api/cart/clear', authenticateToken, (req, res) => {
    db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId], (err) => {
        if (err) return res.status(500).json({ message: 'Error al vaciar carrito' });
        res.json({ message: 'Carrito vaciado' });
    });
});

// ==================== RUTAS DE PEDIDOS ====================
app.post('/api/orders', authenticateToken, async (req, res) => {
    const { items, total, paymentMethod, shippingAddress } = req.body;

    if (!items || items.length === 0) {
        return res.status(400).json({ message: 'El carrito está vacío' });
    }

    try {
        for (const item of items) {
            const [products] = await promiseDb.query(
                'SELECT stock FROM products WHERE id = ? AND status = "approved" AND isAvailable = TRUE',
                [item.productId]
            );
            
            if (products.length === 0 || products[0].stock < item.quantity) {
                return res.status(400).json({ 
                    message: `Stock insuficiente para ${item.name}` 
                });
            }
        }

        const [orderResult] = await promiseDb.query(
            `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
            [req.userId, total, paymentMethod, shippingAddress]
        );

        const orderId = orderResult.insertId;
        const orderItems = items.map(item => [
            orderId, item.productId, item.name, item.quantity, item.price, item.imageUrl
        ]);

        await promiseDb.query(
            'INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?',
            [orderItems]
        );

        for (const item of items) {
            await promiseDb.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.productId]);
        }

        await promiseDb.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);

        res.status(201).json({ id: orderId, message: 'Pedido creado exitosamente' });

    } catch (error) {
        console.error('Error creando pedido:', error);
        res.status(500).json({ message: 'Error al crear pedido' });
    }
});

app.get('/api/orders', authenticateToken, (req, res) => {
    const { status } = req.query;
    let query = 'SELECT * FROM orders WHERE userId = ?';
    const params = [req.userId];
    
    if (status) {
        query += ' AND status = ?';
        params.push(status);
    }
    
    query += ' ORDER BY createdAt DESC';
    
    db.query(query, params, async (err, orders) => {
        if (err) {
            console.error('Error obteniendo pedidos:', err);
            return res.status(500).json({ message: 'Error al obtener pedidos' });
        }
        
        for (const order of orders) {
            const [items] = await promiseDb.query('SELECT * FROM order_items WHERE orderId = ?', [order.id]);
            order.items = items;
        }
        
        res.json(orders);
    });
});

app.patch('/api/orders/:orderId/status', authenticateToken, async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Estado inválido' });
    }

    try {
        await promiseDb.query('UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?', [status, req.params.orderId]);
        res.json({ message: 'Estado actualizado correctamente' });
    } catch (error) {
        console.error('Error actualizando estado:', error);
        res.status(500).json({ message: 'Error al actualizar estado' });
    }
});

// ==================== RUTAS DE VENTAS ====================
app.get('/api/sales', authenticateToken, isSeller, (req, res) => {
    db.query(
        `SELECT o.*, oi.productName, oi.quantity, oi.price, oi.imageUrl, u.nombreCompleto as buyerName
         FROM orders o
         JOIN order_items oi ON o.id = oi.orderId
         JOIN products p ON oi.productId = p.id
         JOIN users u ON o.userId = u.id
         WHERE p.sellerId = ?
         ORDER BY o.createdAt DESC`,
        [req.userId],
        (err, sales) => {
            if (err) {
                console.error('Error obteniendo ventas:', err);
                return res.status(500).json({ message: 'Error al obtener ventas' });
            }
            
            const totalSales = sales.reduce((sum, s) => sum + (parseFloat(s.price) * s.quantity), 0);
            const totalOrders = [...new Set(sales.map(s => s.id))].length;
            
            res.json({ sales, totalSales, totalOrders });
        }
    );
});

// ==================== RUTAS DE ADMINISTRACIÓN - VENDEDORES ====================
app.get('/api/admin/pending-vendors', authenticateToken, isAdmin, (req, res) => {
    db.query(
        `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                credencialFotos, createdAt, isActive
         FROM users 
         WHERE role = 'Vendedor' AND isActive = FALSE
         ORDER BY createdAt ASC`,
        (err, vendors) => {
            if (err) {
                console.error('Error obteniendo vendedores pendientes:', err);
                return res.status(500).json({ message: 'Error' });
            }
            
            const parsedVendors = vendors.map(v => ({
                ...v,
                credencialFotos: typeof v.credencialFotos === 'string' ? JSON.parse(v.credencialFotos || '[]') : (v.credencialFotos || [])
            }));
            
            res.json({ vendors: parsedVendors });
        }
    );
});

app.post('/api/admin/approve-vendor', authenticateToken, isAdmin, async (req, res) => {
    const { userId, approved, rejectionReason } = req.body;

    try {
        // Actualizar estado del usuario
        await promiseDb.query('UPDATE users SET isActive = ? WHERE id = ?', [approved, userId]);
        
        // Obtener información del vendedor para el correo
        const [vendors] = await promiseDb.query(
            'SELECT email, nombreCompleto, numeroControl FROM users WHERE id = ?',
            [userId]
        );
        
        const vendor = vendors[0];
        
        if (approved) {
            // Crear notificación en la app
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '✅ Cuenta aprobada', 'Tu cuenta de vendedor ha sido aprobada. ¡Ya puedes iniciar sesión y publicar productos!', 'user_approval']
            );
            
            // Enviar correo electrónico
            if (vendor && vendor.email) {
                const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                            .header { text-align: center; border-bottom: 2px solid #4CAF50; padding-bottom: 20px; margin-bottom: 20px; }
                            .logo { font-size: 28px; font-weight: bold; color: #4CAF50; }
                            .title { color: #333; font-size: 24px; margin-bottom: 10px; }
                            .content { color: #555; line-height: 1.6; margin-bottom: 30px; }
                            .button { background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; }
                            .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #888; font-size: 12px; }
                            .credentials { background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <div class="logo">🍔 ByteSnack ITESCO</div>
                                <h1 class="title">¡Bienvenido a ByteSnack! 🎉</h1>
                            </div>
                            <div class="content">
                                <p>Hola <strong>${vendor.nombreCompleto}</strong>,</p>
                                <p>¡Excelentes noticias! Tu cuenta de <strong>VENDEDOR</strong> ha sido <strong style="color: #4CAF50;">APROBADA</strong>.</p>
                                <div class="credentials">
                                    <p><strong>📋 Tus credenciales:</strong></p>
                                    <p>🔑 Número de control: <strong>${vendor.numeroControl}</strong></p>
                                    <p>🔒 Contraseña: <strong>La que configuraste al registrarte</strong></p>
                                </div>
                                <p>Ya puedes iniciar sesión y comenzar a publicar tus productos.</p>
                                <p style="text-align: center;">
                                    <a href="${process.env.APP_URL || 'https://bytesnack.itesco.edu.mx'}" class="button">Ir a ByteSnack</a>
                                </p>
                            </div>
                            <div class="footer">
                                <p>ByteSnack ITESCO</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `;
                
                await sendEmail(vendor.email, '✅ ¡Tu cuenta de Vendedor ha sido aprobada!', emailHtml);
            }
            
            res.json({ message: 'Vendedor aprobado exitosamente', emailSent: !!vendor?.email });
        } else {
            // Rechazar vendedor
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '❌ Cuenta rechazada', `Tu cuenta ha sido rechazada. Motivo: ${rejectionReason || 'No especificado'}`, 'user_approval']
            );
            
            if (vendor && vendor.email) {
                const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                            .header { text-align: center; border-bottom: 2px solid #f44336; padding-bottom: 20px; margin-bottom: 20px; }
                            .logo { font-size: 28px; font-weight: bold; color: #f44336; }
                            .title { color: #333; font-size: 24px; margin-bottom: 10px; }
                            .content { color: #555; line-height: 1.6; margin-bottom: 30px; }
                            .reason { background-color: #fff3f3; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f44336; }
                            .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #888; font-size: 12px; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <div class="logo">🍔 ByteSnack ITESCO</div>
                                <h1 class="title">Estado de tu solicitud</h1>
                            </div>
                            <div class="content">
                                <p>Hola <strong>${vendor.nombreCompleto}</strong>,</p>
                                <p>Hemos revisado tu solicitud.</p>
                                <div class="reason">
                                    <p><strong>📝 Motivo del rechazo:</strong></p>
                                    <p>${rejectionReason || 'No se especificó un motivo'}</p>
                                </div>
                                <p>Puedes volver a intentar el registro corrigiendo la información.</p>
                            </div>
                            <div class="footer">
                                <p>ByteSnack ITESCO</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `;
                
                await sendEmail(vendor.email, '❌ Actualización sobre tu solicitud', emailHtml);
            }
            
            res.json({ message: 'Vendedor rechazado', emailSent: !!vendor?.email });
        }
    } catch (error) {
        console.error('Error aprobando vendedor:', error);
        res.status(500).json({ message: 'Error al procesar la solicitud' });
    }
});

// ==================== RUTAS DE USUARIOS ====================
app.get('/api/users', authenticateToken, isAdmin, (req, res) => {
    db.query(
        `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras
         FROM users ORDER BY createdAt DESC`,
        (err, users) => {
            if (err) {
                console.error('Error obteniendo usuarios:', err);
                return res.status(500).json({ message: 'Error al obtener usuarios' });
            }
            res.json(users);
        }
    );
});

app.patch('/api/users/:userId/status', authenticateToken, isAdmin, (req, res) => {
    const { isActive } = req.body;
    const userId = req.params.userId;

    if (parseInt(userId) === req.userId) {
        return res.status(400).json({ message: 'No puedes desactivar tu propia cuenta' });
    }

    db.query('UPDATE users SET isActive = ? WHERE id = ?', [isActive, userId], (err) => {
        if (err) {
            console.error('Error actualizando estado:', err);
            return res.status(500).json({ message: 'Error al actualizar estado' });
        }
        res.json({ message: `Usuario ${isActive ? 'activado' : 'desactivado'} correctamente` });
    });
});

app.put('/api/users/:userId/role', authenticateToken, isAdmin, (req, res) => {
    const { role } = req.body;
    const validRoles = ['Comprador', 'Vendedor', 'Administrador'];
    
    if (!validRoles.includes(role)) {
        return res.status(400).json({ message: 'Rol inválido' });
    }

    db.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.userId], (err) => {
        if (err) {
            console.error('Error actualizando rol:', err);
            return res.status(500).json({ message: 'Error al actualizar rol' });
        }
        res.json({ message: 'Rol actualizado correctamente' });
    });
});

app.get('/api/users/profile', authenticateToken, (req, res) => {
    db.query(
        'SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras, direccion FROM users WHERE id = ?',
        [req.userId],
        (err, users) => {
            if (err) return res.status(500).json({ message: 'Error' });
            if (users.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
            res.json(users[0]);
        }
    );
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
    const { telefono, direccion, password, email, nombreCompleto } = req.body;
    const updates = [];
    const params = [];

    if (telefono !== undefined) {
        updates.push('telefono = ?');
        params.push(telefono);
    }
    
    if (direccion !== undefined) {
        updates.push('direccion = ?');
        params.push(direccion);
    }

    if (email !== undefined) {
        updates.push('email = ?');
        params.push(email);
    }

    if (nombreCompleto !== undefined && nombreCompleto.trim().length > 0) {
        updates.push('nombreCompleto = ?');
        params.push(nombreCompleto);
    }
    
    if (password !== undefined && password.trim().length > 0) {
        if (password.length < 6) {
            return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        updates.push('password = ?');
        params.push(hashedPassword);
    }
    
    if (updates.length === 0) {
        return res.status(400).json({ message: 'No hay campos para actualizar' });
    }
    
    updates.push('updatedAt = NOW()');
    params.push(req.userId);
    
    db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
        if (err) {
            console.error('Error actualizando perfil:', err);
            return res.status(500).json({ message: 'Error al actualizar perfil' });
        }
        res.json({ message: 'Perfil actualizado correctamente' });
    });
});

// ==================== RUTAS DE NOTIFICACIONES ====================
app.get('/api/notifications', authenticateToken, (req, res) => {
    db.query(
        'SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC',
        [req.userId],
        (err, notifications) => {
            if (err) {
                console.error('Error obteniendo notificaciones:', err);
                return res.status(500).json({ message: 'Error' });
            }
            res.json({ notifications });
        }
    );
});

app.post('/api/notifications/product-pending', authenticateToken, async (req, res) => {
    const { productId, productName, sellerName } = req.body;
    
    db.query('SELECT id FROM users WHERE role = "Administrador" AND isActive = 1', async (err, admins) => {
        if (err) return res.status(500).json({ message: 'Error' });
        
        for (const admin of admins) {
            db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt, data)
                 VALUES (?, ?, ?, ?, 0, NOW(), ?)`,
                [
                    admin.id,
                    '📦 Nuevo producto pendiente',
                    `El vendedor "${sellerName}" ha publicado: "${productName}"`,
                    'product_approval',
                    JSON.stringify({ productId, productName, sellerName })
                ]
            );
        }
        res.json({ message: 'Notificaciones enviadas' });
    });
});

app.patch('/api/notifications/:id/read', authenticateToken, (req, res) => {
    db.query(
        'UPDATE notifications SET isRead = 1 WHERE id = ? AND userId = ?',
        [req.params.id, req.userId],
        (err) => {
            if (err) return res.status(500).json({ message: 'Error' });
            res.json({ message: 'Notificación marcada como leída' });
        }
    );
});

app.patch('/api/notifications/read-all', authenticateToken, (req, res) => {
    db.query(
        'UPDATE notifications SET isRead = 1 WHERE userId = ?',
        [req.userId],
        (err) => {
            if (err) return res.status(500).json({ message: 'Error' });
            res.json({ message: 'Todas las notificaciones marcadas como leídas' });
        }
    );
});

app.delete('/api/notifications/:id', authenticateToken, (req, res) => {
    db.query(
        'DELETE FROM notifications WHERE id = ? AND userId = ?',
        [req.params.id, req.userId],
        (err) => {
            if (err) return res.status(500).json({ message: 'Error' });
            res.json({ message: 'Notificación eliminada' });
        }
    );
});

// ==================== RUTAS DE ADMIN - ESTADÍSTICAS ====================
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
    const totalQueries = Object.keys(queries).length;

    for (const [key, query] of Object.entries(queries)) {
        db.query(query, (err, rows) => {
            if (err) {
                console.error(`Error obteniendo ${key}:`, err);
                results[key] = 0;
            } else {
                results[key] = rows[0]?.count || rows[0]?.total || 0;
            }
            
            completed++;
            if (completed === totalQueries) {
                res.json(results);
            }
        });
    }
});

// ==================== RUTA DE SALUD ====================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== MANEJO DE ERRORES 404 ====================
app.use('*', (req, res) => {
    res.status(404).json({ message: `Ruta ${req.originalUrl} no encontrada` });
});

// ==================== INICIAR SERVIDOR ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📧 Email configurado: ${emailTransporter ? 'Sí' : 'No'}`);
});