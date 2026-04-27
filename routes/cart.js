const express = require('express');
const { authenticateToken, isBuyer } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/cart - Obtener carrito del usuario
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const [items] = await db.query(
                `SELECT ci.*, p.name, p.price, p.images, p.stock, p.sellerId, p.sellerName
                 FROM cart_items ci 
                 JOIN products p ON ci.productId = p.id 
                 WHERE ci.userId = ?`,
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
                addedAt: item.addedAt
            }));
            
            res.json({ items: cartItems });
        } catch (error) {
            console.error('Error obteniendo carrito:', error);
            res.status(500).json({ message: 'Error al obtener carrito' });
        }
    });

    // PUT /api/cart/:productId - Actualizar cantidad en carrito
    router.put('/:productId', authenticateToken, async (req, res) => {
        const { quantity } = req.body;
        const productId = req.params.productId;
        
        try {
            if (quantity <= 0) {
                await db.query(
                    'DELETE FROM cart_items WHERE userId = ? AND productId = ?',
                    [req.userId, productId]
                );
            } else {
                await db.query(
                    `INSERT INTO cart_items (userId, productId, quantity, addedAt) 
                     VALUES (?, ?, ?, NOW()) 
                     ON DUPLICATE KEY UPDATE quantity = ?`,
                    [req.userId, productId, quantity, quantity]
                );
            }
            
            res.json({ message: 'Carrito actualizado' });
        } catch (error) {
            console.error('Error actualizando carrito:', error);
            res.status(500).json({ message: 'Error al actualizar carrito' });
        }
    });

    // DELETE /api/cart/:productId - Eliminar item del carrito
    router.delete('/:productId', authenticateToken, async (req, res) => {
        try {
            await db.query(
                'DELETE FROM cart_items WHERE userId = ? AND productId = ?',
                [req.userId, req.params.productId]
            );
            res.json({ message: 'Producto eliminado del carrito' });
        } catch (error) {
            console.error('Error eliminando item:', error);
            res.status(500).json({ message: 'Error al eliminar producto' });
        }
    });

    // DELETE /api/cart - Vaciar carrito
    router.delete('/', authenticateToken, async (req, res) => {
        try {
            await db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId]);
            res.json({ message: 'Carrito vaciado' });
        } catch (error) {
            console.error('Error vaciando carrito:', error);
            res.status(500).json({ message: 'Error al vaciar carrito' });
        }
    });

    return router;
};