const express = require('express');
const { authenticateToken, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/sales - Ventas del vendedor
    router.get('/', authenticateToken, isSeller, async (req, res) => {
        try {
            const [sales] = await db.query(
                `SELECT o.*, oi.productName, oi.quantity, oi.price, oi.imageUrl, u.nombreCompleto as buyerName, u.numeroControl as buyerControl
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 JOIN users u ON o.userId = u.id
                 WHERE p.sellerId = ?
                 ORDER BY o.createdAt DESC`,
                [req.userId]
            );
            
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
        } catch (error) {
            console.error('Error obteniendo ventas:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    // GET /api/sales/stats - Estadísticas de ventas
    router.get('/stats', authenticateToken, isSeller, async (req, res) => {
        try {
            const [stats] = await db.query(
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
                [req.userId]
            );
            res.json(stats);
        } catch (error) {
            console.error('Error obteniendo estadísticas:', error);
            res.status(500).json({ message: 'Error al obtener estadísticas' });
        }
    });

    return router;
};