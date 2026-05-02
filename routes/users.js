const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken, isAdmin, isOwnerOrAdmin } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/users/profile - Obtener perfil propio
    router.get('/profile', authenticateToken, async (req, res) => {
        try {
            const [users] = await db.query(
                `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                        isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras, direccion, profileImage
                 FROM users WHERE id = ?`,
                [req.userId]
            );
            if (users.length === 0) {
                return res.status(404).json({ message: 'Usuario no encontrado' });
            }
            res.json(users[0]);
        } catch (error) {
            console.error('Error obteniendo perfil:', error);
            res.status(500).json({ message: 'Error al obtener perfil' });
        }
    });

    // ========== NUEVO: Solicitar cambio de perfil ==========
    router.post('/profile/request-change', authenticateToken, async (req, res) => {
        const { nombreCompleto, carrera, email, telefono, direccion, profileImage } = req.body;
        
        if (!nombreCompleto && !carrera && !email && !telefono && !direccion && !profileImage) {
            return res.status(400).json({ message: 'No hay cambios para solicitar' });
        }
        
        try {
            // Obtener valores actuales del usuario
            const [users] = await db.query(
                'SELECT nombreCompleto, carrera, email, telefono, direccion, profileImage FROM users WHERE id = ?',
                [req.userId]
            );
            
            if (users.length === 0) {
                return res.status(404).json({ message: 'Usuario no encontrado' });
            }
            
            const current = users[0];
            
            // Verificar si ya hay una solicitud pendiente
            const [existing] = await db.query(
                'SELECT id FROM pending_profile_changes WHERE userId = ? AND status = "pending"',
                [req.userId]
            );
            
            if (existing.length > 0) {
                return res.status(400).json({ message: 'Ya tienes una solicitud de cambios pendiente' });
            }
            
            // Insertar solicitud de cambios
            await db.query(
                `INSERT INTO pending_profile_changes 
                (userId, nombreCompleto, carrera, email, telefono, direccion, profileImage, status, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
                [req.userId, nombreCompleto || null, carrera || null, email || null, telefono || null, direccion || null, profileImage || null]
            );
            
            // Notificar a los administradores
            const [admins] = await db.query('SELECT id FROM users WHERE role = "Administrador"');
            for (const admin of admins) {
                await db.query(
                    `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                     VALUES (?, ?, ?, 'profile_change', FALSE, NOW())`,
                    [admin.id, 
                     '✏️ Cambios de perfil pendientes', 
                     `El usuario ${current.nombreCompleto} ha solicitado cambios en su perfil. Revisa la solicitud.`]
                );
            }
            
            res.json({ message: 'Solicitud de cambios enviada correctamente' });
        } catch (error) {
            console.error('Error solicitando cambios:', error);
            res.status(500).json({ message: 'Error al solicitar cambios' });
        }
    });

    // PUT /api/users/profile - Actualizar perfil (directo, sin aprobación - solo para admin)
    router.put('/profile', authenticateToken, async (req, res) => {
        const { telefono, direccion, password, email, nombreCompleto } = req.body;
        const updates = [];
        const params = [];

        if (telefono !== undefined) {
            updates.push('telefono = ?');
            params.push(telefono);
        }
        
        if (direccion !== undefined) {
            updates.push('direccion = ?');
            params.push(direccion);
        }

        if (email !== undefined) {
            updates.push('email = ?');
            params.push(email);
        }

        if (nombreCompleto !== undefined && nombreCompleto.trim().length > 0) {
            updates.push('nombreCompleto = ?');
            params.push(nombreCompleto);
        }
        
        if (password !== undefined && password.trim().length > 0) {
            if (password.length < 6) {
                return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            updates.push('password = ?');
            params.push(hashedPassword);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ message: 'No hay campos para actualizar' });
        }
        
        updates.push('updatedAt = NOW()');
        params.push(req.userId);
        
        try {
            await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
            res.json({ message: 'Perfil actualizado correctamente' });
        } catch (error) {
            console.error('Error actualizando perfil:', error);
            res.status(500).json({ message: 'Error al actualizar perfil' });
        }
    });

    // GET /api/users - Obtener todos los usuarios (solo admin)
    router.get('/', authenticateToken, isAdmin, async (req, res) => {
        try {
            const [users] = await db.query(
                `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                        isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras, profileImage
                 FROM users ORDER BY createdAt DESC`
            );
            res.json(users);
        } catch (error) {
            console.error('Error obteniendo usuarios:', error);
            res.status(500).json({ message: 'Error al obtener usuarios' });
        }
    });

    // PATCH /api/users/:userId/status - Cambiar estado de usuario (solo admin)
    router.patch('/:userId/status', authenticateToken, isAdmin, async (req, res) => {
        const { isActive } = req.body;
        const userId = req.params.userId;

        if (parseInt(userId) === req.userId) {
            return res.status(400).json({ message: 'No puedes desactivar tu propia cuenta' });
        }

        try {
            await db.query('UPDATE users SET isActive = ? WHERE id = ?', [isActive, userId]);
            res.json({ message: `Usuario ${isActive ? 'activado' : 'desactivado'} correctamente` });
        } catch (error) {
            console.error('Error actualizando estado:', error);
            res.status(500).json({ message: 'Error al actualizar estado' });
        }
    });

    // PUT /api/users/:userId/role - Cambiar rol (solo admin)
    router.put('/:userId/role', authenticateToken, isAdmin, async (req, res) => {
        const { role } = req.body;
        const validRoles = ['Comprador', 'Vendedor', 'Administrador'];
        
        if (!validRoles.includes(role)) {
            return res.status(400).json({ message: 'Rol inválido' });
        }

        try {
            await db.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.userId]);
            res.json({ message: 'Rol actualizado correctamente' });
        } catch (error) {
            console.error('Error actualizando rol:', error);
            res.status(500).json({ message: 'Error al actualizar rol' });
        }
    });

    return router;
};