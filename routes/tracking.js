const express = require('express');
const { authenticateToken, isSeller } = require('../middleware/auth');

module.exports = (db, trackingService) => {
    const router = express.Router();

    router.post('/start', authenticateToken, isSeller, async (req, res) => {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ message: 'ID de pedido requerido' });
        }
        try {
            const [orders] = await db.query(
                `SELECT o.id, o.status, p.sellerId, p.sellerName
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 WHERE o.id = ? AND p.sellerId = ? LIMIT 1`,
                [orderId, req.userId]
            );
            if (orders.length === 0) {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            const order = orders[0];
            if (order.status !== 'processing' && order.status !== 'shipped') {
                return res.status(400).json({ message: 'El pedido no está en estado de envío' });
            }
            await db.query(
                `INSERT INTO tracking_sessions (orderId, sellerId, status, startedAt)
                 VALUES (?, ?, 'active', NOW())
                 ON DUPLICATE KEY UPDATE status = 'active', updatedAt = NOW()`,
                [orderId, req.userId]
            );
            trackingService.setSellerName(orderId, order.sellerName);
            res.json({ success: true, message: 'Seguimiento iniciado' });
        } catch (error) {
            console.error('Error iniciando tracking:', error);
            res.status(500).json({ message: 'Error al iniciar seguimiento' });
        }
    });

    router.post('/stop', authenticateToken, async (req, res) => {
        const { orderId } = req.body;
        try {
            await db.query(
                `UPDATE tracking_sessions SET status = 'ended', endedAt = NOW() WHERE orderId = ? AND sellerId = ?`,
                [orderId, req.userId]
            );
            res.json({ success: true, message: 'Seguimiento detenido' });
        } catch (error) {
            console.error('Error deteniendo tracking:', error);
            res.status(500).json({ message: 'Error al detener seguimiento' });
        }
    });

    router.post('/location', authenticateToken, isSeller, async (req, res) => {
        const { orderId, lat, lng, address } = req.body;
        if (!orderId || lat === undefined || lng === undefined) {
            return res.status(400).json({ message: 'Datos incompletos' });
        }
        try {
            await db.query(
                `UPDATE tracking_sessions SET lastLat = ?, lastLng = ?, lastAddress = ?, lastLocationUpdate = NOW()
                 WHERE orderId = ? AND sellerId = ?`,
                [lat, lng, address || null, orderId, req.userId]
            );
            await db.query(
                `INSERT INTO tracking_locations (orderId, lat, lng, address, createdAt)
                 VALUES (?, ?, ?, ?, NOW())`,
                [orderId, lat, lng, address || null]
            );
            res.json({ success: true });
        } catch (error) {
            console.error('Error guardando ubicación:', error);
            res.status(500).json({ message: 'Error al guardar ubicación' });
        }
    });

    router.get('/status/:orderId', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        try {
            const [sessions] = await db.query(
                `SELECT ts.*, u.nombreCompleto as sellerName
                 FROM tracking_sessions ts
                 JOIN users u ON ts.sellerId = u.id
                 WHERE ts.orderId = ?`,
                [orderId]
            );
            if (sessions.length === 0) {
                return res.json({ active: false });
            }
            const session = sessions[0];
            const isSeller = session.sellerId === req.userId;
            const [orderCheck] = await db.query('SELECT userId FROM orders WHERE id = ?', [orderId]);
            const isBuyer = orderCheck.length > 0 && orderCheck[0].userId === req.userId;
            if (!isSeller && !isBuyer && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            res.json({
                active: session.status === 'active',
                orderId: session.orderId,
                sellerName: session.sellerName,
                status: session.status,
                startedAt: session.startedAt,
                lastLocation: session.lastLat && session.lastLng ? {
                    lat: session.lastLat,
                    lng: session.lastLng,
                    address: session.lastAddress,
                    updatedAt: session.lastLocationUpdate
                } : null
            });
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({ message: 'Error al obtener estado' });
        }
    });

    return router;
};