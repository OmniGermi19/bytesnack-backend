const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/orders - Crear pedido
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        console.log('=== NUEVO PEDIDO ===');
        console.log('Usuario:', req.userId);
        
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
                        message: 'Stock insuficiente para: ' + product.name + '. Disponible: ' + product.stock
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
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
                [req.userId, total, paymentMethod, shippingAddress || 'Entrega en ITESCO']
            );

            const orderId = orderResult.insertId;
            console.log('Pedido creado ID:', orderId);

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
                console.log(`Stock actualizado: producto ${item.productId} -${item.quantity}`);
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
                
                const notificationBody = `🆕 NUEVO PEDIDO #${orderId}\n\n` +
                    `👤 Cliente: ${buyer.nombreCompleto}\n` +
                    `🆔 Control: ${buyer.numeroControl}\n\n` +
                    `📦 Productos:\n${itemsList}\n` +
                    `💰 Total: $${sellerData.totalAmount.toFixed(2)}\n` +
                    `💳 Pago: ${paymentMethod}`;
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [sellerId, `🛒 NUEVO PEDIDO #${orderId}`, notificationBody]
                );
            }

            // Notificar comprador
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                [req.userId,
                 `✅ Pedido #${orderId} confirmado`,
                 `Tu pedido ha sido creado exitosamente.\nTotal: $${total.toFixed(2)}\nPago: ${paymentMethod}\nLos vendedores han sido notificados.`]
            );

            res.status(201).json({ 
                success: true,
                id: orderId, 
                message: 'Pedido creado exitosamente',
                paymentMethod: paymentMethod,
                total: total
            });

        } catch (error) {
            console.error('Error creando pedido:', error);
            res.status(500).json({ 
                success: false,
                message: 'Error al crear pedido: ' + error.message 
            });
        }
    });

    // GET /api/orders - Obtener pedidos del usuario
    router.get('/', authenticateToken, async (req, res) => {
        try {
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
            
            res.json(orders);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({ message: 'Error al obtener pedidos' });
        }
    });

    // GET /api/orders/seller/sales - Ventas del vendedor
    router.get('/seller/sales', authenticateToken, isSeller, async (req, res) => {
        try {
            const [sales] = await db.query(
                `SELECT DISTINCT 
                    o.id, o.userId, o.total, o.paymentMethod, o.status, o.createdAt, o.updatedAt,
                    o.shippingAddress,
                    u.nombreCompleto as buyerName, u.numeroControl as buyerControl, u.telefono as buyerPhone
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
            
            res.json({ sales, totalSales, totalOrders: sales.length, stats });
            
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    // PATCH /api/orders/:orderId/status - Actualizar estado (MEJORADO)
    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const orderId = req.params.orderId;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado invalido' });
        }

        try {
            // Obtener información del pedido
            const [orderInfo] = await db.query(
                `SELECT o.userId as buyerId, o.total, o.paymentMethod, o.status as currentStatus
                 FROM orders o
                 WHERE o.id = ?`,
                [orderId]
            );
            
            if (orderInfo.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            // Verificar permisos
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
            
            // Si es el comprador confirmando entrega
            if (orderInfo[0].buyerId === req.userId && status === 'delivered') {
                // Actualizar estadísticas del vendedor
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
                
                // Actualizar estadísticas del comprador
                await db.query(
                    'UPDATE users SET totalCompras = totalCompras + 1 WHERE id = ?',
                    [orderInfo[0].buyerId]
                );
            }
            
            await db.query(
                'UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?',
                [status, orderId]
            );
            
            // Mensajes según el estado y quién lo actualizó
            const isBuyerAction = orderInfo[0].buyerId === req.userId;
            
            let buyerTitle = '';
            let buyerBody = '';
            let sellerTitle = '';
            let sellerBody = '';
            
            if (status === 'processing') {
                buyerTitle = '🔄 Pedido en proceso';
                buyerBody = `Tu pedido #${orderId} esta siendo preparado por el vendedor.`;
                sellerTitle = '✅ Pedido marcado como en proceso';
                sellerBody = `Has marcado el pedido #${orderId} como "En proceso".`;
            } else if (status === 'shipped') {
                buyerTitle = '📦 Pedido enviado';
                buyerBody = `¡Buenas noticias! Tu pedido #${orderId} ha sido enviado. Pronto lo recibiras.`;
                sellerTitle = '✅ Pedido marcado como enviado';
                sellerBody = `Has marcado el pedido #${orderId} como "Enviado".`;
            } else if (status === 'delivered') {
                if (isBuyerAction) {
                    buyerTitle = '✅ Pedido recibido';
                    buyerBody = `Has confirmado la recepción del pedido #${orderId}. ¡Gracias por comprar en ByteSnack!`;
                    sellerTitle = '🎉 Pedido entregado';
                    sellerBody = `El comprador ha confirmado la recepción del pedido #${orderId}. ¡Venta completada!`;
                } else {
                    buyerTitle = '✅ Pedido entregado';
                    buyerBody = `Tu pedido #${orderId} ha sido marcado como entregado. ¡Disfruta tus productos!`;
                    sellerTitle = '✅ Pedido entregado';
                    sellerBody = `Has marcado el pedido #${orderId} como "Entregado".`;
                }
            } else if (status === 'cancelled') {
                // Restaurar stock si se cancela
                const [items] = await db.query(
                    'SELECT productId, quantity FROM order_items WHERE orderId = ?',
                    [orderId]
                );
                for (const item of items) {
                    await db.query(
                        'UPDATE products SET stock = stock + ? WHERE id = ?',
                        [item.quantity, item.productId]
                    );
                }
                
                buyerTitle = '❌ Pedido cancelado';
                buyerBody = `Tu pedido #${orderId} ha sido cancelado. El stock ha sido restaurado.`;
                sellerTitle = '❌ Pedido cancelado';
                sellerBody = `Has cancelado el pedido #${orderId}. El stock ha sido restaurado.`;
            }
            
            // Notificar al comprador
            if (buyerTitle !== '') {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [orderInfo[0].buyerId, buyerTitle, buyerBody]
                );
            }
            
            // Notificar al vendedor (si no es el comprador)
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
            
            res.json({ success: true, message: 'Estado actualizado correctamente' });
            
        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    // GET /api/orders/:orderId/timeline - Obtener línea de tiempo del pedido
    router.get('/:orderId/timeline', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        
        try {
            const [timeline] = await db.query(
                `SELECT status, createdAt, updatedAt
                 FROM orders
                 WHERE id = ?`,
                [orderId]
            );
            
            res.json(timeline[0] || {});
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({ message: 'Error al obtener timeline' });
        }
    });

    return router;
};