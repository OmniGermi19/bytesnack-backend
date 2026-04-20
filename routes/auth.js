const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const router = express.Router();

const generateTokens = (userId, role) => {
    const token = jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    const refreshToken = jwt.sign({ userId, role }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN });
    return { token, refreshToken };
};

const saveRefreshToken = async (userId, refreshToken) => {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await db.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
        [userId, refreshToken, expiresAt]
    );
};

// REGISTRO
router.post('/register', async (req, res) => {
    const { 
        role, numeroControl, nombreCompleto, carrera, email, 
        telefono, password, codigoAcceso, credencialFotos, isVendedorTambien 
    } = req.body;

    try {
        const [existing] = await db.query(
            'SELECT id FROM users WHERE numero_control = ?',
            [numeroControl]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'El número de control ya está registrado' });
        }

        const hashedPassword = await bcrypt.hash(password || 'default123', 10);

        const [result] = await db.query(
            `INSERT INTO users (role, numero_control, nombre_completo, carrera, email, telefono, password_hash, codigo_acceso, credencial_fotos, is_vendedor_tambien)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [role || 'Comprador', numeroControl, nombreCompleto, carrera || null, email || null, telefono || null, hashedPassword, codigoAcceso || null, JSON.stringify(credencialFotos || []), isVendedorTambien || false]
        );

        const { token, refreshToken } = generateTokens(result.insertId, role || 'Comprador');
        await saveRefreshToken(result.insertId, refreshToken);

        res.status(201).json({
            success: true,
            message: 'Usuario registrado exitosamente',
            token,
            refreshToken,
            user: {
                id: result.insertId,
                role: role || 'Comprador',
                numeroControl,
                nombreCompleto,
                carrera: carrera || null,
                email: email || null,
                telefono: telefono || null,
                isVendedorTambien: isVendedorTambien || false
            }
        });
    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
});

// LOGIN
router.post('/login', async (req, res) => {
    const { numeroControl, password, codigoAcceso, role } = req.body;

    try {
        const [users] = await db.query(
            'SELECT * FROM users WHERE numero_control = ? AND is_active = 1',
            [numeroControl]
        );

        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
        }

        const user = users[0];

        if (role === 'Administrador') {
            if (user.role !== 'Administrador' || user.codigo_acceso !== codigoAcceso) {
                return res.status(401).json({ success: false, message: 'Código de acceso incorrecto' });
            }
        } else {
            const validPassword = await bcrypt.compare(password, user.password_hash);
            if (!validPassword) {
                return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
            }
            if (user.role !== role && user.role !== 'Administrador') {
                return res.status(401).json({ success: false, message: `No tienes rol de ${role}` });
            }
        }

        const { token, refreshToken } = generateTokens(user.id, user.role);
        await saveRefreshToken(user.id, refreshToken);

        res.json({
            success: true,
            token,
            refreshToken,
            user: {
                id: user.id,
                role: user.role,
                numeroControl: user.numero_control,
                nombreCompleto: user.nombre_completo,
                carrera: user.carrera,
                email: user.email,
                telefono: user.telefono,
                calificacion: parseFloat(user.calificacion) || 0,
                totalVentas: user.total_ventas || 0,
                totalCompras: user.total_compras || 0,
                isVendedorTambien: user.is_vendedor_tambien === 1,
                profileImage: user.profile_image,
                direccion: user.direccion
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
});

// REFRESH TOKEN
router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        return res.status(401).json({ success: false, message: 'Refresh token requerido' });
    }

    try {
        const [tokens] = await db.query(
            'SELECT user_id FROM refresh_tokens WHERE token = ? AND expires_at > NOW()',
            [refreshToken]
        );

        if (tokens.length === 0) {
            return res.status(401).json({ success: false, message: 'Refresh token inválido o expirado' });
        }

        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const { token: newToken, refreshToken: newRefreshToken } = generateTokens(decoded.userId, decoded.role);

        await db.query('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
        await saveRefreshToken(decoded.userId, newRefreshToken);

        res.json({ success: true, token: newToken, refreshToken: newRefreshToken });
    } catch (error) {
        res.status(401).json({ success: false, message: 'Refresh token inválido' });
    }
});

// LOGOUT
router.post('/logout', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        try {
            const decoded = jwt.decode(token);
            if (decoded && decoded.userId) {
                await db.query('DELETE FROM refresh_tokens WHERE user_id = ?', [decoded.userId]);
            }
        } catch (e) {}
    }

    res.json({ success: true, message: 'Sesión cerrada' });
});

module.exports = router;