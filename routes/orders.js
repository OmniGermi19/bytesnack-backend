const jwt = require('jsonwebtoken');

module.exports = (db) => {
    const router = require('express').Router();

    const verifyToken = (req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ message: 'No token provided' });
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.userId = decoded.userId;
            req.userRole = decoded.role;
            next();
        } catch (e) {
            return res.status(401).json({ message: 'Invalid token' });
        }
    };

    // POST /api/orders - Crear pedido
    router.post('/', verifyToken, (req, res) => {
        const { items, total, paymentMethod, shippingAddress } = req.body;
        
        db.query(
            'INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt) VALUES (?, ?, ?, ?, ?, NOW())',
            [req.userId, total, paymentMethod, shippingAddress, 'pending'],
            (err, result) => {
                if (err) {
                    console.error('Error creando pedido:', err);
                    return res.status(500).json({ message: 'Error al crear pedido' });
                }
                
                const orderId = result.insertId;
                const orderItems = items.map(item => [
                    orderId, item.productId, item.name, item.quantity, item.price, item.imageUrl
                ]);
                
                db.query(
                    'INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?',
                    [orderItems],
                    (err) => {
                        if (err) {
                            console.error('Error creando items del pedido:', err);
                            return res.status(500).json({ message: 'Error al crear items' });
                        }
                        
                        db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
                        res.status(201).json({ id: orderId, message: 'Pedido creado' });
                    }
                );
            }
        );
    });

    // GET /api/orders - Obtener pedidos del usuario
    router.get('/', verifyToken, (req, res) => {
        const { status } = req.query;
        let query = 'SELECT * FROM orders WHERE userId = ?';
        const params = [req.userId];
        
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        
        query += ' ORDER BY createdAt DESC';
        
        db.query(query, params, (err, orders) => {
            if (err) {
                console.error('Error obteniendo pedidos:', err);
                return res.status(500).json({ message: 'Error' });
            }
            
            // Obtener items para cada pedido
            const promises = orders.map(order => {
                return new Promise((resolve) => {
                    db.query('SELECT * FROM order_items WHERE orderId = ?', [order.id], (err, items) => {
                        order.items = items || [];
                        resolve(order);
                    });
                });
            });
            
            Promise.all(promises).then(ordersWithItems => {
                res.json(ordersWithItems);
            });
        });
    });

    // PATCH /api/orders/:orderId/status - Actualizar estado
    router.patch('/:orderId/status', verifyToken, (req, res) => {
        const { status } = req.body;
        
        db.query(
            'UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?',
            [status, req.params.orderId],
            (err) => {
                if (err) {
                    console.error('Error actualizando estado:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ message: 'Estado actualizado' });
            }
        );
    });

    // GET /api/sales - Ventas del vendedor
    router.get('/sales', verifyToken, (req, res) => {
        db.query(
            `SELECT o.*, oi.productName, oi.quantity, oi.price
             FROM orders o
             JOIN order_items oi ON o.id = oi.orderId
             JOIN products p ON oi.productId = p.id
             WHERE p.sellerId = ?
             ORDER BY o.createdAt DESC`,
            [req.userId],
            (err, sales) => {
                if (err) {
                    console.error('Error obteniendo ventas:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ sales });
            }
        );
    });

    return router;
};