const express = require('express');
const db = require('../config/database');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const router = express.Router();

// GET /api/users
router.get('/', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [users] = await db.query(
            `SELECT id, role, numero_control, nombre_completo, carrera, email, telefono, 
                    is_active, created_at, calificacion, total_ventas, total_compras
             FROM users
             ORDER BY created_at DESC`
        );

        res.json({ users });
    } catch (error) {
        console.error('Error getting users:', error);
        res.status(500).json({ success: false, message: 'Error al obtener usuarios' });
    }
});

// PATCH /api/users/:userId/status
router.patch('/:userId/status', authenticateToken, isAdmin, async (req, res) => {
    const { isActive } = req.body;

    try {
        await db.query('UPDATE users SET is_active = ? WHERE id = ?', [isActive, req.params.userId]);
        res.json({ success: true, message: 'Estado actualizado' });
    } catch (error) {
        console.error('Error updating user status:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar estado' });
    }
});

module.exports = router;