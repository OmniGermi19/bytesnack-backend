const express = require('express');
const db = require('../config/database');
const { authenticateToken, isSeller } = require('../middleware/auth');
const router = express.Router();

// GET /api/orders
router.get('/', authenticateToken, async (req, res) => {
    const { status } = req.query;

    try {
        let query = `
            SELECT o.*, 
                   (SELECT JSON_ARRAYAGG(
                       JSON_OBJECT(
                           'productId', oi.product_id,
                           'productName', oi.product_name,
                           'price', oi.price,
                           'quantity', oi.quantity,
                           'imageUrl', oi.image_url
                       )
                   ) FROM order_items oi WHERE oi.order_id = o.id) as items
            FROM orders o
            WHERE o.user_id = ?
        `;
        const params = [req.userId];

        if (status) {
            query += ' AND o.status = ?';
            params.push(status);
        }

        query += ' ORDER BY o.created_at DESC';

        const [orders] = await db.query(query, params);
        
        const parsedOrders = orders.map(o => ({
            ...o,
            items: o.items ? JSON.parse(o.items) : []
        }));
        
        res.json({ orders: parsedOrders });
    } catch (error) {
        console.error('Error getting orders:', error);
        res.status(500).json({ success: false, message: 'Error al obtener pedidos' });
    }
});

// POST /api/orders
router.post('/', authenticateToken, async (req, res) => {
    const { items, total, paymentMethod, shippingAddress } = req.body;

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        for (const item of items) {
            const [product] = await connection.query(
                'SELECT stock, name, price, images FROM products WHERE id = ? AND is_available = 1',
                [item.productId]
            );
            if (product.length === 0 || product[0].stock < item.quantity) {
                throw new Error(`Stock insuficiente para ${item.name || 'producto'}`);
            }
        }

        const [order] = await connection.query(
            `INSERT INTO orders (user_id, total, payment_method, shipping_address, status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [req.userId, total, paymentMethod || 'Efectivo', shippingAddress || 'Entrega en ITESCO']
        );

        for (const item of items) {
            const [product] = await connection.query(
                'SELECT name, price, images FROM products WHERE id = ?',
                [item.productId]
            );

            await connection.query(
                `INSERT INTO order_items (order_id, product_id, product_name, price, quantity, image_url)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [order.insertId, item.productId, product[0].name, product[0].price, item.quantity, 
                 product[0].images ? JSON.parse(product[0].images)[0] : null]
            );

            await connection.query(
                'UPDATE products SET stock = stock - ? WHERE id = ?',
                [item.quantity, item.productId]
            );
        }

        await connection.query('DELETE FROM cart WHERE user_id = ?', [req.userId]);

        await connection.commit();

        res.status(201).json({
            success: true,
            message: 'Pedido creado exitosamente',
            orderId: order.insertId
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error creating order:', error);
        res.status(500).json({ success: false, message: error.message || 'Error al crear pedido' });
    } finally {
        connection.release();
    }
});

// PATCH /api/orders/:orderId/status
router.patch('/:orderId/status', authenticateToken, isSeller, async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Estado inválido' });
    }

    try {
        const [order] = await db.query(
            `SELECT o.* FROM orders o
             JOIN order_items oi ON o.id = oi.order_id
             JOIN products p ON oi.product_id = p.id
             WHERE o.id = ? AND p.seller_id = ?`,
            [req.params.orderId, req.userId]
        );

        if (order.length === 0 && req.userRole !== 'Administrador') {
            return res.status(403).json({ success: false, message: 'No tienes permiso para modificar este pedido' });
        }

        await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.orderId]);

        res.json({ success: true, message: 'Estado actualizado' });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar estado' });
    }
});

module.exports = router;