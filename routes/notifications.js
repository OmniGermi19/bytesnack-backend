const express = require('express');
const { authenticateToken, isAdmin } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/notifications - Obtener notificaciones del usuario
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const [notifications] = await db.query(
                `SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC`,
                [req.userId]
            );
            res.json({ notifications });
        } catch (error) {
            console.error('Error obteniendo notificaciones:', error);
            res.status(500).json({ message: 'Error al obtener notificaciones' });
        }
    });

    // PATCH /api/notifications/:id/read - Marcar como leída
    router.patch('/:id/read', authenticateToken, async (req, res) => {
        try {
            await db.query(
                'UPDATE notifications SET isRead = TRUE WHERE id = ? AND userId = ?',
                [req.params.id, req.userId]
            );
            res.json({ message: 'Notificación marcada como leída' });
        } catch (error) {
            console.error('Error marcando notificación:', error);
            res.status(500).json({ message: 'Error al marcar notificación' });
        }
    });

    // PATCH /api/notifications/read-all - Marcar todas como leídas
    router.patch('/read-all', authenticateToken, async (req, res) => {
        try {
            await db.query(
                'UPDATE notifications SET isRead = TRUE WHERE userId = ?',
                [req.userId]
            );
            res.json({ message: 'Todas las notificaciones marcadas como leídas' });
        } catch (error) {
            console.error('Error marcando todas:', error);
            res.status(500).json({ message: 'Error al marcar notificaciones' });
        }
    });

    // DELETE /api/notifications/:id - Eliminar notificación
    router.delete('/:id', authenticateToken, async (req, res) => {
        try {
            await db.query(
                'DELETE FROM notifications WHERE id = ? AND userId = ?',
                [req.params.id, req.userId]
            );
            res.json({ message: 'Notificación eliminada' });
        } catch (error) {
            console.error('Error eliminando notificación:', error);
            res.status(500).json({ message: 'Error al eliminar notificación' });
        }
    });

    // POST /api/notifications/product-pending - Notificar a admins (solo admin o vendedor)
    router.post('/product-pending', authenticateToken, async (req, res) => {
        const { productId, productName, sellerName } = req.body;
        
        try {
            const [admins] = await db.query('SELECT id FROM users WHERE role = "Administrador"');
            
            for (const admin of admins) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'product_approval', FALSE, NOW())`,
                    [admin.id, 
                     '🆕 Nuevo producto pendiente', 
                     `${sellerName} ha publicado "${productName}". Revisa el producto para aprobarlo.`,
                     'product_approval']
                );
            }
            res.json({ message: 'Notificaciones enviadas a administradores' });
        } catch (error) {
            console.error('Error enviando notificaciones:', error);
            res.status(500).json({ message: 'Error al enviar notificaciones' });
        }
    });

    return router;
};