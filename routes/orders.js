const express = require('express');
const { authenticateToken, isBuyer, isSeller } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

<<<<<<< HEAD
=======
    // ========== FUNCIÓN PARA GENERAR CÓDIGO DE SEGUIMIENTO ==========
    function generateTrackingCode() {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        return `BS-${year}${month}${day}-${random}`;
    }

    // ========== CREAR PEDIDO ==========
>>>>>>> 126d5db223a055c833249b7d7f03cd19563f953e
    router.post('/', authenticateToken, isBuyer, async (req, res) => {
        const { items, total, paymentMethod, shippingAddress } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'El carrito está vacío' });
        }

        try {
            // Verificar stock
            for (const item of items) {
                const [products] = await db.query(
                    'SELECT stock, name FROM products WHERE id = ? AND status = "approved" AND isAvailable = TRUE',
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
            }

            // Generar código de seguimiento único
            let trackingCode;
            let isUnique = false;
            while (!isUnique) {
                trackingCode = generateTrackingCode();
                const [existing] = await db.query(
                    'SELECT id FROM orders WHERE tracking_code = ?',
                    [trackingCode]
                );
                if (existing.length === 0) isUnique = true;
            }

            // Insertar pedido con código de seguimiento
            const [orderResult] = await db.query(
                `INSERT INTO orders (userId, total, paymentMethod, shippingAddress, status, tracking_code, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, 'pending', ?, NOW(), NOW())`,
                [req.userId, total, paymentMethod, shippingAddress || 'Entrega en ITESCO', trackingCode]
            );

            const orderId = orderResult.insertId;
            
            await db.query(
                `INSERT INTO tracking_sessions (orderId, status, createdAt)
                 VALUES (?, 'pending', NOW())`,
                [orderId]
            );
            
            const orderItems = items.map(item => [
                orderId, item.productId, item.name, item.quantity, item.price, item.imageUrl || null
            ]);

            await db.query(
                'INSERT INTO order_items (orderId, productId, productName, quantity, price, imageUrl) VALUES ?',
                [orderItems]
            );

            for (const item of items) {
                await db.query(
                    'UPDATE products SET stock = stock - ? WHERE id = ?',
                    [item.quantity, item.productId]
                );
            }

            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);

            for (const item of items) {
                const [products] = await db.query('SELECT sellerId, sellerName FROM products WHERE id = ?', [item.productId]);
                if (products.length > 0) {
                    await db.query(
                        `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                         VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                        [products[0].sellerId, 
                         '📦 Nuevo pedido', 
                         `Has recibido un pedido de ${item.quantity}x ${item.name} por \$${(item.price * item.quantity).toFixed(2)}\nCódigo de seguimiento: ${trackingCode}`]
                    );
                }
            }

            res.status(201).json({ 
                id: orderId, 
                trackingCode: trackingCode,
                message: 'Pedido creado exitosamente' 
            });

        } catch (error) {
            console.error('Error creando pedido:', error);
            res.status(500).json({ message: 'Error al crear pedido' });
        }
    });

<<<<<<< HEAD
=======
    // ========== RASTREAR PEDIDO POR CÓDIGO ==========
    router.get('/track/:trackingCode', authenticateToken, async (req, res) => {
        const { trackingCode } = req.params;
        
        try {
            const [orders] = await db.query(
                `SELECT o.*, u.nombreCompleto as buyerName, u.email as buyerEmail
                 FROM orders o
                 JOIN users u ON o.userId = u.id
                 WHERE o.tracking_code = ?`,
                [trackingCode]
            );
            
            if (orders.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            const order = orders[0];
            const [items] = await db.query(
                'SELECT * FROM order_items WHERE orderId = ?',
                [order.id]
            );
            
            order.items = items;
            
            res.json({ order });
        } catch (error) {
            console.error('Error rastreando pedido:', error);
            res.status(500).json({ message: 'Error al rastrear pedido' });
        }
    });

    // ========== COMPARTIR CÓDIGO DE SEGUIMIENTO ==========
    router.post('/:orderId/share-tracking', authenticateToken, async (req, res) => {
        const { orderId } = req.params;
        const { trackingCode } = req.body;
        
        try {
            const [orders] = await db.query(
                'SELECT userId FROM orders WHERE id = ?',
                [orderId]
            );
            
            if (orders.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado' });
            }
            
            if (orders[0].userId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso' });
            }
            
            res.json({ message: 'Código de seguimiento listo para compartir', trackingCode });
        } catch (error) {
            console.error('Error compartiendo tracking:', error);
            res.status(500).json({ message: 'Error al compartir código' });
        }
    });

    // ========== OBTENER PEDIDOS DEL USUARIO ==========
>>>>>>> 126d5db223a055c833249b7d7f03cd19563f953e
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

<<<<<<< HEAD
=======
    // ========== OBTENER DETALLE DE PEDIDO ==========
>>>>>>> 126d5db223a055c833249b7d7f03cd19563f953e
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

<<<<<<< HEAD
=======
    // ========== ACTUALIZAR ESTADO DEL PEDIDO ==========
>>>>>>> 126d5db223a055c833249b7d7f03cd19563f953e
    router.patch('/:orderId/status', authenticateToken, async (req, res) => {
        const { status } = req.body;
        const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Estado inválido' });
        }

        try {
            const [orderCheck] = await db.query(
                `SELECT o.userId, oi.productId, o.userId as buyerId
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

            const statusMessages = {
                'processing': 'Tu pedido está siendo procesado',
                'shipped': 'Tu pedido ha sido enviado',
                'delivered': 'Tu pedido ha sido entregado. ¡Disfrútalo!',
                'cancelled': 'Tu pedido ha sido cancelado'
            };
            
            if (statusMessages[status]) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'order_update', FALSE, NOW())`,
                    [orderCheck[0].buyerId, 
                     `📦 Pedido #${req.params.orderId}`, 
                     statusMessages[status]]
                );
            }

            res.json({ message: 'Estado actualizado correctamente' });

        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

