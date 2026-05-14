const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/cart - Obtener carrito del usuario
    router.get('/', authenticateToken, async (req, res) => {
        try {
            console.log(`🛒 [Cart] Obteniendo carrito de usuario ${req.userId}`);
            
            const [items] = await db.query(
                `SELECT ci.*, p.name, p.price, p.images, p.stock, p.sellerId, p.sellerName, p.isAvailable
                 FROM cart_items ci 
                 JOIN products p ON ci.productId = p.id 
                 WHERE ci.userId = ? AND p.isAvailable = TRUE AND p.status = 'approved'`,
                [req.userId]
            );
            
            const cartItems = items.map(item => ({
                productId: item.productId.toString(),
                name: item.name,
                price: parseFloat(item.price),
                quantity: item.quantity,
                imageUrl: item.images ? (JSON.parse(item.images)[0] || null) : null,
                sellerId: item.sellerId.toString(),
                sellerName: item.sellerName,
                addedAt: item.addedAt,
                stock: item.stock,
                isAvailable: item.isAvailable === 1
            }));
            
            console.log(`✅ [Cart] Carrito obtenido: ${cartItems.length} items`);
            res.json({ items: cartItems });
        } catch (error) {
            console.error('❌ Error obteniendo carrito:', error);
            res.status(500).json({ message: 'Error al obtener carrito' });
        }
    });

    // POST /api/cart/add - Agregar item al carrito
    router.post('/add', authenticateToken, async (req, res) => {
        const { productId, quantity = 1 } = req.body;
        
        console.log(`🛒 [Cart] Agregando producto ${productId} x${quantity} para usuario ${req.userId}`);
        
        if (!productId) {
            return res.status(400).json({ message: 'Producto no especificado' });
        }
        
        try {
            const [products] = await db.query(
                'SELECT id, stock, isAvailable, status FROM products WHERE id = ?',
                [productId]
            );
            
            if (products.length === 0) {
                return res.status(404).json({ message: 'Producto no encontrado' });
            }
            
            const product = products[0];
            
            if (product.status !== 'approved') {
                return res.status(400).json({ message: 'Producto no disponible' });
            }
            
            if (product.isAvailable !== 1) {
                return res.status(400).json({ message: 'Producto agotado' });
            }
            
            if (product.stock < quantity) {
                return res.status(400).json({ message: `Stock insuficiente. Disponible: ${product.stock}` });
            }
            
            const [existing] = await db.query(
                'SELECT id, quantity FROM cart_items WHERE userId = ? AND productId = ?',
                [req.userId, productId]
            );
            
            if (existing.length > 0) {
                const newQuantity = existing[0].quantity + quantity;
                await db.query(
                    'UPDATE cart_items SET quantity = ?, addedAt = NOW() WHERE id = ?',
                    [newQuantity, existing[0].id]
                );
                console.log(`✅ [Cart] Cantidad actualizada a ${newQuantity}`);
            } else {
                await db.query(
                    'INSERT INTO cart_items (userId, productId, quantity, addedAt) VALUES (?, ?, ?, NOW())',
                    [req.userId, productId, quantity]
                );
                console.log(`✅ [Cart] Producto agregado al carrito`);
            }
            
            const [updatedItems] = await db.query(
                `SELECT ci.*, p.name, p.price, p.images, p.sellerId, p.sellerName
                 FROM cart_items ci 
                 JOIN products p ON ci.productId = p.id 
                 WHERE ci.userId = ?`,
                [req.userId]
            );
            
            res.json({ 
                success: true, 
                message: 'Producto agregado al carrito',
                items: updatedItems 
            });
            
        } catch (error) {
            console.error('❌ Error agregando al carrito:', error);
            res.status(500).json({ message: 'Error al agregar al carrito' });
        }
    });

    // PUT /api/cart/:productId - Actualizar cantidad
    router.put('/:productId', authenticateToken, async (req, res) => {
        const { quantity } = req.body;
        const productId = req.params.productId;
        
        console.log(`🛒 [Cart] Actualizando producto ${productId} a cantidad ${quantity} para usuario ${req.userId}`);
        
        if (quantity === undefined) {
            return res.status(400).json({ message: 'Cantidad no especificada' });
        }
        
        try {
            if (quantity <= 0) {
                await db.query(
                    'DELETE FROM cart_items WHERE userId = ? AND productId = ?',
                    [req.userId, productId]
                );
                console.log(`✅ [Cart] Producto eliminado del carrito`);
                res.json({ success: true, message: 'Producto eliminado del carrito', removed: true });
            } else {
                const [products] = await db.query(
                    'SELECT stock FROM products WHERE id = ?',
                    [productId]
                );
                
                if (products.length > 0 && products[0].stock < quantity) {
                    return res.status(400).json({ message: `Stock insuficiente. Disponible: ${products[0].stock}` });
                }
                
                await db.query(
                    `INSERT INTO cart_items (userId, productId, quantity, addedAt) 
                     VALUES (?, ?, ?, NOW()) 
                     ON DUPLICATE KEY UPDATE quantity = ?, addedAt = NOW()`,
                    [req.userId, productId, quantity, quantity]
                );
                console.log(`✅ [Cart] Cantidad actualizada a ${quantity}`);
                res.json({ success: true, message: 'Carrito actualizado', updated: true });
            }
        } catch (error) {
            console.error('❌ Error actualizando carrito:', error);
            res.status(500).json({ message: 'Error al actualizar carrito' });
        }
    });

    // DELETE /api/cart/:productId - Eliminar item específico
    router.delete('/:productId', authenticateToken, async (req, res) => {
        const productId = req.params.productId;
        
        console.log(`🛒 [Cart] Eliminando producto ${productId} del carrito de usuario ${req.userId}`);
        
        try {
            const [result] = await db.query(
                'DELETE FROM cart_items WHERE userId = ? AND productId = ?',
                [req.userId, productId]
            );
            
            if (result.affectedRows > 0) {
                console.log(`✅ [Cart] Producto eliminado`);
                res.json({ success: true, message: 'Producto eliminado del carrito' });
            } else {
                res.status(404).json({ message: 'Producto no encontrado en el carrito' });
            }
        } catch (error) {
            console.error('❌ Error eliminando item:', error);
            res.status(500).json({ message: 'Error al eliminar producto' });
        }
    });

    // DELETE /api/cart - Vaciar carrito completo
    router.delete('/', authenticateToken, async (req, res) => {
        console.log(`🛒 [Cart] Vaciando carrito completo de usuario ${req.userId}`);
        
        try {
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
            console.log(`✅ [Cart] Carrito vaciado`);
            res.json({ success: true, message: 'Carrito vaciado' });
        } catch (error) {
            console.error('❌ Error vaciando carrito:', error);
            res.status(500).json({ message: 'Error al vaciar carrito' });
        }
    });

    // POST /api/cart/sync - Sincronizar carrito completo
    router.post('/sync', authenticateToken, async (req, res) => {
        const { items } = req.body;
        
        console.log(`🛒 [Cart] Sincronizando carrito de usuario ${req.userId} con ${items?.length || 0} items`);
        
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ message: 'Datos inválidos' });
        }
        
        try {
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
            
            for (const item of items) {
                if (item.quantity > 0) {
                    await db.query(
                        'INSERT INTO cart_items (userId, productId, quantity, addedAt) VALUES (?, ?, ?, NOW())',
                        [req.userId, item.productId, item.quantity]
                    );
                }
            }
            
            console.log(`✅ [Cart] Carrito sincronizado`);
            res.json({ success: true, message: 'Carrito sincronizado' });
        } catch (error) {
            console.error('❌ Error sincronizando carrito:', error);
            res.status(500).json({ message: 'Error al sincronizar carrito' });
        }
    });

    return router;
};