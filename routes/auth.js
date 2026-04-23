const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/auth/register - Registro de usuario
    router.post('/register', async (req, res) => {
        const {
            role,
            numeroControl,
            nombreCompleto,
            carrera,
            email,
            telefono,
            password,
            codigoAcceso,
            credencialFotos,
            isVendedorTambien
        } = req.body;

        // Validaciones
        if (!numeroControl || !nombreCompleto || !role) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        if (role === 'Vendedor' && !password) {
            return res.status(400).json({ message: 'La contraseña es requerida para vendedores' });
        }

        if (role === 'Comprador' && !password) {
            return res.status(400).json({ message: 'La contraseña es requerida' });
        }

        try {
            // Verificar si el usuario ya existe
            const [existing] = await db.promise().query(
                'SELECT id FROM users WHERE numeroControl = ?',
                [numeroControl]
            );

            if (existing.length > 0) {
                return res.status(400).json({ message: 'El número de control ya está registrado' });
            }

            // Hashear contraseña si existe
            let hashedPassword = null;
            if (password) {
                hashedPassword = await bcrypt.hash(password, 10);
            }

            // Para administrador, verificar código de acceso
            if (role === 'Administrador') {
                if (codigoAcceso !== process.env.ADMIN_SECRET_CODE) {
                    return res.status(403).json({ message: 'Código de acceso inválido' });
                }
            }

            // Insertar usuario
            const [result] = await db.promise().query(
                `INSERT INTO users 
                (role, numeroControl, nombreCompleto, carrera, email, telefono, password, 
                 codigoAcceso, credencialFotos, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0, 0, 0)`,
                [
                    role, numeroControl, nombreCompleto, carrera || null, email || null, 
                    telefono || null, hashedPassword, codigoAcceso || null,
                    credencialFotos ? JSON.stringify(credencialFotos) : null,
                    isVendedorTambien || false, true
                ]
            );

            // Generar token
            const token = jwt.sign(
                { userId: result.insertId, role: role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );

            // Obtener usuario creado
            const [users] = await db.promise().query(
                `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                        isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras
                 FROM users WHERE id = ?`,
                [result.insertId]
            );

            res.status(201).json({
                token,
                user: users[0],
                message: 'Usuario registrado exitosamente'
            });

        } catch (error) {
            console.error('Error en registro:', error);
            res.status(500).json({ message: 'Error al registrar usuario' });
        }
    });

    // POST /api/auth/login - Inicio de sesión
    router.post('/login', async (req, res) => {
        const { numeroControl, password, codigoAcceso, role } = req.body;

        if (!numeroControl) {
            return res.status(400).json({ message: 'Número de control requerido' });
        }

        try {
            // Buscar usuario
            const [users] = await db.promise().query(
                `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono,
                        password, codigoAcceso, isVendedorTambien, createdAt, isActive, 
                        calificacion, totalVentas, totalCompras
                 FROM users WHERE numeroControl = ?`,
                [numeroControl]
            );

            if (users.length === 0) {
                return res.status(401).json({ message: 'Credenciales incorrectas' });
            }

            const user = users[0];

            // Verificar si usuario está activo
            if (!user.isActive) {
                return res.status(401).json({ message: 'Cuenta desactivada. Contacta al administrador.' });
            }

            // Verificar rol
            if (user.role !== role) {
                return res.status(401).json({ message: `No tienes una cuenta de ${role}` });
            }

            // Verificar credenciales según rol
            let isValid = false;

            if (role === 'Administrador') {
                isValid = user.codigoAcceso === codigoAcceso;
            } else {
                if (!password || !user.password) {
                    isValid = false;
                } else {
                    isValid = await bcrypt.compare(password, user.password);
                }
            }

            if (!isValid) {
                return res.status(401).json({ message: 'Credenciales incorrectas' });
            }

            // Generar token
            const token = jwt.sign(
                { userId: user.id, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );

            // Generar refresh token
            const refreshToken = jwt.sign(
                { userId: user.id },
                process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
                { expiresIn: '30d' }
            );

            // Remover datos sensibles
            delete user.password;
            delete user.codigoAcceso;

            res.json({
                token,
                refreshToken,
                user,
                message: 'Inicio de sesión exitoso'
            });

        } catch (error) {
            console.error('Error en login:', error);
            res.status(500).json({ message: 'Error al iniciar sesión' });
        }
    });

    // POST /api/auth/refresh - Refrescar token
    router.post('/refresh', async (req, res) => {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(401).json({ message: 'Refresh token requerido' });
        }

        try {
            const decoded = jwt.verify(
                refreshToken,
                process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET
            );

            const [users] = await db.promise().query(
                'SELECT id, role FROM users WHERE id = ? AND isActive = TRUE',
                [decoded.userId]
            );

            if (users.length === 0) {
                return res.status(401).json({ message: 'Usuario no encontrado o inactivo' });
            }

            const newToken = jwt.sign(
                { userId: users[0].id, role: users[0].role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );

            res.json({ token: newToken });

        } catch (error) {
            console.error('Error refrescando token:', error);
            res.status(401).json({ message: 'Refresh token inválido' });
        }
    });

    // POST /api/auth/logout - Cerrar sesión
    router.post('/logout', (req, res) => {
        // El logout es principalmente del lado del cliente
        // Pero podemos registrar si queremos invalidar tokens
        res.json({ message: 'Sesión cerrada exitosamente' });
    });

    return router;
};