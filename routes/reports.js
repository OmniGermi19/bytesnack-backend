const express = require('express');
const { authenticateToken, isAdmin } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // ========== REPORTAR USUARIO ==========
    router.post('/user', authenticateToken, async (req, res) => {
        const { reportedUserId, reason, description } = req.body;

        console.log(`📢 [Reports] Reporte de usuario: ${req.userId} reporta a ${reportedUserId} - Motivo: ${reason}`);

        if (!reportedUserId || !reason) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        if (parseInt(reportedUserId) === req.userId) {
            return res.status(400).json({ message: 'No puedes reportarte a ti mismo' });
        }

        try {
            const [existing] = await db.query(
                'SELECT id FROM reports WHERE reporterId = ? AND reportedUserId = ? AND status = "pending"',
                [req.userId, reportedUserId]
            );

            if (existing.length > 0) {
                return res.status(400).json({ message: 'Ya has reportado a este usuario y está pendiente de revisión' });
            }

            await db.query(
                `INSERT INTO reports (reporterId, reportedUserId, reason, description, status, createdAt)
                 VALUES (?, ?, ?, ?, 'pending', NOW())`,
                [req.userId, reportedUserId, reason, description || null]
            );

            await db.query(
                'UPDATE users SET reportCount = reportCount + 1 WHERE id = ?',
                [reportedUserId]
            );

            const [admins] = await db.query('SELECT id FROM users WHERE role = "Administrador"');
            for (const admin of admins) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'report', FALSE, NOW())`,
                    [admin.id,
                     '🚨 Nuevo reporte de usuario',
                     `Se ha recibido un reporte contra el usuario ID ${reportedUserId}. Motivo: ${reason}`]
                );
            }

            console.log(`✅ [Reports] Reporte de usuario enviado correctamente`);
            res.status(201).json({ success: true, message: 'Reporte enviado correctamente' });
        } catch (error) {
            console.error('❌ Error reportando usuario:', error);
            res.status(500).json({ message: 'Error al enviar reporte' });
        }
    });

    // ========== REPORTAR PRODUCTO ==========
    router.post('/product', authenticateToken, async (req, res) => {
        const { productId, productName, reason, description } = req.body;

        console.log(`📢 [Reports] Reporte de producto: ${req.userId} reporta "${productName}" - Motivo: ${reason}`);

        if (!productId || !reason) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        try {
            const [existing] = await db.query(
                'SELECT id FROM product_reports WHERE reporterId = ? AND productId = ? AND status = "pending"',
                [req.userId, productId]
            );

            if (existing.length > 0) {
                return res.status(400).json({ message: 'Ya has reportado este producto y está pendiente de revisión' });
            }

            await db.query(
                `INSERT INTO product_reports (reporterId, productId, productName, reason, description, status, createdAt)
                 VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
                [req.userId, productId, productName, reason, description || null]
            );

            await db.query(
                'UPDATE products SET reportCount = reportCount + 1 WHERE id = ?',
                [productId]
            );

            const [admins] = await db.query('SELECT id FROM users WHERE role = "Administrador"');
            for (const admin of admins) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'report', FALSE, NOW())`,
                    [admin.id,
                     '🚨 Nuevo reporte de producto',
                     `Se ha recibido un reporte para el producto "${productName}". Motivo: ${reason}`]
                );
            }

            console.log(`✅ [Reports] Reporte de producto enviado correctamente`);
            res.status(201).json({ success: true, message: 'Producto reportado correctamente' });
        } catch (error) {
            console.error('❌ Error reportando producto:', error);
            res.status(500).json({ message: 'Error al reportar producto' });
        }
    });

    // ========== OBTENER REPORTES (ADMIN) ==========
    router.get('/users', authenticateToken, isAdmin, async (req, res) => {
        const { status = 'pending' } = req.query;
        
        console.log(`📢 [Reports] Obteniendo reportes de usuarios - estado: ${status}`);
        
        try {
            const [reports] = await db.query(
                `SELECT r.*, 
                    u1.nombreCompleto as reporterName, u1.numeroControl as reporterControl,
                    u2.nombreCompleto as reportedName, u2.numeroControl as reportedControl,
                    u2.email as reportedEmail, u2.telefono as reportedPhone,
                    u2.isActive, u2.isBanned, u2.reportCount
                 FROM reports r
                 JOIN users u1 ON r.reporterId = u1.id
                 JOIN users u2 ON r.reportedUserId = u2.id
                 WHERE r.status = ?
                 ORDER BY r.createdAt DESC`,
                [status]
            );
            
            console.log(`✅ [Reports] ${reports.length} reportes de usuarios encontrados`);
            res.json(reports);
        } catch (error) {
            console.error('❌ Error obteniendo reportes:', error);
            res.status(500).json({ message: 'Error al obtener reportes' });
        }
    });

    router.get('/products', authenticateToken, isAdmin, async (req, res) => {
        const { status = 'pending' } = req.query;
        
        console.log(`📢 [Reports] Obteniendo reportes de productos - estado: ${status}`);
        
        try {
            const [reports] = await db.query(
                `SELECT pr.*, 
                    u.nombreCompleto as reporterName, u.numeroControl as reporterControl,
                    p.sellerId, p.sellerName, p.isAvailable, p.isHidden, p.status as productStatus
                 FROM product_reports pr
                 JOIN users u ON pr.reporterId = u.id
                 JOIN products p ON pr.productId = p.id
                 WHERE pr.status = ?
                 ORDER BY pr.createdAt DESC`,
                [status]
            );
            
            console.log(`✅ [Reports] ${reports.length} reportes de productos encontrados`);
            res.json(reports);
        } catch (error) {
            console.error('❌ Error obteniendo reportes de productos:', error);
            res.status(500).json({ message: 'Error al obtener reportes' });
        }
    });

    // ========== REVISAR REPORTES (ADMIN) ==========
    router.post('/users/:reportId/review', authenticateToken, isAdmin, async (req, res) => {
        const { reportId } = req.params;
        const { action, adminNotes, banReason } = req.body;

        console.log(`📢 [Reports] Revisando reporte de usuario ${reportId} - Acción: ${action}`);

        try {
            const [report] = await db.query('SELECT * FROM reports WHERE id = ?', [reportId]);

            if (report.length === 0) {
                return res.status(404).json({ message: 'Reporte no encontrado' });
            }

            const reportedUserId = report[0].reportedUserId;

            await db.query(
                `UPDATE reports 
                 SET status = 'reviewed', reviewedAt = NOW(), reviewedBy = ?, adminNotes = ? 
                 WHERE id = ?`,
                [req.userId, adminNotes || null, reportId]
            );

            if (action === 'ban') {
                await db.query(
                    `UPDATE users 
                     SET isActive = FALSE, isBanned = TRUE, banReason = ?, bannedAt = NOW() 
                     WHERE id = ?`,
                    [banReason || 'Comportamiento inapropiado', reportedUserId]
                );

                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'account_status', FALSE, NOW())`,
                    [reportedUserId,
                     '❌ Cuenta suspendida',
                     `Tu cuenta ha sido suspendida por: ${banReason || 'Comportamiento inapropiado'}. Contacta al administrador.`]
                );
                console.log(`✅ [Reports] Usuario ${reportedUserId} suspendido`);
            } else if (action === 'warn') {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'account_status', FALSE, NOW())`,
                    [reportedUserId,
                     '⚠️ Advertencia',
                     `Has recibido una advertencia por: ${adminNotes || 'Comportamiento inapropiado'}. Revisa nuestras políticas.`]
                );
                console.log(`✅ [Reports] Usuario ${reportedUserId} advertido`);
            } else {
                console.log(`✅ [Reports] Reporte ${reportId} desestimado`);
            }

            res.json({ success: true, message: 'Reporte revisado' });
        } catch (error) {
            console.error('❌ Error revisando reporte:', error);
            res.status(500).json({ message: 'Error al revisar reporte' });
        }
    });

    router.post('/products/:reportId/review', authenticateToken, isAdmin, async (req, res) => {
        const { reportId } = req.params;
        const { action, adminNotes } = req.body;

        console.log(`📢 [Reports] Revisando reporte de producto ${reportId} - Acción: ${action}`);

        try {
            const [report] = await db.query('SELECT * FROM product_reports WHERE id = ?', [reportId]);

            if (report.length === 0) {
                return res.status(404).json({ message: 'Reporte no encontrado' });
            }

            const productId = report[0].productId;
            const productName = report[0].productName;

            if (action === 'remove') {
                await db.query(
                    `UPDATE products 
                     SET isAvailable = FALSE, isHidden = TRUE, hiddenReason = ?, hiddenAt = NOW() 
                     WHERE id = ?`,
                    [adminNotes || 'Reportado por contenido inapropiado', productId]
                );

                const [product] = await db.query('SELECT sellerId, sellerName FROM products WHERE id = ?', [productId]);

                if (product.length > 0) {
                    await db.query(
                        `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                         VALUES (?, ?, ?, 'product_status', FALSE, NOW())`,
                        [product[0].sellerId,
                         '🚫 Producto ocultado',
                         `Tu producto "${productName}" ha sido ocultado por: ${adminNotes || 'Contenido inapropiado'}`]
                    );
                }

                await db.query(
                    `UPDATE product_reports 
                     SET status = 'product_removed', reviewedAt = NOW(), reviewedBy = ?, adminNotes = ? 
                     WHERE id = ?`,
                    [req.userId, adminNotes || null, reportId]
                );
                
                console.log(`✅ [Reports] Producto ${productId} (${productName}) ocultado`);
            } else if (action === 'dismiss') {
                await db.query(
                    `UPDATE product_reports 
                     SET status = 'dismissed', reviewedAt = NOW(), reviewedBy = ?, adminNotes = ? 
                     WHERE id = ?`,
                    [req.userId, adminNotes || null, reportId]
                );
                console.log(`✅ [Reports] Reporte de producto ${reportId} desestimado`);
            }

            res.json({ success: true, message: 'Reporte revisado' });
        } catch (error) {
            console.error('❌ Error revisando reporte de producto:', error);
            res.status(500).json({ message: 'Error al revisar reporte' });
        }
    });

    // ========== ELIMINAR CUENTA PERMANENTEMENTE (ADMIN) ==========
    router.delete('/user/:userId/permanent', authenticateToken, isAdmin, async (req, res) => {
        const { userId } = req.params;
        const { reason } = req.body;

        console.log(`🗑️ [Reports] Eliminando permanentemente usuario ${userId} - Motivo: ${reason || 'No especificado'}`);

        try {
            const [user] = await db.query(
                'SELECT nombreCompleto, numeroControl, email FROM users WHERE id = ?',
                [userId]
            );

            if (user.length === 0) {
                return res.status(404).json({ message: 'Usuario no encontrado' });
            }

            await db.query(
                'UPDATE users SET isActive = FALSE, deletedAt = NOW(), deletionReason = ? WHERE id = ?',
                [reason || 'Eliminado por administrador', userId]
            );

            console.log(`✅ [Reports] Usuario ${user[0].numeroControl} (${user[0].nombreCompleto}) eliminado permanentemente`);
            res.json({ success: true, message: 'Usuario eliminado permanentemente' });
        } catch (error) {
            console.error('❌ Error eliminando usuario:', error);
            res.status(500).json({ message: 'Error al eliminar usuario' });
        }
    });

    // ========== RESTAURAR USUARIO BANEADO (ADMIN) ==========
    router.post('/user/:userId/restore', authenticateToken, isAdmin, async (req, res) => {
        const { userId } = req.params;

        console.log(`🔄 [Reports] Restaurando usuario baneado ${userId}`);

        try {
            await db.query(
                `UPDATE users 
                 SET isActive = TRUE, isBanned = FALSE, banReason = NULL, bannedAt = NULL 
                 WHERE id = ?`,
                [userId]
            );

            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'account_status', FALSE, NOW())`,
                [userId,
                 '✅ Cuenta restaurada',
                 'Tu cuenta ha sido restaurada. Por favor sigue las políticas de la plataforma.']
            );

            console.log(`✅ [Reports] Usuario ${userId} restaurado`);
            res.json({ success: true, message: 'Usuario restaurado' });
        } catch (error) {
            console.error('❌ Error restaurando usuario:', error);
            res.status(500).json({ message: 'Error al restaurar usuario' });
        }
    });

    return router;
};