const jwt = require('jsonwebtoken');

module.exports = (db) => {
    const router = require('express').Router();

    const verifyAdmin = (req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ message: 'No token provided' });
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded.role !== 'Administrador') {
                return res.status(403).json({ message: 'Acceso denegado' });
            }
            req.userId = decoded.userId;
            next();
        } catch (e) {
            return res.status(401).json({ message: 'Invalid token' });
        }
    };

    // GET /api/users - Obtener todos los usuarios (solo admin)
    router.get('/', verifyAdmin, (req, res) => {
        db.query(
            'SELECT id, role, numeroControl, nombreCompleto, email, telefono, isActive, createdAt FROM users',
            (err, users) => {
                if (err) {
                    console.error('Error obteniendo usuarios:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ users });
            }
        );
    });

    // PATCH /api/users/:userId/status - Cambiar estado del usuario
    router.patch('/:userId/status', verifyAdmin, (req, res) => {
        const { isActive } = req.body;
        
        db.query(
            'UPDATE users SET isActive = ? WHERE id = ?',
            [isActive, req.params.userId],
            (err) => {
                if (err) {
                    console.error('Error actualizando usuario:', err);
                    return res.status(500).json({ message: 'Error' });
                }
                res.json({ message: 'Estado actualizado' });
            }
        );
    });

    return router;
};