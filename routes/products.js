const express = require('express');
const { authenticateToken, isAdmin, isSeller, canCreateProduct, canApproveProduct } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/products - Obtener productos (público, solo aprobados)
    router.get('/', async (req, res) => {
        const { category, search, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let query = `
            SELECT p.*, u.nombreCompleto as sellerName
            FROM products p
            JOIN users u ON p.sellerId = u.id
            WHERE p.status = 'approved' AND p.isAvailable = TRUE
        `;
        const params = [];
        
        if (category && category !== 'Todos') {
            query += ' AND p.category = ?';
            params.push(category);
        }
        
        if (search && search.trim()) {
            query += ' AND (p.name LIKE ? OR p.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        
        query += ' ORDER BY p.createdAt DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);
        
        try {
            const [products] = await db.query(query, params);
            const parsedProducts = products.map(p => ({
                ...p,
                price: parseFloat(p.price),
                images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
                isAvailable: p.isAvailable === 1 // 🔧 CORREGIDO: Asegurar booleano
            }));
            res.json(parsedProducts);
        } catch (error) {
            console.error('Error obteniendo productos:', error);
            res.status(500).json({ message: 'Error al cargar productos' });
        }
    });

    // GET /api/products/pending - Productos pendientes (solo admin)
    router.get('/pending', authenticateToken, isAdmin, async (req, res) => {
        try {
            const [products] = await db.query(
                `SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail
                 FROM products p
                 JOIN users u ON p.sellerId = u.id
                 WHERE p.status = 'pending'
                 ORDER BY p.createdAt DESC`
            );
            const parsedProducts = products.map(p => ({
                ...p,
                price: parseFloat(p.price),
                images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
                isAvailable: p.isAvailable === 1
            }));
            res.json(parsedProducts);
        } catch (error) {
            console.error('Error obteniendo productos pendientes:', error);
            res.status(500).json({ message: 'Error al obtener productos pendientes' });
        }
    });

    // POST /api/products - Crear producto (solo vendedores)
    router.post('/', authenticateToken, canCreateProduct, async (req, res) => {
        const { name, price, description, sellerId, sellerName, images, stock, location, category } = req.body;
        
        if (sellerId !== req.userId && req.userRole !== 'Administrador') {
            return res.status(403).json({ message: 'No puedes crear productos para otro usuario' });
        }
        
        if (!name || !price || price <= 0) {
            return res.status(400).json({ message: 'Nombre y precio válido son requeridos' });
        }
        
        try {
            const [userRows] = await db.query('SELECT id FROM users WHERE id = ?', [sellerId]);
            if (userRows.length === 0) {
                return res.status(400).json({ message: 'El vendedor especificado no existe' });
            }
            
            // 🔧 CORREGIDO: Asegurar que images sea un array JSON válido
            const imagesJson = JSON.stringify(images || []);
            
            const [result] = await db.query(
                `INSERT INTO products (name, price, description, sellerId, sellerName, images, stock, location, category, status, isAvailable, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', FALSE, NOW())`,
                [name, price, description, sellerId, sellerName, imagesJson, stock || 0, location || null, category || 'Otros']
            );
            
            res.status(201).json({ 
                id: result.insertId, 
                message: 'Producto creado. Pendiente de aprobación por el administrador.' 
            });
        } catch (error) {
            console.error('Error creando producto:', error);
            res.status(500).json({ message: 'Error al crear producto' });
        }
    });

    // PUT /api/products/:id - Actualizar producto (solo dueño o admin)
    router.put('/:id', authenticateToken, async (req, res) => {
        const { name, price, description, images, stock, location, category, isAvailable } = req.body;
        
        try {
            const [products] = await db.query('SELECT sellerId FROM products WHERE id = ?', [req.params.id]);
            if (products.length === 0) {
                return res.status(404).json({ message: 'Producto no encontrado' });
            }
            
            if (products[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso para editar este producto' });
            }
            
            const imagesJson = JSON.stringify(images || []);
            
            await db.query(
                `UPDATE products 
                 SET name = ?, price = ?, description = ?, images = ?, stock = ?, 
                     location = ?, category = ?, isAvailable = ?, updatedAt = NOW()
                 WHERE id = ?`,
                [name, price, description, imagesJson, stock, location, category, isAvailable ? 1 : 0, req.params.id]
            );
            
            res.json({ message: 'Producto actualizado correctamente' });
        } catch (error) {
            console.error('Error actualizando producto:', error);
            res.status(500).json({ message: 'Error al actualizar producto' });
        }
    });

    // DELETE /api/products/:id - Eliminar producto (solo dueño o admin)
    router.delete('/:id', authenticateToken, async (req, res) => {
        try {
            const [products] = await db.query('SELECT sellerId FROM products WHERE id = ?', [req.params.id]);
            if (products.length === 0) {
                return res.status(404).json({ message: 'Producto no encontrado' });
            }
            
            if (products[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso para eliminar este producto' });
            }
            
            await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
            res.json({ message: 'Producto eliminado correctamente' });
        } catch (error) {
            console.error('Error eliminando producto:', error);
            res.status(500).json({ message: 'Error al eliminar producto' });
        }
    });

    return router;
};