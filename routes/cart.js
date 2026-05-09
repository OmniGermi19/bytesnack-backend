const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/cart - Obtener carrito del usuario
    router.get('/', authenticateToken, async (req, res) => {
        try {
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
            
            res.json({ items: cartItems });
        } catch (error) {
            console.error('Error obteniendo carrito:', error);
            res.status(500).json({ message: 'Error al obtener carrito' });
        }
    });

    // POST /api/cart/add - Agregar item al carrito
    router.post('/add', authenticateToken, async (req, res) => {
        const { productId, quantity = 1 } = req.body;
        
        if (!productId) {
            return res.status(400).json({ message: 'Producto no especificado' });
        }
        
        try {
            // Verificar que el producto existe y está disponible
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
                return res.status(400).json({ message: 'Stock insuficiente' });
            }
            
            // Verificar si ya existe en el carrito
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
            } else {
                await db.query(
                    'INSERT INTO cart_items (userId, productId, quantity, addedAt) VALUES (?, ?, ?, NOW())',
                    [req.userId, productId, quantity]
                );
            }
            
            // Obtener carrito actualizado
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
            console.error('Error agregando al carrito:', error);
            res.status(500).json({ message: 'Error al agregar al carrito' });
        }
    });

    // PUT /api/cart/:productId - Actualizar cantidad
    router.put('/:productId', authenticateToken, async (req, res) => {
        const { quantity } = req.body;
        const productId = req.params.productId;
        
        if (quantity === undefined) {
            return res.status(400).json({ message: 'Cantidad no especificada' });
        }
        
        try {
            if (quantity <= 0) {
                // Eliminar del carrito
                await db.query(
                    'DELETE FROM cart_items WHERE userId = ? AND productId = ?',
                    [req.userId, productId]
                );
                res.json({ success: true, message: 'Producto eliminado del carrito', removed: true });
            } else {
                // Verificar stock
                const [products] = await db.query(
                    'SELECT stock FROM products WHERE id = ?',
                    [productId]
                );
                
                if (products.length > 0 && products[0].stock < quantity) {
                    return res.status(400).json({ message: 'Stock insuficiente' });
                }
                
                await db.query(
                    `INSERT INTO cart_items (userId, productId, quantity, addedAt) 
                     VALUES (?, ?, ?, NOW()) 
                     ON DUPLICATE KEY UPDATE quantity = ?, addedAt = NOW()`,
                    [req.userId, productId, quantity, quantity]
                );
                res.json({ success: true, message: 'Carrito actualizado', updated: true });
            }
        } catch (error) {
            console.error('Error actualizando carrito:', error);
            res.status(500).json({ message: 'Error al actualizar carrito' });
        }
    });

    // DELETE /api/cart/:productId - Eliminar item específico
    router.delete('/:productId', authenticateToken, async (req, res) => {
        const productId = req.params.productId;
        
        try {
            const [result] = await db.query(
                'DELETE FROM cart_items WHERE userId = ? AND productId = ?',
                [req.userId, productId]
            );
            
            if (result.affectedRows > 0) {
                res.json({ success: true, message: 'Producto eliminado del carrito' });
            } else {
                res.status(404).json({ message: 'Producto no encontrado en el carrito' });
            }
        } catch (error) {
            console.error('Error eliminando item:', error);
            res.status(500).json({ message: 'Error al eliminar producto' });
        }
    });

    // DELETE /api/cart - Vaciar carrito completo
    router.delete('/', authenticateToken, async (req, res) => {
        try {
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
            res.json({ success: true, message: 'Carrito vaciado' });
        } catch (error) {
            console.error('Error vaciando carrito:', error);
            res.status(500).json({ message: 'Error al vaciar carrito' });
        }
    });

    // POST /api/cart/sync - Sincronizar carrito completo (para múltiples items)
    router.post('/sync', authenticateToken, async (req, res) => {
        const { items } = req.body;
        
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ message: 'Datos inválidos' });
        }
        
        try {
            // Primero vaciar carrito actual
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
            
            // Insertar nuevos items
            for (const item of items) {
                if (item.quantity > 0) {
                    await db.query(
                        'INSERT INTO cart_items (userId, productId, quantity, addedAt) VALUES (?, ?, ?, NOW())',
                        [req.userId, item.productId, item.quantity]
                    );
                }
            }
            
            res.json({ success: true, message: 'Carrito sincronizado' });
        } catch (error) {
            console.error('Error sincronizando carrito:', error);
            res.status(500).json({ message: 'Error al sincronizar carrito' });
        }
    });

    return router;
};