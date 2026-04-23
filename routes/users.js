const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken, isAdmin, isOwnerOrAdmin } = require('../middleware/auth');

module.exports = (db) => {
    const router = express.Router();

    // GET /api/users/profile - Obtener perfil propio
    router.get('/profile', authenticateToken, (req, res) => {
        db.query(
            `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                    isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras, direccion
             FROM users WHERE id = ?`,
            [req.userId],
            (err, users) => {
                if (err) {
                    console.error('Error obteniendo perfil:', err);
                    return res.status(500).json({ message: 'Error al obtener perfil' });
                }
                if (users.length === 0) {
                    return res.status(404).json({ message: 'Usuario no encontrado' });
                }
                res.json(users[0]);
            }
        );
    });

    // PUT /api/users/profile - Actualizar perfil
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
        
        db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
            if (err) {
                console.error('Error actualizando perfil:', err);
                return res.status(500).json({ message: 'Error al actualizar perfil' });
            }
            res.json({ message: 'Perfil actualizado correctamente' });
        });
    });

    // GET /api/users - Obtener todos los usuarios (solo admin)
    router.get('/', authenticateToken, isAdmin, (req, res) => {
        db.query(
            `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                    isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras
             FROM users ORDER BY createdAt DESC`,
            (err, users) => {
                if (err) {
                    console.error('Error obteniendo usuarios:', err);
                    return res.status(500).json({ message: 'Error al obtener usuarios' });
                }
                res.json(users);
            }
        );
    });

    // PATCH /api/users/:userId/status - Cambiar estado de usuario (solo admin)
    router.patch('/:userId/status', authenticateToken, isAdmin, (req, res) => {
        const { isActive } = req.body;
        const userId = req.params.userId;

        if (parseInt(userId) === req.userId) {
            return res.status(400).json({ message: 'No puedes desactivar tu propia cuenta' });
        }

        db.query(
            'UPDATE users SET isActive = ? WHERE id = ?',
            [isActive, userId],
            (err) => {
                if (err) {
                    console.error('Error actualizando estado:', err);
                    return res.status(500).json({ message: 'Error al actualizar estado' });
                }
                res.json({ message: `Usuario ${isActive ? 'activado' : 'desactivado'} correctamente` });
            }
        );
    });

    // PUT /api/users/:userId/role - Cambiar rol (solo admin)
    router.put('/:userId/role', authenticateToken, isAdmin, (req, res) => {
        const { role } = req.body;
        const validRoles = ['Comprador', 'Vendedor', 'Administrador'];
        
        if (!validRoles.includes(role)) {
            return res.status(400).json({ message: 'Rol inválido' });
        }

        db.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.userId], (err) => {
            if (err) {
                console.error('Error actualizando rol:', err);
                return res.status(500).json({ message: 'Error al actualizar rol' });
            }
            res.json({ message: 'Rol actualizado correctamente' });
        });
    });

    return router;
};