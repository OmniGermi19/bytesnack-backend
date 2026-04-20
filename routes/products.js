const jwt = require('jsonwebtoken');

module.exports = (db) => {
    const router = require('express').Router();

    // Middleware para verificar token
    const verifyToken = (req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ message: 'No token provided' });
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.userId = decoded.userId;
            req.userRole = decoded.role;
            next();
        } catch (e) {
            return res.status(401).json({ message: 'Invalid token' });
        }
    };

    // GET /api/products - Obtener todos los productos
    router.get('/', (req, res) => {
        const { category, search, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let query = `
            SELECT p.*, u.nombreCompleto as sellerName
            FROM products p
            JOIN users u ON p.sellerId = u.id
            WHERE p.isAvailable = TRUE
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
            res.json(products);
        });
    });

    // GET /api/products/:id - Obtener un producto
    router.get('/:id', (req, res) => {
        db.query(
            `SELECT p.*, u.nombreCompleto as sellerName
             FROM products p
             JOIN users u ON p.sellerId = u.id
             WHERE p.id = ?`,
            [req.params.id],
            (err, products) => {
                if (err) return res.status(500).json({ message: 'Error' });
                if (products.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
                res.json(products[0]);
            }
        );
    });

    // POST /api/products - Crear producto
    router.post('/', verifyToken, (req, res) => {
        const { name, price, description, sellerId, sellerName, images, stock, location, category } = req.body;
        
        db.query(
            `INSERT INTO products (name, price, description, sellerId, sellerName, images, stock, location, category, isAvailable, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW())`,
            [name, price, description, sellerId, sellerName, JSON.stringify(images), stock, location, category],
            (err, result) => {
                if (err) {
                    console.error('Error creando producto:', err);
                    return res.status(500).json({ message: 'Error al crear producto' });
                }
                res.status(201).json({ id: result.insertId, message: 'Producto creado' });
            }
        );
    });

    // PUT /api/products/:id - Actualizar producto
    router.put('/:id', verifyToken, (req, res) => {
        const { name, price, description, images, stock, location, category, isAvailable } = req.body;
        
        db.query(
            `UPDATE products 
             SET name = ?, price = ?, description = ?, images = ?, stock = ?, location = ?, category = ?, isAvailable = ?, updatedAt = NOW()
             WHERE id = ?`,
            [name, price, description, JSON.stringify(images), stock, location, category, isAvailable, req.params.id],
            (err) => {
                if (err) {
                    console.error('Error actualizando producto:', err);
                    return res.status(500).json({ message: 'Error al actualizar' });
                }
                res.json({ message: 'Producto actualizado' });
            }
        );
    });

    // DELETE /api/products/:id - Eliminar producto
    router.delete('/:id', verifyToken, (req, res) => {
        db.query('DELETE FROM products WHERE id = ?', [req.params.id], (err) => {
            if (err) {
                console.error('Error eliminando producto:', err);
                return res.status(500).json({ message: 'Error al eliminar' });
            }
            res.json({ message: 'Producto eliminado' });
        });
    });

    return router;
};