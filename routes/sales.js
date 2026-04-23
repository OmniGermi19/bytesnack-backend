const express = require('express');
const { authenticateToken, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/sales - Ventas del vendedor
    router.get('/', authenticateToken, isSeller, (req, res) => {
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
                const totalItems = sales.reduce((sum, s) => sum + s.quantity, 0);
                
                res.json({ 
                    sales, 
                    totalSales, 
                    totalOrders, 
                    totalItems,
                    averageTicket: totalOrders > 0 ? totalSales / totalOrders : 0
                });
            }
        );
    });

    // GET /api/sales/stats - Estadísticas de ventas
    router.get('/stats', authenticateToken, isSeller, (req, res) => {
        db.query(
            `SELECT DATE(o.createdAt) as date, 
                    COUNT(DISTINCT o.id) as orders,
                    SUM(oi.quantity * oi.price) as total, 
                    SUM(oi.quantity) as items
             FROM orders o
             JOIN order_items oi ON o.id = oi.orderId
             JOIN products p ON oi.productId = p.id
             WHERE p.sellerId = ? AND o.status = 'delivered'
             GROUP BY DATE(o.createdAt) 
             ORDER BY date DESC 
             LIMIT 30`,
            [req.userId],
            (err, stats) => {
                if (err) {
                    console.error('Error obteniendo estadísticas:', err);
                    return res.status(500).json({ message: 'Error al obtener estadísticas' });
                }
                res.json(stats);
            }
        );
    });

    return router;
};