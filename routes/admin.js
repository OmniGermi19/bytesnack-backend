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
            const [products] = await db.query(
                `SELECT p.*, u.nombreCompleto as sellerName, u.email as sellerEmail, u.numeroControl as sellerControl
                 FROM products p
                 JOIN users u ON p.sellerId = u.id
                 WHERE p.status = 'pending'
                 ORDER BY p.createdAt ASC`
            );
            
            const parsedProducts = products.map(p => ({
                ...p,
                price: parseFloat(p.price),
                images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : (p.images || [])
            }));
            
            res.json(parsedProducts);
        } catch (error) {
            console.error('Error obteniendo productos pendientes:', error);
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
            
            // Obtener el vendedor para notificar
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
                 WHERE role = 'Vendedor' AND isActive = 0 
                 ORDER BY createdAt ASC`
            );
            
            const parsedVendors = vendors.map(v => ({
                ...v,
                credencialFotos: typeof v.credencialFotos === 'string' ? JSON.parse(v.credencialFotos || '[]') : (v.credencialFotos || [])
            }));
            
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

    return router;
};