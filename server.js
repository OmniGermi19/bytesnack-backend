const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();

// Middlewares
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configuración de email
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Función para enviar correo
const sendEmail = async (to, subject, html) => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log('⚠️ Email no configurado. Omitiendo envío de correo.');
        return false;
    }
    
    try {
        await emailTransporter.sendMail({
            from: `"ByteSnack ITESCO" <${process.env.EMAIL_USER}>`,
            to: to,
            subject: subject,
            html: html
        });
        console.log(`✅ Correo enviado a ${to}`);
        return true;
    } catch (error) {
        console.error('❌ Error enviando correo:', error);
        return false;
    }
};

// Pool de conexiones MySQL
const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

const promiseDb = db.promise();

// Verificar conexión
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error de conexión a MySQL:', err.message);
        process.exit(1);
    }
    console.log('✅ Conectado a MySQL correctamente');
    connection.release();
});

// ==================== MIDDLEWARE ====================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ message: 'No se proporcionó token de autenticación' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.userRole = decoded.role;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expirado' });
        }
        return res.status(403).json({ message: 'Token inválido' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de administrador.' });
    }
    next();
};

const isSeller = (req, res, next) => {
    if (req.userRole !== 'Vendedor' && req.userRole !== 'Administrador') {
        return res.status(403).json({ message: 'Acceso denegado. Se requieren permisos de vendedor.' });
    }
    next();
};

