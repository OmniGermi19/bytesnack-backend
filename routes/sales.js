const express = require('express');
const db = require('../config/database');
const { authenticateToken, isSeller } = require('../middleware/auth');
const router = express.Router();

// GET /api/sales
router.get('/', authenticateToken, isSeller, async (req, res) => {
    try {
        const [sales] = await db.query(
            `SELECT DISTINCT o.*,
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
             JOIN order_items oi ON o.id = oi.order_id
             JOIN products p ON oi.product_id = p.id
             WHERE p.seller_id = ?
             ORDER BY o.created_at DESC`,
            [req.userId]
        );
        
        const parsedSales = sales.map(s => ({
            ...s,
            items: s.items ? JSON.parse(s.items) : []
        }));

        res.json({ sales: parsedSales });
    } catch (error) {
        console.error('Error getting sales:', error);
        res.status(500).json({ success: false, message: 'Error al obtener ventas' });
    }
});

module.exports = router;