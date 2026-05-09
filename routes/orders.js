const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/orders - Crear pedido
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        console.log('=== NUEVO PEDIDO ===');
        console.log('Usuario:', req.userId);
        
        const { items, total, paymentMethod, shippingAddress } = req.body;

        // VALIDACIONES BASICAS
        if (!items || !Array.isArray(items) || items.length === 0) {
            console.log('Error: Carrito vacio');
            return res.status(400).json({ 
                success: false,
                message: 'El carrito esta vacio'
            });
        }

        if (!total || total <= 0) {
            console.log('Error: Total invalido');
            return res.status(400).json({ 
                success: false,
                message: 'Total invalido'
            });
        }

        const validPaymentMethods = ['Efectivo', 'Tarjeta'];
        if (!paymentMethod || !validPaymentMethods.includes(paymentMethod)) {
            console.log('Error: Metodo de pago invalido');
            return res.status(400).json({ 
                success: false,
                message: 'Metodo de pago invalido'
            });
        }

        try {
            // VERIFICAR STOCK Y OBTENER INFO DE PRODUCTOS
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                console.log('Verificando producto:', item.name);
                
                if (!item.productId || !item.name || !item.price || !item.quantity) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'Datos incompletos para el producto'
                    });
                }

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
                        message: 'Producto no esta aprobado: ' + product.name
                    });
                }
                
                if (product.isAvailable !== 1) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'Producto no esta disponible: ' + product.name
                    });
                }
                
                if (product.stock < item.quantity) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'Stock insuficiente para: ' + product.name + '. Disponible: ' + product.stock
                    });
                }
                
                // Guardar info del vendedor
                item.sellerId = product.sellerId;
                item.sellerName = product.sellerName;
            }

            // OBTENER INFO DEL COMPRADOR
            const [buyerInfo] = await db.query(
                'SELECT nombreCompleto, numeroControl FROM users WHERE id = ?',
                [req.userId]
            );
            
            if (buyerInfo.length === 0) {
                return res.status(404).json({ 
                    success: false,
                    message: 'Comprador no encontrado'
                });
            }
            
            const buyer = buyerInfo[0];
            console.log('Comprador:', buyer.nombreCompleto);

            // CREAR EL PEDIDO
            const [orderResult] = await db.query(
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
                [req.userId, total, paymentMethod, shippingAddress || 'Entrega en ITESCO']
            );

            const orderId = orderResult.insertId;
            console.log('Pedido creado ID:', orderId);

            // INSERTAR ITEMS DEL PEDIDO - SIN imageUrl para evitar error
            for (const item of items) {
                await db.query(
                    `INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl)
                     VALUES (?, ?, ?, ?, ?, NULL)`,
                    [orderId, item.productId, item.name, item.quantity, item.price]
                );
                console.log('Item agregado:', item.quantity, 'x', item.name);
            }

            // ACTUALIZAR STOCK
            for (const item of items) {
                await db.query(
                    'UPDATE products SET stock = stock - ? WHERE id = ?',
                    [item.quantity, item.productId]
                );
            }

            // VACIAR CARRITO DEL COMPRADOR
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
            console.log('Carrito vaciado');

            // NOTIFICAR A VENDEDORES
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
                let itemsList = '';
                for (const item of sellerData.items) {
                    itemsList += item.quantity + 'x ' + item.name + ' - $' + item.subtotal.toFixed(2) + '\n';
                }
                
                const notificationBody = 'NUEVO PEDIDO #' + orderId + '\n\n' +
                    'Cliente: ' + buyer.nombreCompleto + '\n' +
                    'Control: ' + buyer.numeroControl + '\n\n' +
                    'Productos:\n' + itemsList + '\n' +
                    'Total: $' + sellerData.totalAmount.toFixed(2) + '\n' +
                    'Pago: ' + paymentMethod;
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [sellerId, 'NUEVO PEDIDO #' + orderId, notificationBody]
                );
                
                console.log('Notificacion enviada al vendedor:', sellerData.sellerName);
            }

            // NOTIFICAR AL COMPRADOR
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                [req.userId,
                 'Pedido #' + orderId + ' confirmado',
                 'Tu pedido ha sido creado exitosamente.\nTotal: $' + total.toFixed(2) + '\nPago: ' + paymentMethod]
            );

            console.log('Pedido completado exitosamente');
            
            // RESPUESTA EXITOSA
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
            console.error('Error obteniendo pedidos:', error);
            res.status(500).json({ message: 'Error al obtener pedidos' });
        }
    });

    // GET /api/orders/:orderId - Obtener detalle
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
            res.status(500).json({ message: 'Error al obtener detalle' });
        }
    });

    // GET /api/orders/seller/sales - Ventas del vendedor
    router.get('/seller/sales', authenticateToken, isSeller, async (req, res) => {
        try {
            console.log('Obteniendo ventas para vendedor:', req.userId);
            
            const [sales] = await db.query(
                `SELECT DISTINCT 
                    o.id, 
                    o.userId, 
                    o.total, 
                    o.paymentMethod, 
                    o.status, 
                    o.createdAt,
                    o.shippingAddress,
                    u.nombreCompleto as buyerName, 
                    u.numeroControl as buyerControl
                 FROM orders o
                 JOIN order_items oi ON o.id = oi.orderId
                 JOIN products p ON oi.productId = p.id
                 JOIN users u ON o.userId = u.id
                 WHERE p.sellerId = ?
                 ORDER BY o.createdAt DESC`,
                [req.userId]
            );
            
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
            
            let totalSales = 0;
            for (const sale of sales) {
                totalSales = totalSales + parseFloat(sale.total);
            }
            
            res.json({ 
                sales: sales, 
                totalSales: totalSales, 
                totalOrders: sales.length 
            });
            
        } catch (error) {
            console.error('Error obteniendo ventas:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    // PATCH /api/orders/:orderId/status - Actualizar estado
    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const orderId = req.params.orderId;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado invalido' });
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
            
            // Verificar si el usuario es vendedor
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
            let statusTitle = '';
            let statusBody = '';
            
            if (status === 'processing') {
                statusTitle = 'Pedido en proceso';
                statusBody = 'Tu pedido #' + orderId + ' esta siendo preparado.';
            } else if (status === 'shipped') {
                statusTitle = 'Pedido enviado';
                statusBody = 'Tu pedido #' + orderId + ' ha sido enviado.';
            } else if (status === 'delivered') {
                statusTitle = 'Pedido entregado';
                statusBody = 'Tu pedido #' + orderId + ' ha sido entregado.';
            } else if (status === 'cancelled') {
                statusTitle = 'Pedido cancelado';
                statusBody = 'Tu pedido #' + orderId + ' ha sido cancelado.';
            }
            
            if (statusTitle !== '') {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [orderCheck[0].buyerId, statusTitle, statusBody]
                );
                console.log('Notificacion enviada al comprador:', statusTitle);
            }
            
            res.json({ success: true, message: 'Estado actualizado correctamente' });
            
        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    return router;
};