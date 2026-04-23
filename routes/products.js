const express = require('express');
const { authenticateToken, isAdmin, isSeller, canCreateProduct, canApproveProduct } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/products - Obtener productos (público, solo aprobados)
    router.get('/', (req, res) => {
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
        
        db.query(query, params, (err, products) => {
            if (err) {
                console.error('Error obteniendo productos:', err);
                return res.status(500).json({ message: 'Error al cargar productos' });
            }
            // Asegurar que images sea un array (por si viene como string JSON)
            const parsedProducts = products.map(p => ({
                ...p,
                images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || [])
            }));
            res.json(parsedProducts);
        });
    });

    // GET /api/products/pending - Productos pendientes (solo admin)
    router.get('/pending', authenticateToken, isAdmin, (req, res) => {
        db.query(
            `SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail
             FROM products p
             JOIN users u ON p.sellerId = u.id
             WHERE p.status = 'pending'
             ORDER BY p.createdAt DESC`,
            (err, products) => {
                if (err) {
                    console.error('Error obteniendo productos pendientes:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                const parsedProducts = products.map(p => ({
                    ...p,
                    images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || [])
                }));
                res.json(parsedProducts);
            }
        );
    });

    // POST /api/products - Crear producto (solo vendedores)
    router.post('/', authenticateToken, canCreateProduct, (req, res) => {
        const { name, price, description, sellerId, sellerName, images, stock, location, category } = req.body;
        
        // Validar que el sellerId coincide con el usuario autenticado
        if (sellerId !== req.userId && req.userRole !== 'Administrador') {
            return res.status(403).json({ message: 'No puedes crear productos para otro usuario' });
        }
        
        // 🔧 PUNTO 4: Verificar que el sellerId existe en la tabla users (evita foreign key constraint)
        db.query('SELECT id FROM users WHERE id = ?', [sellerId], (err, userRows) => {
            if (err) {
                console.error('Error verificando vendedor:', err);
                return res.status(500).json({ message: 'Error al validar vendedor' });
            }
            if (userRows.length === 0) {
                return res.status(400).json({ message: 'El vendedor especificado no existe. Inicia sesión nuevamente.' });
            }
            
            // Ahora insertar el producto
            db.query(
                `INSERT INTO products (name, price, description, sellerId, sellerName, images, stock, location, category, status, isAvailable, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', FALSE, NOW())`,
                [name, price, description, sellerId, sellerName, JSON.stringify(images || []), stock, location, category],
                (err, result) => {
                    if (err) {
                        console.error('Error creando producto:', err);
                        return res.status(500).json({ message: 'Error al crear producto' });
                    }
                    res.status(201).json({ 
                        id: result.insertId, 
                        message: 'Producto creado. Pendiente de aprobación por el administrador.' 
                    });
                }
            );
        });
    });

    // PUT /api/products/:id/approve - Aprobar producto (solo admin)
    router.put('/:id/approve', authenticateToken, canApproveProduct, (req, res) => {
        const { status } = req.body; // 'approved' o 'rejected'
        
        db.query(
            'UPDATE products SET status = ?, isAvailable = ? WHERE id = ?',
            [status, status === 'approved', req.params.id],
            (err) => {
                if (err) {
                    console.error('Error aprobando producto:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                
                // Obtener el vendedor para notificar
                db.query(
                    'SELECT sellerId FROM products WHERE id = ?',
                    [req.params.id],
                    (err, products) => {
                        if (err || products.length === 0) return;
                        
                        const message = status === 'approved' 
                            ? 'Tu producto ha sido aprobado y ya está disponible en la tienda'
                            : 'Tu producto ha sido rechazado. Por favor revisa los requisitos';
                        
                        // Asegurar que la tabla notifications existe (crearla si no)
                        db.query(
                            `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                             VALUES (?, ?, ?, ?, FALSE, NOW())`,
                            [products[0].sellerId, 
                             status === 'approved' ? '✅ Producto aprobado' : '❌ Producto rechazado',
                             message, 
                             'product_approval']
                        );
                        
                        res.json({ message: `Producto ${status === 'approved' ? 'aprobado' : 'rechazado'}` });
                    }
                );
            }
        );
    });

    // PUT /api/products/:id - Actualizar producto (solo dueño o admin)
    router.put('/:id', authenticateToken, (req, res) => {
        const { name, price, description, images, stock, location, category, isAvailable } = req.body;
        
        db.query('SELECT sellerId FROM products WHERE id = ?', [req.params.id], (err, products) => {
            if (err || products.length === 0) {
                return res.status(404).json({ message: 'Producto no encontrado' });
            }
            
            if (products[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso para editar este producto' });
            }
            
            db.query(
                `UPDATE products 
                 SET name = ?, price = ?, description = ?, images = ?, stock = ?, 
                     location = ?, category = ?, isAvailable = ?, updatedAt = NOW()
                 WHERE id = ?`,
                [name, price, description, JSON.stringify(images || []), stock, location, category, isAvailable, req.params.id],
                (err) => {
                    if (err) {
                        console.error('Error actualizando producto:', err);
                        return res.status(500).json({ message: 'Error al actualizar' });
                    }
                    res.json({ message: 'Producto actualizado' });
                }
            );
        });
    });

    // DELETE /api/products/:id - Eliminar producto (solo dueño o admin)
    router.delete('/:id', authenticateToken, (req, res) => {
        db.query('SELECT sellerId FROM products WHERE id = ?', [req.params.id], (err, products) => {
            if (err || products.length === 0) {
                return res.status(404).json({ message: 'Producto no encontrado' });
            }
            
            if (products[0].sellerId !== req.userId && req.userRole !== 'Administrador') {
                return res.status(403).json({ message: 'No tienes permiso para eliminar este producto' });
            }
            
            db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
                if (err) {
                    console.error('Error eliminando producto:', err);
                    return res.status(500).json({ message: 'Error al eliminar' });
                }
                res.json({ message: 'Producto eliminado' });
            });
        });
    });

    return router;
};