// ==================== RUTAS DE AUTENTICACIÓN ====================
app.post('/api/auth/register', async (req, res) => {
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

    if (!numeroControl || !nombreCompleto || !role) {
        return res.status(400).json({ message: 'Faltan campos requeridos' });
    }

    try {
        const [existing] = await promiseDb.query(
            'SELECT id FROM users WHERE numeroControl = ?',
            [numeroControl]
        );

        if (existing.length > 0) {
            return res.status(400).json({ message: 'El número de control ya está registrado' });
        }

        let hashedPassword = null;
        if (password) {
            hashedPassword = await bcrypt.hash(password, 10);
        }

        if (role === 'Administrador') {
            if (codigoAcceso !== process.env.ADMIN_SECRET_CODE) {
                return res.status(403).json({ message: 'Código de acceso inválido' });
            }
        }

        // Compradores: isActive = true, Vendedores: isActive = false (pendiente aprobación)
        const isActive = role === 'Comprador';

        const [result] = await promiseDb.query(
            `INSERT INTO users 
            (role, numeroControl, nombreCompleto, carrera, email, telefono, password, 
             codigoAcceso, credencialFotos, isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0, 0, 0)`,
            [
                role, numeroControl, nombreCompleto, carrera || null, email || null, 
                telefono || null, hashedPassword, codigoAcceso || null,
                credencialFotos ? JSON.stringify(credencialFotos) : null,
                isVendedorTambien || false, isActive
            ]
        );

        const token = jwt.sign(
            { userId: result.insertId, role: role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        const [users] = await promiseDb.query(
            `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                    isVendedorTambien, createdAt, isActive, calificacion, totalVentas, totalCompras
             FROM users WHERE id = ?`,
            [result.insertId]
        );

        res.status(201).json({ token, user: users[0], message: 'Usuario registrado exitosamente' });

    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ message: 'Error al registrar usuario' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { numeroControl, password, codigoAcceso, role } = req.body;

    if (!numeroControl) {
        return res.status(400).json({ message: 'Número de control requerido' });
    }

    try {
        const [users] = await promiseDb.query(
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
            process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        delete user.password;
        delete user.codigoAcceso;

        res.json({ token, refreshToken, user, message: 'Inicio de sesión exitoso' });

    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ message: 'Error al iniciar sesión' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ message: 'Sesión cerrada exitosamente' });
});

// ==================== RUTAS DE ADMINISTRACIÓN - APROBAR VENDEDOR ====================
app.get('/api/admin/pending-vendors', authenticateToken, isAdmin, (req, res) => {
    db.query(
        `SELECT id, role, numeroControl, nombreCompleto, carrera, email, telefono, 
                credencialFotos, createdAt, isActive
         FROM users 
         WHERE role = 'Vendedor' AND isActive = FALSE
         ORDER BY createdAt ASC`,
        (err, vendors) => {
            if (err) {
                console.error('Error obteniendo vendedores pendientes:', err);
                return res.status(500).json({ message: 'Error' });
            }
            
            const parsedVendors = vendors.map(v => ({
                ...v,
                credencialFotos: typeof v.credencialFotos === 'string' ? JSON.parse(v.credencialFotos || '[]') : (v.credencialFotos || [])
            }));
            
            res.json({ vendors: parsedVendors });
        }
    );
});

app.post('/api/admin/approve-vendor', authenticateToken, isAdmin, async (req, res) => {
    const { userId, approved, rejectionReason } = req.body;

    try {
        // Actualizar estado del usuario
        await promiseDb.query('UPDATE users SET isActive = ? WHERE id = ?', [approved, userId]);
        
        // Obtener información del vendedor para el correo
        const [vendors] = await promiseDb.query(
            'SELECT email, nombreCompleto, numeroControl FROM users WHERE id = ?',
            [userId]
        );
        
        const vendor = vendors[0];
        
        if (approved) {
            // Crear notificación en la app
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '✅ Cuenta aprobada', 'Tu cuenta de vendedor ha sido aprobada. ¡Ya puedes iniciar sesión y publicar productos!', 'user_approval']
            );
            
            // Enviar correo electrónico
            if (vendor && vendor.email) {
                const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                            .header { text-align: center; border-bottom: 2px solid #4CAF50; padding-bottom: 20px; margin-bottom: 20px; }
                            .logo { font-size: 28px; font-weight: bold; color: #4CAF50; }
                            .title { color: #333; font-size: 24px; margin-bottom: 10px; }
                            .content { color: #555; line-height: 1.6; margin-bottom: 30px; }
                            .button { background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; }
                            .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #888; font-size: 12px; }
                            .credentials { background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <div class="logo">🍔 ByteSnack ITESCO</div>
                                <h1 class="title">¡Bienvenido a ByteSnack! 🎉</h1>
                            </div>
                            <div class="content">
                                <p>Hola <strong>${vendor.nombreCompleto}</strong>,</p>
                                <p>¡Excelentes noticias! Tu cuenta de <strong>VENDEDOR</strong> ha sido <strong style="color: #4CAF50;">APROBADA</strong> por el administrador.</p>
                                <div class="credentials">
                                    <p><strong>📋 Tus credenciales:</strong></p>
                                    <p>🔑 Número de control: <strong>${vendor.numeroControl}</strong></p>
                                    <p>🔒 Contraseña: <strong>La que configuraste al registrarte</strong></p>
                                </div>
                                <p>Ya puedes iniciar sesión y comenzar a publicar tus productos. Recibirás notificaciones cuando los compradores realicen pedidos.</p>
                                <p style="text-align: center;">
                                    <a href="${process.env.APP_URL || 'https://bytesnack.itesco.edu.mx'}" class="button">Ir a ByteSnack</a>
                                </p>
                                <p>¡Gracias por ser parte de nuestra comunidad de emprendedores!</p>
                            </div>
                            <div class="footer">
                                <p>ByteSnack ITESCO - Snacks inteligentes para estudiantes</p>
                                <p>© ${new Date().getFullYear()} ByteSnack. Todos los derechos reservados.</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `;
                
                await sendEmail(
                    vendor.email,
                    '✅ ¡Tu cuenta de Vendedor en ByteSnack ha sido aprobada!',
                    emailHtml
                );
            }
            
            res.json({ message: 'Vendedor aprobado exitosamente', emailSent: !!vendor?.email });
        } else {
            // Rechazar vendedor
            await promiseDb.query(
                `INSERT INTO notifications (userId, title, body, type, isRead, createdAt)
                 VALUES (?, ?, ?, ?, FALSE, NOW())`,
                [userId, '❌ Cuenta rechazada', `Tu cuenta de vendedor ha sido rechazada. Motivo: ${rejectionReason || 'No especificado'}`, 'user_approval']
            );
            
            // Enviar correo de rechazo
            if (vendor && vendor.email) {
                const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 20px; }
                            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                            .header { text-align: center; border-bottom: 2px solid #f44336; padding-bottom: 20px; margin-bottom: 20px; }
                            .logo { font-size: 28px; font-weight: bold; color: #f44336; }
                            .title { color: #333; font-size: 24px; margin-bottom: 10px; }
                            .content { color: #555; line-height: 1.6; margin-bottom: 30px; }
                            .reason { background-color: #fff3f3; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f44336; }
                            .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #888; font-size: 12px; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <div class="logo">🍔 ByteSnack ITESCO</div>
                                <h1 class="title">Estado de tu solicitud</h1>
                            </div>
                            <div class="content">
                                <p>Hola <strong>${vendor.nombreCompleto}</strong>,</p>
                                <p>Hemos revisado tu solicitud para ser <strong>VENDEDOR</strong> en ByteSnack.</p>
                                <div class="reason">
                                    <p><strong>📝 Motivo del rechazo:</strong></p>
                                    <p>${rejectionReason || 'No se especificó un motivo'}</p>
                                </div>
                                <p>Si tienes dudas o crees que esto es un error, por favor contacta al administrador.</p>
                                <p>Puedes volver a intentar el registro corrigiendo la información solicitada.</p>
                            </div>
                            <div class="footer">
                                <p>ByteSnack ITESCO - Snacks inteligentes para estudiantes</p>
                                <p>© ${new Date().getFullYear()} ByteSnack. Todos los derechos reservados.</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `;
                
                await sendEmail(
                    vendor.email,
                    '❌ Actualización sobre tu solicitud de Vendedor en ByteSnack',
                    emailHtml
                );
            }
            
            res.json({ message: 'Vendedor rechazado', emailSent: !!vendor?.email });
        }
    } catch (error) {
        console.error('Error aprobando vendedor:', error);
        res.status(500).json({ message: 'Error al procesar la solicitud' });
    }
});

// ==================== RESTO DE RUTAS (PRODUCTOS, CARRITO, PEDIDOS, ETC.) ====================
// ... (mantén todas las rutas anteriores aquí)

// ==================== RUTA DE SALUD ====================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== MANEJO DE ERRORES 404 ====================
app.use('*', (req, res) => {
    res.status(404).json({ message: `Ruta ${req.originalUrl} no encontrada` });
});

// ==================== INICIAR SERVIDOR ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});