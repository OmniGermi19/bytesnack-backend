const express = require('express');
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// GET /api/cart
router.get('/', authenticateToken, async (req, res) => {
    try {
        const [items] = await db.query(
            `SELECT c.product_id as productId, c.quantity, p.name, p.price, 
                    JSON_EXTRACT(p.images, '$[0]') as imageUrl, p.seller_id as sellerId,
                    u.nombre_completo as sellerName
             FROM cart c
             JOIN products p ON c.product_id = p.id
             JOIN users u ON p.seller_id = u.id
             WHERE c.user_id = ? AND p.is_available = 1`,
            [req.userId]
        );

        res.json({ items });
    } catch (error) {
        console.error('Error getting cart:', error);
        res.status(500).json({ success: false, message: 'Error al obtener carrito' });
    }
});

// POST /api/cart/add
router.post('/add', authenticateToken, async (req, res) => {
    const { productId, quantity = 1 } = req.body;

    try {
        const [product] = await db.query('SELECT stock, is_available FROM products WHERE id = ?', [productId]);

        if (product.length === 0 || !product[0].is_available) {
            return res.status(400).json({ success: false, message: 'Producto no disponible' });
        }

        if (product[0].stock < quantity) {
            return res.status(400).json({ success: false, message: 'Stock insuficiente' });
        }

        await db.query(
            `INSERT INTO cart (user_id, product_id, quantity) 
             VALUES (?, ?, ?) 
             ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
            [req.userId, productId, quantity, quantity]
        );

        res.json({ success: true, message: 'Producto agregado al carrito' });
    } catch (error) {
        console.error('Error adding to cart:', error);
        res.status(500).json({ success: false, message: 'Error al agregar al carrito' });
    }
});

// PUT /api/cart/:productId
router.put('/:productId', authenticateToken, async (req, res) => {
    const { quantity } = req.body;

    if (quantity <= 0) {
        return router.delete(req, res);
    }

    try {
        const [product] = await db.query('SELECT stock FROM products WHERE id = ?', [req.params.productId]);

        if (product[0].stock < quantity) {
            return res.status(400).json({ success: false, message: 'Stock insuficiente' });
        }

        await db.query(
            'UPDATE cart SET quantity = ? WHERE user_id = ? AND product_id = ?',
            [quantity, req.userId, req.params.productId]
        );

        res.json({ success: true, message: 'Carrito actualizado' });
    } catch (error) {
        console.error('Error updating cart:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar carrito' });
    }
});

// DELETE /api/cart/:productId
router.delete('/:productId', authenticateToken, async (req, res) => {
    try {
        await db.query('DELETE FROM cart WHERE user_id = ? AND product_id = ?', [req.userId, req.params.productId]);
        res.json({ success: true, message: 'Producto eliminado del carrito' });
    } catch (error) {
        console.error('Error removing from cart:', error);
        res.status(500).json({ success: false, message: 'Error al eliminar del carrito' });
    }
});

// DELETE /api/cart/clear
router.delete('/clear', authenticateToken, async (req, res) => {
    try {
        await db.query('DELETE FROM cart WHERE user_id = ?', [req.userId]);
        res.json({ success: true, message: 'Carrito vaciado' });
    } catch (error) {
        console.error('Error clearing cart:', error);
        res.status(500).json({ success: false, message: 'Error al vaciar carrito' });
    }
});

module.exports = router;