<<<<<<< HEAD
=======
    // ========== VENTAS DEL VENDEDOR ==========
>>>>>>> 126d5db223a055c833249b7d7f03cd19563f953e
    router.get('/seller/sales', authenticateToken, isSeller, async (req, res) => {
        try {
            const [sales] = await db.query(
                `SELECT o.*, oi.productName, oi.quantity, oi.price, oi.imageUrl, u.nombreCompleto as buyerName,
                        oi.rating, oi.ratingComment, oi.ratedAt
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
            
            res.json({ sales, totalSales, totalOrders });
        } catch (error) {
            console.error('Error obteniendo ventas:', error);
            res.status(500).json({ message: 'Error al obtener ventas' });
        }
    });

    // ========== CALIFICACIÓN DE VENDEDORES ==========
    router.post('/:orderId/rate', authenticateToken, isBuyer, async (req, res) => {
        const { rating, comment } = req.body;
        const orderId = req.params.orderId;
        
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ message: 'La calificación debe ser entre 1 y 5' });
        }
        
        try {
            const [orders] = await db.query(
                'SELECT * FROM orders WHERE id = ? AND userId = ? AND status = "delivered"',
                [orderId, req.userId]
            );
            
            if (orders.length === 0) {
                return res.status(404).json({ message: 'Pedido no encontrado o no entregado' });
            }
            
            const [existingRatings] = await db.query(
                'SELECT id FROM order_items WHERE orderId = ? AND rating IS NOT NULL LIMIT 1',
                [orderId]
            );
            
            if (existingRatings.length === 0) {
                return res.status(400).json({ message: 'Este pedido ya ha sido calificado' });
            }
            
            const [orderItems] = await db.query(
                `SELECT oi.*, p.sellerId, p.sellerName 
                 FROM order_items oi
                 JOIN products p ON oi.productId = p.id
                 WHERE oi.orderId = ? LIMIT 1`,
                [orderId]
            );
            
            if (orderItems.length === 0) {
                return res.status(404).json({ message: 'Producto no encontrado' });
            }
            
            const item = orderItems[0];
            
            await db.query(
                'UPDATE order_items SET rating = ?, ratingComment = ?, ratedAt = NOW() WHERE orderId = ? AND productId = ?',
                [rating, comment || null, orderId, item.productId]
            );
            
            const [ratingsSummary] = await db.query(
                `SELECT AVG(oi.rating) as averageRating, COUNT(oi.rating) as totalRatings
                 FROM order_items oi
                 JOIN products p ON oi.productId = p.id
                 WHERE p.sellerId = ? AND oi.rating IS NOT NULL`,
                [item.sellerId]
            );
            
            const averageRating = parseFloat(ratingsSummary[0]?.averageRating || 0);
            const totalRatings = ratingsSummary[0]?.totalRatings || 0;
            
            await db.query(
                'UPDATE users SET calificacion = ?, totalVentas = ? WHERE id = ?',
                [averageRating, totalRatings, item.sellerId]
            );
            
            const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'rating', FALSE, NOW())`,
                [item.sellerId, 
                 '⭐ Nueva calificación', 
                 `Has recibido una calificación de ${rating}/5 estrellas (${stars}) por "${item.productName}".`]
            );
            
            res.json({ message: 'Calificación enviada correctamente' });
        } catch (error) {
            console.error('Error en rate:', error);
            res.status(500).json({ message: 'Error al enviar calificación' });
        }
    });

    return router;
};