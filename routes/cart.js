const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/orders - Crear pedido
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        const { items, total, paymentMethod, shippingAddress } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'El carrito está vacío' });
        }

        try {
            // Verificar stock antes de crear pedido
            for (const item of items) {
                const [products] = await db.promise().query(
                    'SELECT stock FROM products WHERE id = ? AND status = "approved" AND isAvailable = TRUE',
                    [item.productId]
                );
                
                if (products.length === 0 || products[0].stock < item.quantity) {
                    return res.status(400).json({ 
                        message: `Stock insuficiente para ${item.name}. Disponible: ${products[0]?.stock || 0}` 
                    });
                }
            }

            // Crear pedido
            const [orderResult] = await db.promise().query(
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
                [req.userId, total, paymentMethod, shippingAddress]
            );

            const orderId = orderResult.insertId;
            const orderItems = items.map(item => [
                orderId, item.productId, item.name, item.quantity, item.price, item.imageUrl
            ]);

            await db.promise().query(
                'INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?',
                [orderItems]
            );

            // Actualizar stock de productos
            for (const item of items) {
                await db.promise().query(
                    'UPDATE products SET stock = stock - ? WHERE id = ?',
                    [item.quantity, item.productId]
                );
            }

            // Vaciar carrito
            await db.promise().query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);

            res.status(201).json({ id: orderId, message: 'Pedido creado exitosamente' });

        } catch (error) {
            console.error('Error creando pedido:', error);
            res.status(500).json({ message: 'Error al crear pedido' });
        }
    });

    // GET /api/orders - Obtener pedidos del usuario
    router.get('/', authenticateToken, (req, res) => {
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
                const [items] = await db.promise().query(
                    'SELECT * FROM order_items WHERE orderId = ?',
                    [order.id]
                );
                order.items = items;
            }
            
            res.json(orders);
        });
    });

    // GET /api/orders/:orderId - Obtener detalle de pedido
    router.get('/:orderId', authenticateToken, (req, res) => {
        db.query('SELECT * FROM orders WHERE id = ? AND userId = ?', [req.params.orderId, req.userId], (err, orders) => {
            if (err || orders.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            db.query('SELECT * FROM order_items WHERE orderId = ?', [req.params.orderId], (err, items) => {
                if (err) return res.status(500).json({ message: 'Error' });
                
                orders[0].items = items;
                res.json(orders[0]);
            });
        });
    });

    // PATCH /api/orders/:orderId/status - Actualizar estado (solo vendedor o admin)
    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado inválido' });
        }

        try {
            // Verificar permisos (vendedor del producto o admin)
            const [orderCheck] = await db.promise().query(
                `SELECT o.userId, oi.productId
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 WHERE o.id = ?`,
                [req.params.orderId]
            );

            if (orderCheck.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }

            const [products] = await db.promise().query(
                'SELECT sellerId FROM products WHERE id = ?',
                [orderCheck[0].productId]
            );

            const isAuthorized = req.userRole === 'Administrador' || 
                                 (req.userRole === 'Vendedor' && products[0]?.sellerId === req.userId);

            if (!isAuthorized) {
                return res.status(403).json({ message: 'No tienes permiso para actualizar este pedido' });
            }

            await db.promise().query(
                'UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?',
                [status, req.params.orderId]
            );

            res.json({ message: 'Estado actualizado correctamente' });

        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    // GET /api/orders/seller/sales - Ventas del vendedor
    router.get('/seller/sales', authenticateToken, isSeller, (req, res) => {
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

    return router;
};