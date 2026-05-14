const express = require('express');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const admin = require('firebase-admin');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/notifications - Obtener notificaciones del usuario
    router.get('/', authenticateToken, async (req, res) => {
        try {
            console.log(`🔔 [Notifications] Obteniendo notificaciones de usuario ${req.userId}`);
            
            const [notifications] = await db.query(
                `SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC`,
                [req.userId]
            );
            
            console.log(`✅ [Notifications] ${notifications.length} notificaciones encontradas`);
            res.json({ notifications });
        } catch (error) {
            console.error('❌ Error obteniendo notificaciones:', error);
            res.status(500).json({ message: 'Error al obtener notificaciones' });
        }
    });

    // PATCH /api/notifications/:id/read - Marcar como leída
    router.patch('/:id/read', authenticateToken, async (req, res) => {
        const { id } = req.params;
        
        console.log(`🔔 [Notifications] Marcando notificación ${id} como leída para usuario ${req.userId}`);
        
        try {
            await db.query(
                'UPDATE notifications SET isRead = TRUE WHERE id = ? AND userId = ?',
                [id, req.userId]
            );
            console.log(`✅ [Notifications] Notificación marcada como leída`);
            res.json({ message: 'Notificación marcada como leída' });
        } catch (error) {
            console.error('❌ Error marcando notificación:', error);
            res.status(500).json({ message: 'Error al marcar notificación' });
        }
    });

    // PATCH /api/notifications/read-all - Marcar todas como leídas
    router.patch('/read-all', authenticateToken, async (req, res) => {
        console.log(`🔔 [Notifications] Marcando todas las notificaciones como leídas para usuario ${req.userId}`);
        
        try {
            await db.query(
                'UPDATE notifications SET isRead = TRUE WHERE userId = ?',
                [req.userId]
            );
            console.log(`✅ [Notifications] Todas las notificaciones marcadas como leídas`);
            res.json({ message: 'Todas las notificaciones marcadas como leídas' });
        } catch (error) {
            console.error('❌ Error marcando todas:', error);
            res.status(500).json({ message: 'Error al marcar notificaciones' });
        }
    });

    // DELETE /api/notifications/:id - Eliminar notificación
    router.delete('/:id', authenticateToken, async (req, res) => {
        const { id } = req.params;
        
        console.log(`🔔 [Notifications] Eliminando notificación ${id} para usuario ${req.userId}`);
        
        try {
            await db.query(
                'DELETE FROM notifications WHERE id = ? AND userId = ?',
                [id, req.userId]
            );
            console.log(`✅ [Notifications] Notificación eliminada`);
            res.json({ message: 'Notificación eliminada' });
        } catch (error) {
            console.error('❌ Error eliminando notificación:', error);
            res.status(500).json({ message: 'Error al eliminar notificación' });
        }
    });

    // POST /api/notifications/product-pending - Notificar a admins
    router.post('/product-pending', authenticateToken, async (req, res) => {
        const { productId, productName, sellerName } = req.body;
        
        console.log(`🔔 [Notifications] Producto pendiente: "${productName}" de ${sellerName}`);
        
        try {
            const [admins] = await db.query('SELECT id FROM users WHERE role = "Administrador"');
            
            console.log(`📢 [Notifications] Notificando a ${admins.length} administradores`);
            
            for (const adminUser of admins) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'product_approval', FALSE, NOW())`,
                    [adminUser.id, 
                     '🆕 Nuevo producto pendiente', 
                     `${sellerName} ha publicado "${productName}". Revisa el producto para aprobarlo.`]
                );
                
                await sendPushNotification(adminUser.id, 'Nuevo producto pendiente', `${sellerName} ha publicado "${productName}"`, 'product_approval');
            }
            
            console.log(`✅ [Notifications] Notificaciones enviadas a administradores`);
            res.json({ message: 'Notificaciones enviadas a administradores' });
        } catch (error) {
            console.error('❌ Error enviando notificaciones:', error);
            res.status(500).json({ message: 'Error al enviar notificaciones' });
        }
    });

    // POST /api/notifications/send - Enviar notificación a un usuario específico (solo admin)
    router.post('/send', authenticateToken, isAdmin, async (req, res) => {
        const { userId, title, body, type } = req.body;
        
        console.log(`🔔 [Notifications] Enviando notificación a usuario ${userId}: "${title}"`);
        
        if (!userId || !title || !body) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }
        
        try {
            const [users] = await db.query('SELECT id FROM users WHERE id = ?', [userId]);
            if (users.length === 0) {
                return res.status(404).json({ message: 'Usuario no encontrado' });
            }
            
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, title, body, type || 'general']
            );
            
            await sendPushNotification(userId, title, body, type || 'general');
            
            console.log(`✅ [Notifications] Notificación enviada a usuario ${userId}`);
            res.json({ message: 'Notificación enviada correctamente' });
        } catch (error) {
            console.error('❌ Error enviando notificación:', error);
            res.status(500).json({ message: 'Error al enviar notificación' });
        }
    });

    // ========== FCM TOKENS ==========
    
    // POST /api/notifications/fcm-token - Guardar token FCM
    router.post('/fcm-token', authenticateToken, async (req, res) => {
        const { token, deviceInfo } = req.body;
        
        console.log(`📱 [FCM] Guardando token para usuario ${req.userId}`);
        
        if (!token) {
            return res.status(400).json({ message: 'Token requerido' });
        }
        
        try {
            await db.query(
                `INSERT INTO fcm_tokens (userId, token, deviceInfo, createdAt)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE updatedAt = NOW(), deviceInfo = ?`,
                [req.userId, token, deviceInfo || null, deviceInfo || null]
            );
            console.log(`✅ [FCM] Token guardado correctamente`);
            res.json({ message: 'Token FCM guardado' });
        } catch (error) {
            console.error('❌ Error guardando token FCM:', error);
            res.status(500).json({ message: 'Error al guardar token' });
        }
    });
    
    // DELETE /api/notifications/fcm-token - Eliminar token FCM (logout)
    router.delete('/fcm-token', authenticateToken, async (req, res) => {
        console.log(`📱 [FCM] Eliminando tokens para usuario ${req.userId}`);
        
        try {
            await db.query('DELETE FROM fcm_tokens WHERE userId = ?', [req.userId]);
            console.log(`✅ [FCM] Tokens eliminados`);
            res.json({ message: 'Token FCM eliminado' });
        } catch (error) {
            console.error('❌ Error eliminando token FCM:', error);
            res.status(500).json({ message: 'Error al eliminar token' });
        }
    });

    // Función para enviar push notification
    async function sendPushNotification(userId, title, body, type, data = {}) {
        try {
            const [tokens] = await db.query(
                'SELECT token FROM fcm_tokens WHERE userId = ?',
                [userId]
            );
            
            if (tokens.length === 0) {
                console.log(`⚠️ [FCM] Usuario ${userId} no tiene tokens FCM registrados`);
                return;
            }
            
            const tokenChunks = [];
            for (let i = 0; i < tokens.length; i += 500) {
                tokenChunks.push(tokens.slice(i, i + 500));
            }
            
            for (const chunk of tokenChunks) {
                const message = {
                    notification: { title, body },
                    data: { type, ...data },
                    tokens: chunk.map(t => t.token),
                };
                
                const response = await admin.messaging().sendEachForMulticast(message);
                console.log(`📱 [FCM] Push notifications: ${response.successCount} exitosas, ${response.failureCount} fallidas`);
                
                if (response.failureCount > 0) {
                    for (let i = 0; i < response.responses.length; i++) {
                        const resp = response.responses[i];
                        if (!resp.success && resp.error?.code === 'messaging/registration-token-not-registered') {
                            await db.query('DELETE FROM fcm_tokens WHERE token = ?', [chunk[i].token]);
                            console.log(`🗑️ [FCM] Token inválido eliminado: ${chunk[i].token}`);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('❌ [FCM] Error enviando push notification:', error);
        }
    }

    return router;
};