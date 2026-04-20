const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

module.exports = (db) => {
    const router = require('express').Router();

    // REGISTRO
    router.post('/register', async (req, res) => {
        console.log('📝 Registro:', req.body.numeroControl);
        
        const { role, numeroControl, nombreCompleto, carrera, email, telefono, password, codigoAcceso, isVendedorTambien } = req.body;
        
        try {
            db.query('SELECT * FROM users WHERE numeroControl = ?', [numeroControl], async (err, results) => {
                if (err) {
                    console.error('Error en consulta:', err);
                    return res.status(500).json({ message: 'Error en BD' });
                }
                if (results.length > 0) {
                    return res.status(400).json({ message: 'El número de control ya está registrado' });
                }
                
                const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
                
                db.query(
                    `INSERT INTO users (role, numeroControl, nombreCompleto, carrera, email, telefono, password, codigoAcceso, isVendedorTambien, isActive)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
                    [role, numeroControl, nombreCompleto, carrera, email, telefono, hashedPassword, codigoAcceso, isVendedorTambien || false],
                    (err, result) => {
                        if (err) {
                            console.error('Error insertando:', err);
                            return res.status(500).json({ message: 'Error al registrar usuario' });
                        }
                        
                        const token = jwt.sign(
                            { userId: result.insertId, role },
                            process.env.JWT_SECRET,
                            { expiresIn: '7d' }
                        );
                        
                        res.status(201).json({
                            token,
                            user: {
                                id: result.insertId,
                                role,
                                numeroControl,
                                nombreCompleto,
                                email,
                                carrera,
                                telefono,
                                isVendedorTambien: isVendedorTambien || false
                            }
                        });
                    }
                );
            });
        } catch (error) {
            console.error('Error en registro:', error);
            res.status(500).json({ message: 'Error en el servidor' });
        }
    });

    // LOGIN
    router.post('/login', (req, res) => {
        console.log('🔐 Login:', req.body.numeroControl);
        
        const { numeroControl, password, codigoAcceso, role } = req.body;
        
        db.query('SELECT * FROM users WHERE numeroControl = ? AND isActive = TRUE', [numeroControl], async (err, users) => {
            if (err) {
                console.error('Error en login:', err);
                return res.status(500).json({ message: 'Error en BD' });
            }
            
            if (users.length === 0) {
                return res.status(401).json({ message: 'Credenciales incorrectas' });
            }
            
            const user = users[0];
            
            if (user.role !== role) {
                return res.status(401).json({ message: 'Rol incorrecto' });
            }
            
            let valido = false;
            if (role === 'Administrador') {
                valido = (user.codigoAcceso === codigoAcceso);
            } else {
                valido = await bcrypt.compare(password, user.password);
            }
            
            if (!valido) {
                return res.status(401).json({ message: 'Credenciales incorrectas' });
            }
            
            const token = jwt.sign(
                { userId: user.id, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );
            
            res.json({
                token,
                user: {
                    id: user.id,
                    role: user.role,
                    numeroControl: user.numeroControl,
                    nombreCompleto: user.nombreCompleto,
                    email: user.email,
                    carrera: user.carrera,
                    telefono: user.telefono,
                    isVendedorTambien: user.isVendedorTambien,
                    calificacion: user.calificacion || 0,
                    totalVentas: user.totalVentas || 0,
                    totalCompras: user.totalCompras || 0
                }
            });
        });
    });

    // LOGOUT
    router.post('/logout', (req, res) => {
        res.json({ message: 'Sesión cerrada' });
    });

    // REFRESH TOKEN
    router.post('/refresh', (req, res) => {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(401).json({ message: 'No refresh token' });
        }
        
        try {
            const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
            const newToken = jwt.sign(
                { userId: decoded.userId, role: decoded.role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );
            res.json({ token: newToken });
        } catch (e) {
            res.status(401).json({ message: 'Refresh token inválido' });
        }
    });

    return router;
};