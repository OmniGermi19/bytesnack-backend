const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/orders - Crear pedido
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        console.log('📦 [Orders] === NUEVO PEDIDO ===');
        console.log(`📦 [Orders] Usuario: ${req.userId}`);
        
        const { items, total, paymentMethod, shippingAddress } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: 'El carrito esta vacio'
            });
        }

        if (!total || total <= 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Total invalido'
            });
        }

        const validPaymentMethods = ['Efectivo', 'Tarjeta'];
        if (!paymentMethod || !validPaymentMethods.includes(paymentMethod)) {
            return res.status(400).json({ 
                success: false,
                message: 'Metodo de pago invalido'
            });
        }

        try {
            // Verificar stock y obtener info
            for (const item of items) {
                const [products] = await db.query(
                    'SELECT id, stock, name, sellerId, sellerName, isAvailable, status FROM products WHERE id = ?',
                    [item.productId]
                );
                
                if (products.length === 0) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'Producto no encontrado: ' + item.name
                    });
                }
                
                const product = products[0];
                
                if (product.status !== 'approved') {
                    return res.status(400).json({ 
                        success: false,
                        message: 'Producto no aprobado: ' + product.name
                    });
                }
                
                if (product.isAvailable !== 1) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'Producto no disponible: ' + product.name
                    });
                }
                
                if (product.stock < item.quantity) {
                    return res.status(400).json({ 
                        success: false,
                        message: `Stock insuficiente para: ${product.name}. Disponible: ${product.stock}`
                    });
                }
                
                item.sellerId = product.sellerId;
                item.sellerName = product.sellerName;
                item.productStock = product.stock;
            }

            // Obtener comprador
            const [buyerInfo] = await db.query(
                'SELECT nombreCompleto, numeroControl FROM users WHERE id = ?',
                [req.userId]
            );
            
            const buyer = buyerInfo[0];

            // Crear pedido
            const [orderResult] = await db.query(
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt, sellerConfirmed, buyerReceived)
                 VALUES (?, ?, ?, ?, 'pending', NOW(), NOW(), FALSE, FALSE)`,
                [req.userId, total, paymentMethod, shippingAddress || 'Entrega en ITESCO']
            );

            const orderId = orderResult.insertId;
            console.log(`✅ [Orders] Pedido creado ID: ${orderId}`);

            // Insertar items
            for (const item of items) {
                await db.query(
                    `INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl)
                     VALUES (?, ?, ?, ?, ?, NULL)`,
                    [orderId, item.productId, item.name, item.quantity, item.price]
                );
            }

            // Actualizar stock (disminuir)
            for (const item of items) {
                await db.query(
                    'UPDATE products SET stock = stock - ?, updatedAt = NOW() WHERE id = ?',
                    [item.quantity, item.productId]
                );
                console.log(`📦 [Orders] Stock actualizado: producto ${item.productId} -${item.quantity}`);
            }

            // Vaciar carrito
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);

            // Notificar vendedores
            const sellerMap = new Map();
            
            for (const item of items) {
                if (!sellerMap.has(item.sellerId)) {
                    sellerMap.set(item.sellerId, {
                        sellerId: item.sellerId,
                        sellerName: item.sellerName,
                        items: [],
                        totalAmount: 0
                    });
                }
                const sellerData = sellerMap.get(item.sellerId);
                sellerData.items.push({
                    name: item.name,
                    quantity: item.quantity,
                    price: item.price,
                    subtotal: item.price * item.quantity
                });
                sellerData.totalAmount += item.price * item.quantity;
            }
            
            for (const [sellerId, sellerData] of sellerMap) {
                let itemsList = '';
                for (const item of sellerData.items) {
                    itemsList += `${item.quantity}x ${item.name} - $${item.subtotal.toFixed(2)}\n`;
                }
                
                const notificationBody = `NUEVO PEDIDO #${orderId}\n\n` +
                    `Cliente: ${buyer.nombreCompleto}\n` +
                    `Control: ${buyer.numeroControl}\n\n` +
                    `Productos:\n${itemsList}\n` +
                    `Total: $${sellerData.totalAmount.toFixed(2)}\n` +
                    `Pago: ${paymentMethod}`;
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [sellerId, `🆕 NUEVO PEDIDO #${orderId}`, notificationBody]
                );
                console.log(`📢 [Orders] Notificado vendedor ${sellerId}`);
            }

            // Notificar comprador
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                [req.userId,
                 `✅ Pedido #${orderId} confirmado`,
                 `Tu pedido ha sido creado exitosamente.\nTotal: $${total.toFixed(2)}\nPago: ${paymentMethod}\nLos vendedores han sido notificados.`]
            );

            console.log(`✅ [Orders] Pedido ${orderId} completado exitosamente`);
            res.status(201).json({ 
                success: true,
                id: orderId, 
                message: 'Pedido creado exitosamente',
                paymentMethod: paymentMethod,
                total: total
            });

        } catch (error) {
            console.error('❌ Error creando pedido:', error);
            res.status(500).json({ 
                success: false,
                message: 'Error al crear pedido: ' + error.message 
            });
        }
    });

    // GET /api/orders - Obtener pedidos del usuario
    router.get('/', authenticateToken, async (req, res) => {
        try {
            console.log(`📦 [Orders] Obteniendo pedidos de usuario ${req.userId}`);
            
            const [orders] = await db.query(
                'SELECT * FROM orders WHERE userId = ? ORDER BY createdAt DESC',
                [req.userId]
            );
            
            for (const order of orders) {
                const [items] = await db.query(
                    'SELECT * FROM order_items WHERE orderId = ?',
                    [order.id]
                );
                order.items = items;
            }
            
            console.log(`✅ [Orders] ${orders.length} pedidos encontrados`);
            res.json(orders);
        } catch (error) {
            console.error('❌ Error:', error);
            res.status(500).json({ message: 'Error al obtener pedidos' });
        }
    });

    // GET /api/orders/seller/sales - Ventas del vendedor
    router.get('/seller/sales', authenticateToken, isSeller, async (req, res) => {
        try {
            console.log(`📦 [Orders] Obteniendo ventas de vendedor ${req.userId}`);
            
            const [sales] = await db.query(
                `SELECT DISTINCT 
                    o.id, o.userId, o.total, o.paymentMethod, o.status, o.createdAt, o.updatedAt,
                    o.shippingAddress,
                    u.nombreCompleto as buyerName, u.numeroControl as buyerControl, u.telefono as buyerPhone,
                    o.sellerConfirmed, o.buyerReceived, o.sellerConfirmedAt, o.buyerReceivedAt
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 JOIN users u ON o.userId = u.id
                 WHERE p.sellerId = ?
                 ORDER BY o.createdAt DESC`,
                [req.userId]
            );
            
            for (const sale of sales) {
                const [items] = await db.query(
                    `SELECT oi.* 
                     FROM order_items oi
                     JOIN products p ON oi.productId = p.id
                     WHERE oi.orderId = ? AND p.sellerId = ?`,
                    [sale.id, req.userId]
                );
                sale.items = items;
            }
            
            let totalSales = 0;
            for (const sale of sales) {
                totalSales += parseFloat(sale.total);
            }
            
            const stats = {
                pending: sales.filter(s => s.status === 'pending').length,
                processing: sales.filter(s => s.status === 'processing').length,
                shipped: sales.filter(s => s.status === 'shipped').length,
                delivered: sales.filter(s => s.status === 'delivered').length,
                cancelled: sales.filter(s => s.status === 'cancelled').length
            };
            
            console.log(`✅ [Orders] ${sales.length} ventas encontradas, total: $${totalSales.toFixed(2)}`);
            res.json({ sales, totalSales, totalOrders: sales.length, stats });
            
        } catch (error) {
            console.error('❌ Error:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    // GET /api/orders/:orderId - Obtener detalle de un pedido específico
    router.get('/:orderId', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        
        console.log(`📦 [Orders] Obteniendo detalle del pedido ${orderId} para usuario ${req.userId}`);
        
        try {
            const [orders] = await db.query(
                `SELECT o.*, u.nombreCompleto as buyerName, u.numeroControl as buyerControl, u.telefono as buyerPhone, u.email as buyerEmail
                 FROM orders o
                 JOIN users u ON o.userId = u.id
                 WHERE o.id = ?`,
                [orderId]
            );
            
            if (orders.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            const order = orders[0];
            
            const [sellerCheck] = await db.query(
                `SELECT DISTINCT p.sellerId
                 FROM order_items oi
                 JOIN products p ON oi.productId = p.id
                 WHERE oi.orderId = ? AND p.sellerId = ?`,
                [orderId, req.userId]
            );
            
            const isAuthorized = req.userRole === 'Administrador' || 
                                order.userId === req.userId || 
                                sellerCheck.length > 0;
            
            if (!isAuthorized) {
                return res.status(403).json({ message: 'No tienes permiso para ver este pedido' });
            }
            
            const [items] = await db.query(
                `SELECT oi.*, p.images as productImages
                 FROM order_items oi
                 LEFT JOIN products p ON oi.productId = p.id
                 WHERE oi.orderId = ?`,
                [orderId]
            );
            
            const processedItems = items.map(item => ({
                ...item,
                price: parseFloat(item.price),
                imageUrl: item.productImages ? (JSON.parse(item.productImages || '[]')[0] || null) : null
            }));
            
            order.items = processedItems;
            order.total = parseFloat(order.total);
            
            const [tracking] = await db.query(
                `SELECT ts.status as trackingStatus, ts.startedAt, ts.lastLat, ts.lastLng, ts.lastAddress,
                        ts.lastSpeed, ts.lastAccuracy, ts.lastLocationUpdate
                 FROM tracking_sessions ts
                 WHERE ts.orderId = ?`,
                [orderId]
            );
            
            if (tracking.length > 0) {
                order.tracking = {
                    active: tracking[0].trackingStatus === 'active',
                    status: tracking[0].trackingStatus,
                    startedAt: tracking[0].startedAt,
                    lastLocation: tracking[0].lastLat && tracking[0].lastLng ? {
                        lat: tracking[0].lastLat,
                        lng: tracking[0].lastLng,
                        address: tracking[0].lastAddress,
                        speed: tracking[0].lastSpeed,
                        accuracy: tracking[0].lastAccuracy,
                        updatedAt: tracking[0].lastLocationUpdate
                    } : null
                };
            } else {
                order.tracking = { active: false };
            }
            
            res.json(order);
            
        } catch (error) {
            console.error('❌ Error obteniendo detalle del pedido:', error);
            res.status(500).json({ message: 'Error al obtener detalle del pedido: ' + error.message });
        }
    });

    // PATCH /api/orders/:orderId/status - Actualizar estado
    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const orderId = req.params.orderId;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        console.log(`📦 [Orders] Actualizando estado del pedido ${orderId} a ${status} por usuario ${req.userId}`);
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado invalido' });
        }

        try {
            const [orderInfo] = await db.query(
                `SELECT o.userId as buyerId, o.total, o.paymentMethod, o.status as currentStatus
                 FROM orders o
                 WHERE o.id = ?`,
                [orderId]
            );
            
            if (orderInfo.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            const [sellerCheck] = await db.query(
                `SELECT DISTINCT p.sellerId
                 FROM order_items oi
                 JOIN products p ON oi.productId = p.id
                 WHERE oi.orderId = ? AND p.sellerId = ?`,
                [orderId, req.userId]
            );
            
            const isAuthorized = req.userRole === 'Administrador' || sellerCheck.length > 0 || orderInfo[0].buyerId === req.userId;
            
            if (!isAuthorized) {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            
            if (orderInfo[0].buyerId === req.userId && status === 'delivered') {
                const [sellerIds] = await db.query(
                    `SELECT DISTINCT p.sellerId
                     FROM order_items oi
                     JOIN products p ON oi.productId = p.id
                     WHERE oi.orderId = ?`,
                    [orderId]
                );
                
                for (const seller of sellerIds) {
                    await db.query(
                        'UPDATE users SET totalVentas = totalVentas + 1 WHERE id = ?',
                        [seller.sellerId]
                    );
                }
                
                await db.query(
                    'UPDATE users SET totalCompras = totalCompras + 1 WHERE id = ?',
                    [orderInfo[0].buyerId]
                );
            }
            
            await db.query(
                'UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?',
                [status, orderId]
            );
            
            const isBuyerAction = orderInfo[0].buyerId === req.userId;
            
            let buyerTitle = '';
            let buyerBody = '';
            let sellerTitle = '';
            let sellerBody = '';
            
            if (status === 'processing') {
                buyerTitle = 'Pedido en proceso';
                buyerBody = `Tu pedido #${orderId} esta siendo preparado por el vendedor.`;
                sellerTitle = 'Pedido marcado como en proceso';
                sellerBody = `Has marcado el pedido #${orderId} como "En proceso".`;
            } else if (status === 'shipped') {
                buyerTitle = 'Pedido enviado';
                buyerBody = `¡Buenas noticias! Tu pedido #${orderId} ha sido enviado. Pronto lo recibiras.`;
                sellerTitle = 'Pedido marcado como enviado';
                sellerBody = `Has marcado el pedido #${orderId} como "Enviado".`;
            } else if (status === 'delivered') {
                if (isBuyerAction) {
                    buyerTitle = 'Pedido recibido';
                    buyerBody = `Has confirmado la recepción del pedido #${orderId}. ¡Gracias por comprar!`;
                    sellerTitle = 'Pedido entregado';
                    sellerBody = `El comprador ha confirmado la recepción del pedido #${orderId}. ¡Venta completada!`;
                } else {
                    buyerTitle = 'Pedido entregado';
                    buyerBody = `Tu pedido #${orderId} ha sido marcado como entregado. ¡Disfruta tus productos!`;
                    sellerTitle = 'Pedido entregado';
                    sellerBody = `Has marcado el pedido #${orderId} como "Entregado".`;
                }
            } else if (status === 'cancelled') {
                const [items] = await db.query(
                    'SELECT productId, quantity FROM order_items WHERE orderId = ?',
                    [orderId]
                );
                for (const item of items) {
                    await db.query(
                        'UPDATE products SET stock = stock + ? WHERE id = ?',
                        [item.quantity, item.productId]
                    );
                    console.log(`📦 [Orders] Stock restaurado: producto ${item.productId} +${item.quantity}`);
                }
                
                buyerTitle = 'Pedido cancelado';
                buyerBody = `Tu pedido #${orderId} ha sido cancelado. El stock ha sido restaurado.`;
                sellerTitle = 'Pedido cancelado';
                sellerBody = `Has cancelado el pedido #${orderId}. El stock ha sido restaurado.`;
            }
            
            if (buyerTitle !== '') {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [orderInfo[0].buyerId, buyerTitle, buyerBody]
                );
            }
            
            if (!isBuyerAction && sellerTitle !== '') {
                const [sellerIds] = await db.query(
                    `SELECT DISTINCT p.sellerId
                     FROM order_items oi
                     JOIN products p ON oi.productId = p.id
                     WHERE oi.orderId = ?`,
                    [orderId]
                );
                for (const seller of sellerIds) {
                    await db.query(
                        `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                         VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                        [seller.sellerId, sellerTitle, sellerBody]
                    );
                }
            }
            
            console.log(`✅ [Orders] Estado del pedido ${orderId} actualizado a ${status}`);
            res.json({ success: true, message: 'Estado actualizado correctamente' });
            
        } catch (error) {
            console.error('❌ Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    // ========== CONFIRMACIONES DE ENTREGA ==========

    // Vendedor confirma entrega
    router.post('/:orderId/confirm-seller', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        
        console.log(`📦 [Orders] Vendedor ${req.userId} confirma entrega del pedido ${orderId}`);
        
        try {
            const [sellerCheck] = await db.query(
                `SELECT DISTINCT p.sellerId, o.userId as buyerId, o.status
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 WHERE o.id = ? AND p.sellerId = ?`,
                [orderId, req.userId]
            );
            
            if (sellerCheck.length === 0 && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            
            // Actualizar confirmación del vendedor
            await db.query(
                `UPDATE orders 
                 SET sellerConfirmed = TRUE, sellerConfirmedAt = NOW(), updatedAt = NOW() 
                 WHERE id = ?`,
                [orderId]
            );
            
            // Verificar si ambas confirmaciones están completas
            const [order] = await db.query(
                `SELECT buyerReceived, status FROM orders WHERE id = ?`,
                [orderId]
            );
            
            // Si ambas confirmaciones son TRUE, cambiar estado a delivered
            if (order[0]?.buyerReceived === 1) {
                await db.query(
                    `UPDATE orders SET status = 'delivered', updatedAt = NOW() WHERE id = ?`,
                    [orderId]
                );
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [sellerCheck[0].buyerId,
                     '✅ Pedido completado',
                     `El vendedor confirmó la entrega de tu pedido #${orderId}. ¡Gracias por comprar en ByteSnack!`]
                );
            }
            
            // Notificar al comprador
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                [sellerCheck[0].buyerId,
                 '📦 Pedido entregado por vendedor',
                 `El vendedor ha confirmado que entregó tu pedido #${orderId}. Confirma la recepción para completar la compra.`]
            );
            
            console.log(`✅ [Orders] Entrega confirmada por vendedor para pedido ${orderId}`);
            res.json({ success: true, message: 'Entrega confirmada por vendedor' });
        } catch (error) {
            console.error('❌ Error confirmando entrega:', error);
            res.status(500).json({ message: 'Error al confirmar entrega' });
        }
    });

    // Comprador confirma recepción
    router.post('/:orderId/confirm-buyer', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        
        console.log(`📦 [Orders] Comprador ${req.userId} confirma recepción del pedido ${orderId}`);
        
        try {
            const [orderCheck] = await db.query(
                `SELECT userId, sellerConfirmed, status FROM orders WHERE id = ? AND userId = ?`,
                [orderId, req.userId]
            );
            
            if (orderCheck.length === 0 && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            
            // Actualizar confirmación del comprador
            await db.query(
                `UPDATE orders 
                 SET buyerReceived = TRUE, buyerReceivedAt = NOW(), updatedAt = NOW() 
                 WHERE id = ?`,
                [orderId]
            );
            
            // Verificar si ambas confirmaciones están completas
            const [order] = await db.query(
                `SELECT sellerConfirmed, status FROM orders WHERE id = ?`,
                [orderId]
            );
            
            // Si ambas confirmaciones son TRUE, cambiar estado a delivered
            if (order[0]?.sellerConfirmed === 1) {
                await db.query(
                    `UPDATE orders SET status = 'delivered', updatedAt = NOW() WHERE id = ?`,
                    [orderId]
                );
            }
            
            // Notificar a los vendedores
            const [sellerIds] = await db.query(
                `SELECT DISTINCT p.sellerId
                 FROM order_items oi
                 JOIN products p ON oi.productId = p.id
                 WHERE oi.orderId = ?`,
                [orderId]
            );
            
            for (const seller of sellerIds) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [seller.sellerId,
                     '✅ Compra completada',
                     `El comprador confirmó la recepción del pedido #${orderId}. ¡Venta completada!`]
                );
            }
            
            console.log(`✅ [Orders] Recepción confirmada por comprador para pedido ${orderId}`);
            res.json({ success: true, message: 'Recepción confirmada por comprador' });
        } catch (error) {
            console.error('❌ Error confirmando recepción:', error);
            res.status(500).json({ message: 'Error al confirmar recepción' });
        }
    });

    return router;
};