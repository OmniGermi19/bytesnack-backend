const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/orders - Crear pedido
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        console.log('📦 [ORDERS] Recibida solicitud de creación de pedido');
        console.log('📦 [ORDERS] Body:', JSON.stringify(req.body, null, 2));
        
        const { items, total, paymentMethod, shippingAddress } = req.body;

        if (!items || items.length === 0) {
            console.log('❌ [ORDERS] Carrito vacío');
            return res.status(400).json({ message: 'El carrito está vacío' });
        }

        // Validar método de pago
        const validPaymentMethods = ['Efectivo', 'Tarjeta'];
        if (!validPaymentMethods.includes(paymentMethod)) {
            console.log(`❌ [ORDERS] Método de pago inválido: ${paymentMethod}`);
            return res.status(400).json({ message: 'Método de pago inválido' });
        }

        try {
            // Verificar stock de cada producto y obtener info del vendedor
            for (const item of items) {
                console.log(`📦 [ORDERS] Verificando producto ID: ${item.productId}`);
                
                const [products] = await db.query(
                    'SELECT id, stock, name, sellerId, sellerName, price, isAvailable, status FROM products WHERE id = ?',
                    [item.productId]
                );
                
                if (products.length === 0) {
                    console.log(`❌ [ORDERS] Producto no encontrado: ${item.productId}`);
                    return res.status(400).json({ 
                        message: `El producto "${item.name}" no está disponible` 
                    });
                }
                
                const product = products[0];
                
                if (product.status !== 'approved') {
                    console.log(`❌ [ORDERS] Producto no aprobado: ${product.name}`);
                    return res.status(400).json({ 
                        message: `El producto "${product.name}" no está aprobado` 
                    });
                }
                
                if (product.isAvailable !== 1) {
                    console.log(`❌ [ORDERS] Producto no disponible: ${product.name}`);
                    return res.status(400).json({ 
                        message: `El producto "${product.name}" no está disponible` 
                    });
                }
                
                if (product.stock < item.quantity) {
                    console.log(`❌ [ORDERS] Stock insuficiente para: ${product.name}`);
                    return res.status(400).json({ 
                        message: `Stock insuficiente para "${product.name}". Disponible: ${product.stock}` 
                    });
                }
                
                // Guardar información del vendedor en el item
                item.sellerId = product.sellerId;
                item.sellerName = product.sellerName;
                item.productPrice = product.price;
            }

            // Obtener información del comprador
            const [buyerInfo] = await db.query(
                'SELECT id, nombreCompleto, numeroControl, email, telefono FROM users WHERE id = ?',
                [req.userId]
            );
            
            if (buyerInfo.length === 0) {
                console.log(`❌ [ORDERS] Comprador no encontrado: ${req.userId}`);
                return res.status(404).json({ message: 'Comprador no encontrado' });
            }
            
            const buyer = buyerInfo[0];
            console.log(`👤 [ORDERS] Comprador: ${buyer.nombreCompleto} (${buyer.numeroControl})`);

            // Crear el pedido
            const [orderResult] = await db.query(
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
                [req.userId, total, paymentMethod, shippingAddress || 'Entrega en ITESCO']
            );

            const orderId = orderResult.insertId;
            console.log(`✅ [ORDERS] Pedido creado ID: ${orderId}`);
            
            // Crear sesión de tracking
            await db.query(
                `INSERT INTO tracking_sessions (orderId, status, createdAt)
                 VALUES (?, 'pending', NOW())`,
                [orderId]
            );
            
            // Insertar items del pedido
            const orderItems = items.map(item => [
                orderId, 
                parseInt(item.productId), 
                item.name, 
                item.quantity, 
                item.price, 
                item.imageUrl || null
            ]);

            await db.query(
                'INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?',
                [orderItems]
            );
            console.log(`✅ [ORDERS] ${orderItems.length} items insertados`);

            // Actualizar stock
            for (const item of items) {
                await db.query(
                    'UPDATE products SET stock = stock - ?, updatedAt = NOW() WHERE id = ?',
                    [item.quantity, item.productId]
                );
                console.log(`📦 [ORDERS] Stock actualizado para producto ${item.productId}: -${item.quantity}`);
            }

            // Vaciar carrito del comprador
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
            console.log(`🗑️ [ORDERS] Carrito vaciado para usuario ${req.userId}`);

            // ========== ENVIAR NOTIFICACIONES ==========
            
            // Agrupar items por vendedor
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
            
            // Notificar a cada vendedor
            for (const [sellerId, sellerData] of sellerMap) {
                const itemsList = sellerData.items.map(item => 
                    `• ${item.quantity}x ${item.name} - $${item.subtotal.toFixed(2)}`
                ).join('\n');
                
                const notificationBody = `🆕 NUEVO PEDIDO #${orderId}\n\n` +
                    `👤 Cliente: ${buyer.nombreCompleto}\n` +
                    `🆔 Control: ${buyer.numeroControl}\n` +
                    `📧 Email: ${buyer.email || 'No especificado'}\n` +
                    `📞 Teléfono: ${buyer.telefono || 'No especificado'}\n\n` +
                    `📦 Productos:\n${itemsList}\n\n` +
                    `💰 Total: $${sellerData.totalAmount.toFixed(2)}\n` +
                    `💳 Pago: ${paymentMethod}\n` +
                    `📍 Entrega: ${shippingAddress || 'Entrega en ITESCO'}`;
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [sellerId, 
                     `🛒 NUEVO PEDIDO #${orderId}`, 
                     notificationBody]
                );
                
                console.log(`📧 [ORDERS] Notificación enviada al vendedor ${sellerData.sellerName} (ID: ${sellerId})`);
            }
            
            // Notificar al comprador
            const buyerNotificationBody = `✅ Pedido #${orderId} confirmado\n\n` +
                `📅 Fecha: ${new Date().toLocaleString()}\n` +
                `💰 Total: $${total.toFixed(2)}\n` +
                `💳 Método de pago: ${paymentMethod}\n` +
                `📍 Entrega: ${shippingAddress || 'Entrega en ITESCO'}\n\n` +
                `Los vendedores han sido notificados y prepararán tu pedido.`;
            
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                [req.userId,
                 `✅ Pedido #${orderId} confirmado`,
                 buyerNotificationBody]
            );
            
            console.log(`📧 [ORDERS] Notificación enviada al comprador ${buyer.nombreCompleto}`);

            // Respuesta exitosa
            res.status(201).json({ 
                success: true,
                id: orderId, 
                message: 'Pedido creado exitosamente',
                paymentMethod: paymentMethod,
                total: total
            });

        } catch (error) {
            console.error('❌ [ORDERS] Error creando pedido:', error);
            res.status(500).json({ 
                success: false,
                message: 'Error al crear pedido: ' + error.message 
            });
        }
    });

    // GET /api/orders - Obtener pedidos del usuario
    router.get('/', authenticateToken, async (req, res) => {
        const { status } = req.query;
        let query = 'SELECT * FROM orders WHERE userId = ?';
        const params = [req.userId];
        
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        
        try {
            const [orders] = await db.query(query + ' ORDER BY createdAt DESC', params);
            
            for (const order of orders) {
                const [items] = await db.query(
                    'SELECT * FROM order_items WHERE orderId = ?',
                    [order.id]
                );
                order.items = items;
            }
            
            res.json(orders);
        } catch (error) {
            console.error('Error obteniendo pedidos:', error);
            res.status(500).json({ message: 'Error al obtener pedidos' });
        }
    });

    // GET /api/orders/seller/sales - Ventas del vendedor
    router.get('/seller/sales', authenticateToken, isSeller, async (req, res) => {
        try {
            console.log(`📊 [SALES] Obteniendo ventas para vendedor ${req.userId}`);
            
            const [sales] = await db.query(
                `SELECT 
                    o.id, 
                    o.userId, 
                    o.total, 
                    o.paymentMethod, 
                    o.status, 
                    o.createdAt,
                    o.shippingAddress,
                    u.nombreCompleto as buyerName, 
                    u.numeroControl as buyerControl,
                    u.email as buyerEmail,
                    u.telefono as buyerPhone
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 JOIN users u ON o.userId = u.id
                 WHERE p.sellerId = ?
                 GROUP BY o.id
                 ORDER BY o.createdAt DESC`,
                [req.userId]
            );
            
            console.log(`📊 [SALES] Encontradas ${sales.length} órdenes`);
            
            // Obtener items para cada orden
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
            
            const totalSales = sales.reduce((sum, s) => sum + parseFloat(s.total), 0);
            const totalOrders = sales.length;
            
            res.json({ 
                sales, 
                totalSales, 
                totalOrders,
                pendingOrders: sales.filter(s => s.status === 'pending').length,
                processingOrders: sales.filter(s => s.status === 'processing').length,
                shippedOrders: sales.filter(s => s.status === 'shipped').length,
                deliveredOrders: sales.filter(s => s.status === 'delivered').length
            });
            
        } catch (error) {
            console.error('❌ [SALES] Error:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    // PATCH /api/orders/:orderId/status - Actualizar estado
    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const orderId = req.params.orderId;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado inválido' });
        }

        try {
            // Verificar permisos
            const [orderCheck] = await db.query(
                `SELECT o.userId as buyerId, o.total, o.paymentMethod
                 FROM orders o
                 WHERE o.id = ?`,
                [orderId]
            );
            
            if (orderCheck.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            // Verificar si el usuario es vendedor de algún producto del pedido
            const [sellerCheck] = await db.query(
                `SELECT DISTINCT p.sellerId
                 FROM order_items oi
                 JOIN products p ON oi.productId = p.id
                 WHERE oi.orderId = ? AND p.sellerId = ?`,
                [orderId, req.userId]
            );
            
            const isAuthorized = req.userRole === 'Administrador' || sellerCheck.length > 0;
            
            if (!isAuthorized) {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            
            await db.query(
                'UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?',
                [status, orderId]
            );
            
            // Notificar al comprador
            const statusMessages = {
                'processing': {
                    title: '🔄 Pedido en proceso',
                    body: `Tu pedido #${orderId} está siendo preparado.\nTotal: $${parseFloat(orderCheck[0].total).toFixed(2)}\nPago: ${orderCheck[0].paymentMethod || 'Efectivo'}`
                },
                'shipped': {
                    title: '📦 Pedido enviado',
                    body: `¡Buenas noticias! Tu pedido #${orderId} ha sido enviado.\nPronto recibirás tu pedido.`
                },
                'delivered': {
                    title: '✅ Pedido entregado',
                    body: `Tu pedido #${orderId} ha sido entregado.\n¡Disfruta tus productos!`
                },
                'cancelled': {
                    title: '❌ Pedido cancelado',
                    body: `Tu pedido #${orderId} ha sido cancelado.\nContacta al vendedor para más información.`
                }
            };
            
            if (statusMessages[status]) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [orderCheck[0].buyerId, 
                     statusMessages[status].title, 
                     statusMessages[status].body]
                );
                console.log(`📧 Notificación enviada al comprador: ${statusMessages[status].title}`);
            }
            
            res.json({ success: true, message: 'Estado actualizado correctamente' });
            
        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    return router;
};