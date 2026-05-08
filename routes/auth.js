const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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

        // Validaciones de formato de número de control
        if (role === 'Vendedor') {
            const vendedorRegex = /^\d{8}V$/i;
            if (!vendedorRegex.test(numeroControl)) {
                return res.status(400).json({ message: 'Formato inválido: 8 dígitos + V (ej: 20241234V)' });
            }
        } else if (role === 'Comprador') {
            const compradorRegex = /^\d{8}C$/i;
            if (!compradorRegex.test(numeroControl)) {
                return res.status(400).json({ message: 'Formato inválido: 8 dígitos + C (ej: 20241234C)' });
            }
        }

        if (!numeroControl || !nombreCompleto || !role) {
            return res.status(400).json({ message: 'Faltan campos requeridos' });
        }

        if ((role === 'Vendedor' || role === 'Comprador') && !password) {
            return res.status(400).json({ message: 'La contraseña es requerida' });
        }

        try {
            // Verificar si el usuario ya existe
            const [existing] = await db.query(
                'SELECT id FROM users WHERE numeroControl = ?',
                [numeroControl]
            );

            if (existing.length > 0) {
                return res.status(400).json({ message: 'El número de control ya está registrado' });
            }

            // Hashear contraseña
            let hashedPassword = null;
            if (password) {
                if (password.length < 6) {
                    return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
                }
                hashedPassword = await bcrypt.hash(password, 10);
            }

            // Para administrador, verificar código de acceso
            if (role === 'Administrador') {
                if (codigoAcceso !== process.env.ADMIN_SECRET_CODE) {
                    return res.status(403).json({ message: 'Código de acceso inválido' });
                }
            }

            // Los compradores se crean activos, los vendedores pendientes
            const isActive = role === 'Comprador';

            // Procesar credencialFotos
            let credencialFotosJson = null;
            if (credencialFotos && Array.isArray(credencialFotos)) {
                credencialFotosJson = JSON.stringify(credencialFotos);
            }

            // Insertar usuario
            const [result] = await db.query(
                `INSERT INTO users 
                (role, numeroControl, nombreCompleto, carrera, email, telefono, password, 
                 codigoAcceso, credencialFotos, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0, 0, 0)`,
                [
                    role, numeroControl, nombreCompleto, carrera || null, email || null, 
                    telefono || null, hashedPassword, codigoAcceso || null,
                    credencialFotosJson, isVendedorTambien || false, isActive
                ]
            );

            // Generar token
            const token = jwt.sign(
                { userId: result.insertId, role: role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );

            const refreshToken = jwt.sign(
                { userId: result.insertId },
                process.env.JWT_SECRET,
                { expiresIn: '30d' }
            );

            // Obtener usuario creado
            const [users] = await db.query(
                `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                        isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras
                 FROM users WHERE id = ?`,
                [result.insertId]
            );

            res.status(201).json({
                token,
                refreshToken,
                user: users[0],
                message: role === 'Vendedor' 
                    ? 'Usuario registrado exitosamente. Tu cuenta está pendiente de aprobación por un administrador.'
                    : 'Usuario registrado exitosamente'
            });

        } catch (error) {
            console.error('Error en registro:', error);
            res.status(500).json({ message: 'Error al registrar usuario: ' + error.message });
        }
    });

    // POST /api/auth/login - Inicio de sesión
    router.post('/login', async (req, res) => {
        const { numeroControl, password, codigoAcceso, role } = req.body;

        if (!numeroControl) {
            return res.status(400).json({ message: 'Número de control requerido' });
        }

        try {
            const [users] = await db.query(
                `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono,
                        password, codigoAcceso, isVendedorTambien, createdAt, isActive, 
                        calificacion, totalVentas, totalCompras, direccion
                 FROM users WHERE numeroControl = ?`,
                [numeroControl]
            );

            if (users.length === 0) {
                return res.status(401).json({ message: 'Número de control no registrado' });
            }

            const user = users[0];

            if (!user.isActive) {
                return res.status(401).json({ message: 'Cuenta desactivada o pendiente de aprobación. Contacta al administrador.' });
            }

            if (user.role !== role) {
                return res.status(401).json({ message: `No tienes una cuenta de ${role}` });
            }

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

            const token = jwt.sign(
                { userId: user.id, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );

            const refreshToken = jwt.sign(
                { userId: user.id },
                process.env.JWT_SECRET,
                { expiresIn: '30d' }
            );

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
            const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

            const [users] = await db.query(
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
        res.json({ message: 'Sesión cerrada exitosamente' });
    });

    // ========== RECUPERACIÓN DE CONTRASEÑA ==========
    
    // POST /api/auth/forgot-password - Solicitar restablecimiento
    router.post('/forgot-password', async (req, res) => {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ message: 'El correo electrónico es requerido' });
        }
        
        try {
            // Buscar usuario por email
            const [users] = await db.query(
                'SELECT id, nombreCompleto FROM users WHERE email = ?',
                [email]
            );
            
            if (users.length === 0) {
                // Por seguridad, no revelamos si el email existe o no
                return res.json({ message: 'Si el correo existe, recibirás un enlace de recuperación' });
            }
            
            const user = users[0];
            
            // Generar token único
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 1); // Expira en 1 hora
            
            // Guardar token en la base de datos
            await db.query(
                `INSERT INTO password_resets (userId, token, expiresAt, used, createdAt)
                 VALUES (?, ?, ?, FALSE, NOW())`,
                [user.id, token, expiresAt]
            );
            
            console.log(`🔐 Token de recuperación para ${user.nombreCompleto} (${email}): ${token}`);
            console.log(`🔗 Enlace: /reset_password?token=${token}`);
            
            // En producción, aquí enviarías un correo electrónico
            // await sendEmail(email, 'Recuperación de contraseña', 
            //   `Haz clic en el siguiente enlace para restablecer tu contraseña:\n\n
            //    https://tu-app.com/reset-password?token=${token}\n\n
            //    Este enlace expirará en 1 hora.`);
            
            res.json({ 
                message: 'Si el correo existe, recibirás un enlace de recuperación',
                token: token // Solo en desarrollo, eliminar en producción
            });
        } catch (error) {
            console.error('Error en forgot-password:', error);
            res.status(500).json({ message: 'Error al procesar la solicitud' });
        }
    });
    
    // POST /api/auth/verify-reset-token - Verificar token
    router.post('/verify-reset-token', async (req, res) => {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ message: 'Token requerido' });
        }
        
        try {
            const [resets] = await db.query(
                `SELECT * FROM password_resets 
                 WHERE token = ? AND used = FALSE AND expiresAt > NOW()`,
                [token]
            );
            
            if (resets.length === 0) {
                return res.status(400).json({ message: 'Token inválido o expirado' });
            }
            
            res.json({ message: 'Token válido' });
        } catch (error) {
            console.error('Error en verify-reset-token:', error);
            res.status(500).json({ message: 'Error al verificar el token' });
        }
    });
    
    // POST /api/auth/reset-password - Restablecer contraseña
    router.post('/reset-password', async (req, res) => {
        const { token, password } = req.body;
        
        if (!token || !password) {
            return res.status(400).json({ message: 'Token y contraseña son requeridos' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
        }
        
        try {
            // Verificar token
            const [resets] = await db.query(
                `SELECT * FROM password_resets 
                 WHERE token = ? AND used = FALSE AND expiresAt > NOW()`,
                [token]
            );
            
            if (resets.length === 0) {
                return res.status(400).json({ message: 'Token inválido o expirado' });
            }
            
            const reset = resets[0];
            
            // Hashear nueva contraseña
            const hashedPassword = await bcrypt.hash(password, 10);
            
            // Actualizar contraseña del usuario
            await db.query(
                'UPDATE users SET password = ?, updatedAt = NOW() WHERE id = ?',
                [hashedPassword, reset.userId]
            );
            
            // Marcar token como usado
            await db.query(
                'UPDATE password_resets SET used = TRUE WHERE id = ?',
                [reset.id]
            );
            
            res.json({ message: 'Contraseña restablecida correctamente' });
        } catch (error) {
            console.error('Error en reset-password:', error);
            res.status(500).json({ message: 'Error al restablecer la contraseña' });
        }
    });

    return router;
};