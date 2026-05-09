const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/orders - Crear pedido
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        const { items, total, paymentMethod, shippingAddress } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'El carrito está vacío' });
        }

        // Validar método de pago
        const validPaymentMethods = ['Efectivo', 'Tarjeta'];
        if (!validPaymentMethods.includes(paymentMethod)) {
            return res.status(400).json({ message: 'Método de pago inválido' });
        }

        try {
            // Verificar stock de cada producto
            for (const item of items) {
                const [products] = await db.query(
                    'SELECT stock, name, sellerId, sellerName FROM products WHERE id = ? AND status = "approved" AND isAvailable = TRUE',
                    [item.productId]
                );
                
                if (products.length === 0) {
                    return res.status(400).json({ 
                        message: `El producto "${item.name}" no está disponible` 
                    });
                }
                
                if (products[0].stock < item.quantity) {
                    return res.status(400).json({ 
                        message: `Stock insuficiente para "${products[0].name}". Disponible: ${products[0].stock}` 
                    });
                }
                
                // Guardar información del vendedor
                item.sellerId = products[0].sellerId;
                item.sellerName = products[0].sellerName;
            }

            // Crear el pedido
            const [orderResult] = await db.query(
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
                [req.userId, total, paymentMethod, shippingAddress || 'Entrega en ITESCO']
            );

            const orderId = orderResult.insertId;
            
            // Crear sesión de tracking
            await db.query(
                `INSERT INTO tracking_sessions (orderId, status, createdAt)
                 VALUES (?, 'pending', NOW())`,
                [orderId]
            );
            
            // Insertar items del pedido
            const orderItems = items.map(item => [
                orderId, item.productId, item.name, item.quantity, item.price, item.imageUrl || null
            ]);

            await db.query(
                'INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?',
                [orderItems]
            );

            // Actualizar stock
            for (const item of items) {
                await db.query(
                    'UPDATE products SET stock = stock - ? WHERE id = ?',
                    [item.quantity, item.productId]
                );
            }

            // Vaciar carrito del comprador
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);

            // ========== NOTIFICACIONES ==========
            
            // 1. Notificar a CADA VENDEDOR por separado
            const sellerMap = new Map(); // Agrupar items por vendedor
            
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
            
            // Enviar notificación a cada vendedor
            for (const [sellerId, sellerData] of sellerMap) {
                // Obtener información del comprador
                const [buyerInfo] = await db.query(
                    'SELECT nombreCompleto, numeroControl FROM users WHERE id = ?',
                    [req.userId]
                );
                
                const buyerName = buyerInfo[0]?.nombreCompleto || 'Cliente';
                const buyerControl = buyerInfo[0]?.numeroControl || '';
                
                // Crear mensaje detallado
                let itemsList = '';
                for (const item of sellerData.items) {
                    itemsList += `\n• ${item.quantity}x ${item.name} - $${item.subtotal.toFixed(2)}`;
                }
                
                const notificationBody = `Nuevo pedido #${orderId} de ${buyerName} (${buyerControl})\nTotal: $${sellerData.totalAmount.toFixed(2)}\nProductos:${itemsList}\nMétodo de pago: ${paymentMethod}\nEntrega: ${shippingAddress || 'Entrega en ITESCO'}`;
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [sellerId, 
                     `🛒 Nuevo pedido #${orderId}`, 
                     notificationBody]
                );
                
                console.log(`📧 Notificación enviada al vendedor ${sellerData.sellerName} (ID: ${sellerId})`);
            }
            
            // 2. Notificar al comprador que su pedido fue creado
            const [buyerInfo] = await db.query(
                'SELECT nombreCompleto FROM users WHERE id = ?',
                [req.userId]
            );
            
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                [req.userId,
                 `✅ Pedido #${orderId} confirmado`,
                 `Tu pedido ha sido creado exitosamente. Total: $${total.toFixed(2)}\nMétodo de pago: ${paymentMethod}\nLos vendedores han sido notificados.`]
            );

            res.status(201).json({ 
                id: orderId, 
                message: 'Pedido creado exitosamente',
                paymentMethod: paymentMethod,
                total: total
            });

        } catch (error) {
            console.error('Error creando pedido:', error);
            res.status(500).json({ message: 'Error al crear pedido' });
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
            const [orders] = await db.query(query, params);
            
            for (const order of orders) {
                const [items] = await db.query(
                    'SELECT * FROM order_items WHERE orderId = ?',
                    [order.id]
                );
                order.items = items;
            }
            
            orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            
            res.json(orders);
        } catch (error) {
            console.error('Error obteniendo pedidos:', error);
            res.status(500).json({ message: 'Error al obtener pedidos' });
        }
    });

    // GET /api/orders/:orderId - Obtener detalle de pedido
    router.get('/:orderId', authenticateToken, async (req, res) => {
        try {
            const [orders] = await db.query(
                'SELECT * FROM orders WHERE id = ? AND userId = ?',
                [req.params.orderId, req.userId]
            );
            
            if (orders.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            const [items] = await db.query(
                'SELECT * FROM order_items WHERE orderId = ?',
                [req.params.orderId]
            );
            
            orders[0].items = items;
            res.json(orders[0]);
        } catch (error) {
            console.error('Error obteniendo detalle:', error);
            res.status(500).json({ message: 'Error al obtener detalle del pedido' });
        }
    });

    // PATCH /api/orders/:orderId/status - Actualizar estado
    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado inválido' });
        }

        try {
            const [orderCheck] = await db.query(
                `SELECT o.userId, oi.productId, o.userId as buyerId, o.total, o.paymentMethod
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 WHERE o.id = ?`,
                [req.params.orderId]
            );

            if (orderCheck.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }

            const [product] = await db.query(
                'SELECT sellerId FROM products WHERE id = ?',
                [orderCheck[0].productId]
            );

            const isAuthorized = req.userRole === 'Administrador' || 
                                 (req.userRole === 'Vendedor' && product[0]?.sellerId === req.userId);

            if (!isAuthorized) {
                return res.status(403).json({ message: 'No tienes permiso para actualizar este pedido' });
            }

            await db.query(
                'UPDATE orders SET status = ?, updatedAt = NOW() WHERE id = ?',
                [status, req.params.orderId]
            );

            // Notificaciones de cambio de estado
            const statusMessages = {
                'processing': {
                    title: '🔄 Pedido en proceso',
                    body: `Tu pedido #${req.params.orderId} está siendo preparado. Total: $${orderCheck[0]?.total?.toFixed(2) || '0'}\nPago: ${orderCheck[0]?.paymentMethod || 'Efectivo'}`
                },
                'shipped': {
                    title: '📦 Pedido enviado',
                    body: `¡Buenas noticias! Tu pedido #${req.params.orderId} ha sido enviado. Pronto recibirás tu pedido.`
                },
                'delivered': {
                    title: '✅ Pedido entregado',
                    body: `Tu pedido #${req.params.orderId} ha sido entregado. ¡Disfruta tus productos! No olvides calificar tu experiencia.`
                },
                'cancelled': {
                    title: '❌ Pedido cancelado',
                    body: `Tu pedido #${req.params.orderId} ha sido cancelado. Si tienes dudas, contacta al vendedor.`
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
            }

            res.json({ message: 'Estado actualizado correctamente' });

        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    // GET /api/orders/seller/sales - Ventas del vendedor
    router.get('/seller/sales', authenticateToken, isSeller, async (req, res) => {
        try {
            const [sales] = await db.query(
                `SELECT o.*, oi.productName, oi.quantity, oi.price, oi.imageUrl, u.nombreCompleto as buyerName, u.numeroControl as buyerControl
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 JOIN users u ON o.userId = u.id
                 WHERE p.sellerId = ?`,
                [req.userId]
            );
            
            sales.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            
            const totalSales = sales.reduce((sum, s) => sum + (parseFloat(s.price) * s.quantity), 0);
            const totalOrders = [...new Set(sales.map(s => s.id))].length;
            const pendingOrders = sales.filter(s => s.status === 'pending').length;
            const processingOrders = sales.filter(s => s.status === 'processing').length;
            const shippedOrders = sales.filter(s => s.status === 'shipped').length;
            const deliveredOrders = sales.filter(s => s.status === 'delivered').length;
            
            // Agrupar órdenes únicas
            const uniqueOrders = [];
            const orderMap = new Map();
            
            for (const sale of sales) {
                if (!orderMap.has(sale.id)) {
                    orderMap.set(sale.id, {
                        id: sale.id,
                        userId: sale.userId,
                        total: sale.total,
                        paymentMethod: sale.paymentMethod,
                        status: sale.status,
                        createdAt: sale.createdAt,
                        buyerName: sale.buyerName,
                        buyerControl: sale.buyerControl,
                        items: []
                    });
                }
                orderMap.get(sale.id).items.push({
                    productName: sale.productName,
                    quantity: sale.quantity,
                    price: sale.price,
                    imageUrl: sale.imageUrl
                });
            }
            
            res.json({ 
                sales: Array.from(orderMap.values()),
                totalSales, 
                totalOrders,
                pendingOrders,
                processingOrders,
                shippedOrders,
                deliveredOrders
            });
        } catch (error) {
            console.error('Error obteniendo ventas:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    return router;
};