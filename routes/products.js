const express = require('express');
const db = require('../config/database');
const { authenticateToken, isSeller } = require('../middleware/auth');
const router = express.Router();

// GET /api/products
router.get('/', async (req, res) => {
    const { category, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        let query = `
            SELECT p.*, u.nombre_completo as seller_name
            FROM products p
            JOIN users u ON p.seller_id = u.id
            WHERE p.is_available = 1
        `;
        const params = [];

        if (category && category !== 'Todos') {
            query += ' AND p.category = ?';
            params.push(category);
        }

        if (search && search.trim() !== '') {
            query += ' AND (p.name LIKE ? OR p.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [products] = await db.query(query, params);
        
        const parsedProducts = products.map(p => ({
            ...p,
            images: p.images ? JSON.parse(p.images) : []
        }));
        
        res.json({ products: parsedProducts });
    } catch (error) {
        console.error('Error getting products:', error);
        res.status(500).json({ success: false, message: 'Error al obtener productos' });
    }
});

// POST /api/products
router.post('/', authenticateToken, isSeller, async (req, res) => {
    const { name, price, description, category, images, stock, location } = req.body;

    if (!name || !price) {
        return res.status(400).json({ success: false, message: 'Nombre y precio son requeridos' });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO products (seller_id, name, price, description, category, images, stock, location)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.userId, name, price, description || '', category || 'Otros', JSON.stringify(images || []), stock || 0, location || 'Sin ubicación']
        );

        res.status(201).json({
            success: true,
            message: 'Producto creado exitosamente',
            productId: result.insertId
        });
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ success: false, message: 'Error al crear producto' });
    }
});

// DELETE /api/products/:id
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const [product] = await db.query('SELECT seller_id FROM products WHERE id = ?', [req.params.id]);

        if (product.length === 0) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado' });
        }

        if (product[0].seller_id !== req.userId && req.userRole !== 'Administrador') {
            return res.status(403).json({ success: false, message: 'No tienes permiso para eliminar este producto' });
        }

        await db.query('UPDATE products SET is_available = 0 WHERE id = ?', [req.params.id]);

        res.json({ success: true, message: 'Producto eliminado' });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ success: false, message: 'Error al eliminar producto' });
    }
});

module.exports = router;