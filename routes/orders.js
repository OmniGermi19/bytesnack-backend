const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        const { items, total, paymentMethod, shippingAddress } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'El carrito está vacío' });
        }

        try {
            for (const item of items) {
                const [products] = await db.query(
                    'SELECT stock, name FROM products WHERE id = ? AND status = "approved" AND isAvailable = TRUE',
                    [item.productId]
                );
                
                if (products.length === 0) {
                    return res.status(400).json({ 
                        message: `El producto "${item.name}" no está disponible` 
                    });
                }
                
                if (products[0].stock < item.quantity) {
                    return res.status(400).json({ 
                        message: `Stock insuficiente para "${products[0].name}". Disponible: ${products[0].stock}` 
                    });
                }
            }

            const [orderResult] = await db.query(
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
                [req.userId, total, paymentMethod, shippingAddress || 'Entrega en ITESCO']
            );

            const orderId = orderResult.insertId;
            
            await db.query(
                `INSERT INTO tracking_sessions (orderId, status, createdAt)
                 VALUES (?, 'pending', NOW())`,
                [orderId]
            );
            
            const orderItems = items.map(item => [
                orderId, item.productId, item.name, item.quantity, item.price, item.imageUrl || null
            ]);

            await db.query(
                'INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?',
                [orderItems]
            );

            for (const item of items) {
                await db.query(
                    'UPDATE products SET stock = stock - ? WHERE id = ?',
                    [item.quantity, item.productId]
                );
            }

            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);

            for (const item of items) {
                const [products] = await db.query('SELECT sellerId, sellerName FROM products WHERE id = ?', [item.productId]);
                if (products.length > 0) {
                    await db.query(
                        `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                         VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                        [products[0].sellerId, 
                         '📦 Nuevo pedido', 
                         `Has recibido un pedido de ${item.quantity}x ${item.name} por \$${(item.price * item.quantity).toFixed(2)}`]
                    );
                }
            }

            res.status(201).json({ id: orderId, message: 'Pedido creado exitosamente' });

        } catch (error) {
            console.error('Error creando pedido:', error);
            res.status(500).json({ message: 'Error al crear pedido' });
        }
    });

    router.get('/', authenticateToken, async (req, res) => {
        const { status } = req.query;
        let query = 'SELECT * FROM orders WHERE userId = ?';
        const params = [req.userId];
        
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        
        try {
            const [orders] = await db.query(query, params);
            
            for (const order of orders) {
                const [items] = await db.query(
                    'SELECT * FROM order_items WHERE orderId = ?',
                    [order.id]
                );
                order.items = items;
            }
            
            orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            
            res.json(orders);
        } catch (error) {
            console.error('Error obteniendo pedidos:', error);
            res.status(500).json({ message: 'Error al obtener pedidos' });
        }
    });

    router.get('/:orderId', authenticateToken, async (req, res) => {
        try {
            const [orders] = await db.query(
                'SELECT * FROM orders WHERE id = ? AND userId = ?',
                [req.params.orderId, req.userId]
            );
            
            if (orders.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            const [items] = await db.query(
                'SELECT * FROM order_items WHERE orderId = ?',
                [req.params.orderId]
            );
            
            orders[0].items = items;
            res.json(orders[0]);
        } catch (error) {
            console.error('Error obteniendo detalle:', error);
            res.status(500).json({ message: 'Error al obtener detalle del pedido' });
        }
    });

    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado inválido' });
        }

        try {
            const [orderCheck] = await db.query(
                `SELECT o.userId, oi.productId, o.userId as buyerId
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 WHERE o.id = ?`,
                [req.params.orderId]
            );

            if (orderCheck.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }

            const [product] = await db.query(
                'SELECT sellerId FROM products WHERE id = ?',
                [orderCheck[0].productId]
            );

            const isAuthorized = req.userRole === 'Administrador' || 
                                 (req.userRole === 'Vendedor' && product[0]?.sellerId === req.userId);

            if (!isAuthorized) {
                return res.status(403).json({ message: 'No tienes permiso para actualizar este pedido' });
            }

            await db.query(
                'UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?',
                [status, req.params.orderId]
            );

            const statusMessages = {
                'processing': 'Tu pedido está siendo procesado',
                'shipped': 'Tu pedido ha sido enviado',
                'delivered': 'Tu pedido ha sido entregado. ¡Disfrútalo!',
                'cancelled': 'Tu pedido ha sido cancelado'
            };
            
            if (statusMessages[status]) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [orderCheck[0].buyerId, 
                     `📦 Pedido #${req.params.orderId}`, 
                     statusMessages[status]]
                );
            }

            res.json({ message: 'Estado actualizado correctamente' });

        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    router.get('/seller/sales', authenticateToken, isSeller, async (req, res) => {
        try {
            const [sales] = await db.query(
                `SELECT o.*, oi.productName, oi.quantity, oi.price, oi.imageUrl, u.nombreCompleto as buyerName
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 JOIN users u ON o.userId = u.id
                 WHERE p.sellerId = ?`,
                [req.userId]
            );
            
            sales.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            
            const totalSales = sales.reduce((sum, s) => sum + (parseFloat(s.price) * s.quantity), 0);
            const totalOrders = [...new Set(sales.map(s => s.id))].length;
            
            res.json({ sales, totalSales, totalOrders });
        } catch (error) {
            console.error('Error obteniendo ventas:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    return router;
};