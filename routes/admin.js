const express = require('express');
const { authenticateToken, isAdmin } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/admin/stats - Estadísticas generales
    router.get('/stats', authenticateToken, isAdmin, (req, res) => {
        const queries = {
            totalUsers: 'SELECT COUNT(*) as count FROM users',
            totalProducts: 'SELECT COUNT(*) as count FROM products WHERE status = "approved"',
            pendingProducts: 'SELECT COUNT(*) as count FROM products WHERE status = "pending"',
            totalOrders: 'SELECT COUNT(*) as count FROM orders',
            totalSales: 'SELECT SUM(total) as total FROM orders WHERE status = "delivered"',
            totalRevenue: 'SELECT SUM(total) as total FROM orders'
        };

        const results = {};

        const executeQueries = () => {
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
        };

        executeQueries();
    });

    // GET /api/admin/pending-products - Productos pendientes
    router.get('/pending-products', authenticateToken, isAdmin, (req, res) => {
        db.query(
            `SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail, u.numeroControl as sellerControl
             FROM products p
             JOIN users u ON p.sellerId = u.id
             WHERE p.status = 'pending'
             ORDER BY p.createdAt ASC`,
            (err, products) => {
                if (err) {
                    console.error('Error obteniendo productos pendientes:', err);
                    return res.status(500).json({ message: 'Error al obtener productos pendientes' });
                }
                
                const parsedProducts = products.map(p => ({
                    ...p,
                    images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || [])
                }));
                
                res.json(parsedProducts);
            }
        );
    });

    return router;
};