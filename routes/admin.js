const jwt = require('jsonwebtoken');

module.exports = (db) => {
    const router = require('express').Router();

    const verifyAdmin = (req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ message: 'No token provided' });
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded.role !== 'Administrador') {
                return res.status(403).json({ message: 'Acceso denegado' });
            }
            next();
        } catch (e) {
            return res.status(401).json({ message: 'Invalid token' });
        }
    };

    // GET /api/admin/stats - Estadísticas del sistema
    router.get('/stats', verifyAdmin, (req, res) => {
        Promise.all([
            new Promise(resolve => db.query('SELECT COUNT(*) as total FROM users', (e, r) => resolve(r[0] || { total: 0 }))),
            new Promise(resolve => db.query('SELECT COUNT(*) as total FROM users WHERE role = "Vendedor"', (e, r) => resolve(r[0] || { total: 0 }))),
            new Promise(resolve => db.query('SELECT COUNT(*) as total FROM users WHERE role = "Comprador"', (e, r) => resolve(r[0] || { total: 0 }))),
            new Promise(resolve => db.query('SELECT COUNT(*) as total FROM products', (e, r) => resolve(r[0] || { total: 0 }))),
            new Promise(resolve => db.query('SELECT COUNT(*) as total FROM orders', (e, r) => resolve(r[0] || { total: 0 }))),
            new Promise(resolve => db.query('SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE status = "delivered"', (e, r) => resolve(r[0] || { total: 0 })))
        ]).then(([totalUsers, totalSellers, totalBuyers, totalProducts, totalOrders, totalSales]) => {
            res.json({
                totalUsers: totalUsers.total,
                totalSellers: totalSellers.total,
                totalBuyers: totalBuyers.total,
                totalProducts: totalProducts.total,
                totalOrders: totalOrders.total,
                totalSales: totalSales.total
            });
        });
    });

    return router;
};