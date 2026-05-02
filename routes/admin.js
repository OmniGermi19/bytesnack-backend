const express = require('express');
const { authenticateToken, isAdmin } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/admin/stats - Estadísticas generales
    router.get('/stats', authenticateToken, isAdmin, async (req, res) => {
        try {
            const [[totalUsers]] = await db.query('SELECT COUNT(*) as count FROM users');
            const [[totalProducts]] = await db.query('SELECT COUNT(*) as count FROM products WHERE status = "approved"');
            const [[pendingProducts]] = await db.query('SELECT COUNT(*) as count FROM products WHERE status = "pending"');
            const [[totalOrders]] = await db.query('SELECT COUNT(*) as count FROM orders');
            const [[totalSales]] = await db.query('SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE status = "delivered"');
            const [[totalRevenue]] = await db.query('SELECT COALESCE(SUM(total), 0) as total FROM orders');

            res.json({
                totalUsers: totalUsers?.count || 0,
                totalProducts: totalProducts?.count || 0,
                pendingProducts: pendingProducts?.count || 0,
                totalOrders: totalOrders?.count || 0,
                totalSales: parseFloat(totalSales?.total || 0),
                totalRevenue: parseFloat(totalRevenue?.total || 0)
            });
        } catch (error) {
            console.error('Error obteniendo stats:', error);
            res.status(500).json({ message: 'Error al obtener estadísticas' });
        }
    });

    // GET /api/admin/user-stats - Estadísticas de usuarios
    router.get('/user-stats', authenticateToken, isAdmin, async (req, res) => {
        try {
            const [[vendedores]] = await db.query('SELECT COUNT(*) as count FROM users WHERE role = "Vendedor" AND isActive = 1');
            const [[compradores]] = await db.query('SELECT COUNT(*) as count FROM users WHERE role = "Comprador" AND isActive = 1');
            const [[pendientes]] = await db.query('SELECT COUNT(*) as count FROM users WHERE role = "Vendedor" AND isActive = 0');
            const [[administradores]] = await db.query('SELECT COUNT(*) as count FROM users WHERE role = "Administrador"');
            const [[productosPendientes]] = await db.query('SELECT COUNT(*) as count FROM products WHERE status = "pending"');

            res.json({
                totalVendedores: vendedores?.count || 0,
                totalCompradores: compradores?.count || 0,
                totalPendientes: pendientes?.count || 0,
                totalAdministradores: administradores?.count || 0,
                pendientesProductos: productosPendientes?.count || 0
            });
        } catch (error) {
            console.error('Error obteniendo user-stats:', error);
            res.status(500).json({ message: 'Error al obtener estadísticas' });
        }
    });

    // GET /api/admin/pending-products - Productos pendientes
    router.get('/pending-products', authenticateToken, isAdmin, async (req, res) => {
        try {
            console.log('🔍 [ADMIN] Usuario autenticado:', req.userId, req.userRole);
            
            const [products] = await db.query(
                `SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail, u.numeroControl as sellerControl
                 FROM products p
                 JOIN users u ON p.sellerId = u.id
                 WHERE p.status = 'pending'`
            );
            
            console.log('📊 [ADMIN] Productos pendientes encontrados:', products.length);
            
            const parsedProducts = products.map(p => ({
                ...p,
                price: parseFloat(p.price),
                images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || []),
                isAvailable: p.isAvailable === 1
            }));
            
            parsedProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            
            res.json(parsedProducts);
        } catch (error) {
            console.error('❌ [ADMIN] Error obteniendo productos pendientes:', error);
            res.status(500).json({ message: 'Error al obtener productos pendientes' });
        }
    });

    // PUT /api/admin/approve-product/:id - Aprobar/Rechazar producto
    router.put('/approve-product/:id', authenticateToken, isAdmin, async (req, res) => {
        const { approved } = req.body;
        const productId = req.params.id;
        
        try {
            const status = approved ? 'approved' : 'rejected';
            const isAvailable = approved ? 1 : 0;
            
            await db.query(
                'UPDATE products SET status = ?, isAvailable = ?, updatedAt = NOW() WHERE id = ?',
                [status, isAvailable, productId]
            );
            
            const [products] = await db.query('SELECT sellerId, name FROM products WHERE id = ?', [productId]);
            if (products.length > 0) {
                const message = approved 
                    ? `Tu producto "${products[0].name}" ha sido aprobado y ya está disponible en la tienda`
                    : `Tu producto "${products[0].name}" ha sido rechazado. Por favor revisa los requisitos para publicar productos.`;
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'product_approval', FALSE, NOW())`,
                    [products[0].sellerId, 
                     approved ? '✅ Producto aprobado' : '❌ Producto rechazado',
                     message]
                );
            }
            
            res.json({ message: approved ? 'Producto aprobado' : 'Producto rechazado' });
        } catch (error) {
            console.error('Error aprobando producto:', error);
            res.status(500).json({ message: 'Error al procesar el producto' });
        }
    });

    // GET /api/admin/pending-vendors - Vendedores pendientes
    router.get('/pending-vendors', authenticateToken, isAdmin, async (req, res) => {
        try {
            const [vendors] = await db.query(
                `SELECT id, nombreCompleto, numeroControl, carrera, email, telefono, credencialFotos, createdAt 
                 FROM users 
                 WHERE role = 'Vendedor' AND isActive = 0`
            );
            
            const parsedVendors = vendors.map(v => ({
                ...v,
                credencialFotos: typeof v.credencialFotos === 'string' ? JSON.parse(v.credencialFotos || '[]') : (v.credencialFotos || [])
            }));
            
            parsedVendors.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            
            res.json({ vendors: parsedVendors });
        } catch (error) {
            console.error('Error obteniendo vendedores pendientes:', error);
            res.status(500).json({ message: 'Error al obtener vendedores pendientes' });
        }
    });

    // POST /api/admin/approve-vendor - Aprobar/Rechazar vendedor
    router.post('/approve-vendor', authenticateToken, isAdmin, async (req, res) => {
        const { userId, approved, rejectionReason } = req.body;
        
        try {
            await db.query('UPDATE users SET isActive = ? WHERE id = ?', [approved ? 1 : 0, userId]);
            
            const [users] = await db.query('SELECT email, nombreCompleto, numeroControl FROM users WHERE id = ?', [userId]);
            
            if (users.length > 0) {
                const title = approved ? '✅ Cuenta aprobada' : '❌ Cuenta rechazada';
                const message = approved 
                    ? `Hola ${users[0].nombreCompleto}, tu cuenta de vendedor ha sido aprobada. Ya puedes iniciar sesión con tu número de control: ${users[0].numeroControl}`
                    : `Hola ${users[0].nombreCompleto}, tu solicitud para ser vendedor ha sido rechazada. Motivo: ${rejectionReason || 'No especificado'}. Contacta al administrador para más información.`;
                
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'user_approval', FALSE, NOW())`,
                    [userId, title, message]
                );
            }
            
            res.json({ message: approved ? 'Vendedor aprobado exitosamente' : 'Vendedor rechazado' });
        } catch (error) {
            console.error('Error procesando vendedor:', error);
            res.status(500).json({ message: 'Error al procesar la solicitud' });
        }
    });

    // ========== NUEVO: CAMBIOS DE PERFIL PENDIENTES ==========
    
    // GET /api/admin/pending-profile-changes - Obtener cambios de perfil pendientes
    router.get('/pending-profile-changes', authenticateToken, isAdmin, async (req, res) => {
        try {
            const [changes] = await db.query(
                `SELECT pc.*, u.nombreCompleto as userName, u.role as userRole,
                        u.nombreCompleto as nombreCompletoActual, u.carrera as carreraActual,
                        u.email as emailActual, u.telefono as telefonoActual,
                        u.direccion as direccionActual, u.profileImage as profileImageActual
                 FROM pending_profile_changes pc
                 JOIN users u ON pc.userId = u.id
                 WHERE pc.status = 'pending'
                 ORDER BY pc.createdAt ASC`
            );
            
            res.json({ changes });
        } catch (error) {
            console.error('Error obteniendo cambios pendientes:', error);
            res.status(500).json({ message: 'Error al obtener cambios pendientes' });
        }
    });

    // POST /api/admin/approve-profile-change - Aprobar/Rechazar cambio de perfil
    router.post('/approve-profile-change', authenticateToken, isAdmin, async (req, res) => {
        const { changeId, approved, rejectionReason } = req.body;
        
        try {
            // Obtener el cambio pendiente
            const [changes] = await db.query(
                `SELECT * FROM pending_profile_changes WHERE id = ?`,
                [changeId]
            );
            
            if (changes.length === 0) {
                return res.status(404).json({ message: 'Cambio no encontrado' });
            }
            
            const change = changes[0];
            const status = approved ? 'approved' : 'rejected';
            
            if (approved) {
                // Aplicar los cambios al usuario
                const updates = [];
                const params = [];
                
                if (change.nombreCompleto) {
                    updates.push('nombreCompleto = ?');
                    params.push(change.nombreCompleto);
                }
                if (change.carrera) {
                    updates.push('carrera = ?');
                    params.push(change.carrera);
                }
                if (change.email) {
                    updates.push('email = ?');
                    params.push(change.email);
                }
                if (change.telefono) {
                    updates.push('telefono = ?');
                    params.push(change.telefono);
                }
                if (change.direccion) {
                    updates.push('direccion = ?');
                    params.push(change.direccion);
                }
                if (change.profileImage) {
                    updates.push('profileImage = ?');
                    params.push(change.profileImage);
                }
                
                updates.push('updatedAt = NOW()');
                params.push(change.userId);
                
                if (updates.length > 1) {
                    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
                }
            }
            
            // Actualizar el estado del cambio
            await db.query(
                `UPDATE pending_profile_changes 
                 SET status = ?, reviewedAt = NOW(), rejectionReason = ?
                 WHERE id = ?`,
                [status, approved ? null : (rejectionReason || 'No especificado'), changeId]
            );
            
            // Notificar al usuario
            const title = approved ? '✅ Cambios aprobados' : '❌ Cambios rechazados';
            const message = approved 
                ? 'Los cambios solicitados en tu perfil han sido aprobados y aplicados.'
                : `Los cambios solicitados en tu perfil han sido rechazados. Motivo: ${rejectionReason || 'No especificado'}`;
            
            await db.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, 'profile_change', FALSE, NOW())`,
                [change.userId, title, message]
            );
            
            res.json({ message: approved ? 'Cambios aprobados' : 'Cambios rechazados' });
        } catch (error) {
            console.error('Error procesando cambio de perfil:', error);
            res.status(500).json({ message: 'Error al procesar el cambio' });
        }
    });

    return router;
};