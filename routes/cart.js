const jwt = require('jsonwebtoken');

module.exports = (db) => {
    const router = require('express').Router();

    const verifyToken = (req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ message: 'No token provided' });
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.userId = decoded.userId;
            next();
        } catch (e) {
            return res.status(401).json({ message: 'Invalid token' });
        }
    };

    // GET /api/cart - Obtener carrito
    router.get('/', verifyToken, (req, res) => {
        db.query(
            `SELECT c.*, p.name, p.price, p.images 
             FROM cart_items c 
             JOIN products p ON c.productId = p.id 
             WHERE c.userId = ?`,
            [req.userId],
            (err, items) => {
                if (err) {
                    console.error('Error obteniendo carrito:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ items });
            }
        );
    });

    // POST /api/cart/add - Agregar al carrito
    router.post('/add', verifyToken, (req, res) => {
        const { productId, quantity } = req.body;
        
        db.query(
            `INSERT INTO cart_items (userId, productId, quantity) 
             VALUES (?, ?, ?) 
             ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
            [req.userId, productId, quantity, quantity],
            (err) => {
                if (err) {
                    console.error('Error agregando al carrito:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ message: 'Agregado al carrito' });
            }
        );
    });

    // PUT /api/cart/:productId - Actualizar cantidad
    router.put('/:productId', verifyToken, (req, res) => {
        const { quantity } = req.body;
        
        db.query(
            'UPDATE cart_items SET quantity = ? WHERE userId = ? AND productId = ?',
            [quantity, req.userId, req.params.productId],
            (err) => {
                if (err) {
                    console.error('Error actualizando carrito:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ message: 'Carrito actualizado' });
            }
        );
    });

    // DELETE /api/cart/:productId - Eliminar del carrito
    router.delete('/:productId', verifyToken, (req, res) => {
        db.query(
            'DELETE FROM cart_items WHERE userId = ? AND productId = ?',
            [req.userId, req.params.productId],
            (err) => {
                if (err) {
                    console.error('Error eliminando del carrito:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ message: 'Eliminado del carrito' });
            }
        );
    });

    // DELETE /api/cart/clear - Vaciar carrito
    router.delete('/clear', verifyToken, (req, res) => {
        db.query('DELETE FROM cart_items WHERE userId = ?', [req.userId], (err) => {
            if (err) {
                console.error('Error vaciando carrito:', err);
                return res.status(500).json({ message: 'Error' });
            }
            res.json({ message: 'Carrito vaciado' });
        });
    });

    return router;
};