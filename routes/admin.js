const express = require('express');
const db = require('../config/database');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const router = express.Router();

// GET /api/admin/stats
router.get('/stats', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [totalUsers] = await db.query('SELECT COUNT(*) as count FROM users');
        const [totalProducts] = await db.query('SELECT COUNT(*) as count FROM products WHERE is_available = 1');
        const [totalOrders] = await db.query('SELECT COUNT(*) as count FROM orders');
        const [totalSales] = await db.query('SELECT SUM(total) as total FROM orders WHERE status = "delivered"');

        res.json({
            totalUsers: totalUsers[0].count,
            totalProducts: totalProducts[0].count,
            totalOrders: totalOrders[0].count,
            totalSales: totalSales[0].total || 0
        });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ success: false, message: 'Error al obtener estadísticas' });
    }
});

module.exports = router;