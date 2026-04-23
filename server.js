const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
        const [existing] = await promiseDb.query(
            'SELECT id FROM users WHERE numeroControl = ?',
            [numeroControl]
        );

        if (existing.length > 0) {
            return res.status(400).json({ message: 'El número de control ya está registrado' });
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

        const [result] = await promiseDb.query(
            `INSERT INTO users 
            (role, numeroControl, nombreCompleto, carrera, email, telefono, password, 
             codigoAcceso, credencialFotos, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0, 0, 0)`,
            [
                role, numeroControl, nombreCompleto, carrera || null, email || null, 
                telefono || null, hashedPassword, codigoAcceso || null,
                credencialFotos ? JSON.stringify(credencialFotos) : null,
                isVendedorTambien || false, true
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
            return res.status(401).json({ message: 'Cuenta desactivada. Contacta al administrador.' });
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

app.get('/api/products/pending', authenticateToken, isAdmin, (req, res) => {
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

// ==================== RUTAS DE ADMINISTRACIÓN ====================
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
        await promiseDb.query('UPDATE users SET isActive = ? WHERE id = ?', [approved, userId]);
        
        if (!approved && rejectionReason) {
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '❌ Cuenta rechazada', `Tu cuenta de vendedor ha sido rechazada. Motivo: ${rejectionReason}`, 'user_approval']
            );
        } else if (approved) {
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '✅ Cuenta aprobada', 'Tu cuenta de vendedor ha sido aprobada. ¡Ya puedes publicar productos!', 'user_approval']
            );
        }
        
        res.json({ message: approved ? 'Vendedor aprobado' : 'Vendedor rechazado' });
    } catch (error) {
        console.error('Error aprobando vendedor:', error);
        res.status(500).json({ message: 'Error' });
    }
});

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

// ==================== RUTAS DE ESTADÍSTICAS ====================
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
});