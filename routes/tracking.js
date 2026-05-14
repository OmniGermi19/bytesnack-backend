// backend/routes/tracking.js
const express = require('express');
const { authenticateToken, isSeller } = require('../middleware/auth');

module.exports = (db, trackingService) => {
    const router = express.Router();

    // POST /api/tracking/start - Iniciar seguimiento (vendedor)
    router.post('/start', authenticateToken, isSeller, async (req, res) => {
        const { orderId } = req.body;
        
        console.log(`📍 [Tracking] Iniciando tracking para pedido ${orderId} por vendedor ${req.userId}`);
        
        if (!orderId) {
            return res.status(400).json({ message: 'ID de pedido requerido' });
        }
        
        try {
            const [orders] = await db.query(
                `SELECT o.id, o.status, p.sellerId, p.sellerName, u.nombreCompleto as sellerNameFull
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 JOIN users u ON p.sellerId = u.id
                 WHERE o.id = ? AND p.sellerId = ? LIMIT 1`,
                [orderId, req.userId]
            );
            
            if (orders.length === 0) {
                return res.status(403).json({ message: 'No tienes permiso para rastrear este pedido' });
            }
            
            const order = orders[0];
            
            if (order.status !== 'processing' && order.status !== 'shipped') {
                return res.status(400).json({ message: 'El pedido no está en estado de envío' });
            }
            
            await db.query(
                `INSERT INTO tracking_sessions (orderId, sellerId, sellerName, status, startedAt, updatedAt)
                 VALUES (?, ?, ?, 'active', NOW(), NOW())
                 ON DUPLICATE KEY UPDATE status = 'active', updatedAt = NOW()`,
                [orderId, req.userId, order.sellerNameFull]
            );
            
            if (trackingService) {
                trackingService.setSellerName(orderId, order.sellerNameFull);
            }
            
            console.log(`✅ [Tracking] Tracking iniciado para pedido ${orderId}`);
            res.json({ 
                success: true, 
                message: 'Seguimiento iniciado correctamente',
                orderId: orderId
            });
        } catch (error) {
            console.error('❌ Error iniciando tracking:', error);
            res.status(500).json({ message: 'Error al iniciar seguimiento: ' + error.message });
        }
    });

    // POST /api/tracking/stop - Detener seguimiento
    router.post('/stop', authenticateToken, async (req, res) => {
        const { orderId } = req.body;
        
        console.log(`📍 [Tracking] Deteniendo tracking para pedido ${orderId} por usuario ${req.userId}`);
        
        if (!orderId) {
            return res.status(400).json({ message: 'ID de pedido requerido' });
        }
        
        try {
            await db.query(
                `UPDATE tracking_sessions 
                 SET status = 'ended', endedAt = NOW(), updatedAt = NOW() 
                 WHERE orderId = ? AND sellerId = ?`,
                [orderId, req.userId]
            );
            
            console.log(`✅ [Tracking] Tracking detenido para pedido ${orderId}`);
            res.json({ success: true, message: 'Seguimiento detenido correctamente' });
        } catch (error) {
            console.error('❌ Error deteniendo tracking:', error);
            res.status(500).json({ message: 'Error al detener seguimiento' });
        }
    });

    // POST /api/tracking/location - Actualizar ubicación (vendedor)
    router.post('/location', authenticateToken, isSeller, async (req, res) => {
        const { orderId, lat, lng, address, speed, accuracy } = req.body;
        
        console.log(`📍 [Tracking] Actualizando ubicación para pedido ${orderId}: (${lat}, ${lng})`);
        
        if (!orderId || lat === undefined || lng === undefined) {
            return res.status(400).json({ message: 'Datos incompletos: se requiere orderId, lat, lng' });
        }

        if (lat < -90 || lat > 90) {
            return res.status(400).json({ message: 'Latitud inválida' });
        }
        
        if (lng < -180 || lng > 180) {
            return res.status(400).json({ message: 'Longitud inválida' });
        }

        try {
            const [sessionCheck] = await db.query(
                `SELECT sellerId FROM tracking_sessions WHERE orderId = ?`,
                [orderId]
            );
            
            if (sessionCheck.length > 0 && sessionCheck[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            
            await db.query(
                `UPDATE tracking_sessions 
                 SET lastLat = ?, lastLng = ?, lastAddress = ?, lastSpeed = ?, lastAccuracy = ?, lastLocationUpdate = NOW(), updatedAt = NOW()
                 WHERE orderId = ?`,
                [lat, lng, address || null, speed || null, accuracy || null, orderId]
            );

            await db.query(
                `INSERT INTO tracking_locations (orderId, lat, lng, address, speed, accuracy, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [orderId, lat, lng, address || null, speed || null, accuracy || null]
            );

            console.log(`✅ [Tracking] Ubicación actualizada para pedido ${orderId}`);
            res.json({ success: true, message: 'Ubicación actualizada' });
        } catch (error) {
            console.error('❌ Error guardando ubicación:', error);
            res.status(500).json({ message: 'Error al guardar ubicación' });
        }
    });

    // GET /api/tracking/status/:orderId - Obtener estado del tracking
    router.get('/status/:orderId', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        
        console.log(`📍 [Tracking] Consultando estado de tracking para pedido ${orderId} por usuario ${req.userId}`);
        
        try {
            const [sessions] = await db.query(
                `SELECT ts.*, u.nombreCompleto as sellerName,
                        o.sellerConfirmed, o.buyerReceived, o.status as orderStatus
                 FROM tracking_sessions ts
                 LEFT JOIN users u ON ts.sellerId = u.id
                 LEFT JOIN orders o ON ts.orderId = o.id
                 WHERE ts.orderId = ?`,
                [orderId]
            );
            
            const [orderCheck] = await db.query(
                `SELECT userId FROM orders WHERE id = ?`,
                [orderId]
            );
            
            const isBuyer = orderCheck.length > 0 && orderCheck[0].userId === req.userId;
            const isSeller = sessions.length > 0 && sessions[0].sellerId === req.userId;
            const isAdmin = req.userRole === 'Administrador';
            
            if (!isBuyer && !isSeller && !isAdmin) {
                return res.status(403).json({ message: 'No tienes permiso para ver este tracking' });
            }
            
            if (sessions.length === 0) {
                if (orderCheck.length === 0) {
                    return res.status(404).json({ message: 'Pedido no encontrado' });
                }
                
                const [order] = await db.query(
                    `SELECT sellerConfirmed, buyerReceived, status FROM orders WHERE id = ?`,
                    [orderId]
                );
                
                return res.json({ 
                    active: false,
                    sellerConfirmed: order[0]?.sellerConfirmed === 1,
                    buyerReceived: order[0]?.buyerReceived === 1,
                    orderStatus: order[0]?.status || 'pending'
                });
            }
            
            const session = sessions[0];
            
            const response = {
                active: session.status === 'active',
                orderId: session.orderId,
                sellerId: session.sellerId,
                sellerName: session.sellerName,
                status: session.status,
                startedAt: session.startedAt,
                endedAt: session.endedAt,
                sellerConfirmed: session.sellerConfirmed === 1,
                buyerReceived: session.buyerReceived === 1,
                orderStatus: session.orderStatus,
                lastLocation: session.lastLat && session.lastLng ? {
                    lat: parseFloat(session.lastLat),
                    lng: parseFloat(session.lastLng),
                    address: session.lastAddress,
                    speed: session.lastSpeed ? parseFloat(session.lastSpeed) : null,
                    accuracy: session.lastAccuracy ? parseFloat(session.lastAccuracy) : null,
                    updatedAt: session.lastLocationUpdate
                } : null
            };
            
            console.log(`✅ [Tracking] Estado obtenido: active=${response.active}`);
            res.json(response);
        } catch (error) {
            console.error('❌ Error obteniendo estado de tracking:', error);
            res.status(500).json({ message: 'Error al obtener estado: ' + error.message });
        }
    });

    // GET /api/tracking/history/:orderId - Obtener historial de ubicaciones
    router.get('/history/:orderId', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        const { limit = 50 } = req.query;
        
        console.log(`📍 [Tracking] Obteniendo historial de ubicaciones para pedido ${orderId}`);
        
        try {
            const [orderCheck] = await db.query(
                `SELECT userId FROM orders WHERE id = ?`,
                [orderId]
            );
            
            const [sellerCheck] = await db.query(
                `SELECT DISTINCT p.sellerId
                 FROM order_items oi
                 JOIN products p ON oi.productId = p.id
                 WHERE oi.orderId = ? AND p.sellerId = ?`,
                [orderId, req.userId]
            );
            
            const isAuthorized = req.userRole === 'Administrador' || 
                                (orderCheck.length > 0 && orderCheck[0].userId === req.userId) ||
                                sellerCheck.length > 0;
            
            if (!isAuthorized) {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            
            const [locations] = await db.query(
                `SELECT lat, lng, address, speed, accuracy, createdAt
                 FROM tracking_locations
                 WHERE orderId = ?
                 ORDER BY createdAt DESC
                 LIMIT ?`,
                [orderId, parseInt(limit)]
            );
            
            const processedLocations = locations.map(loc => ({
                lat: parseFloat(loc.lat),
                lng: parseFloat(loc.lng),
                address: loc.address,
                speed: loc.speed ? parseFloat(loc.speed) : null,
                accuracy: loc.accuracy ? parseFloat(loc.accuracy) : null,
                timestamp: loc.createdAt
            })).reverse();
            
            console.log(`✅ [Tracking] ${processedLocations.length} ubicaciones obtenidas`);
            res.json({ locations: processedLocations });
        } catch (error) {
            console.error('❌ Error obteniendo historial:', error);
            res.status(500).json({ message: 'Error al obtener historial' });
        }
    });

    return router;
};