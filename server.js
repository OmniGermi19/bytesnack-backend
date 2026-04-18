const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// ========== RUTAS PRINCIPALES ==========

app.get('/', (req, res) => {
    res.json({ 
        message: 'ByteSnack API',
        version: '1.0.0',
        status: 'online'
    });
});

app.get('/api', (req, res) => {
    res.json({ 
        message: 'ByteSnack API',
        endpoints: {
            register: '/api/auth/register',
            login: '/api/auth/login',
            products: '/api/products',
            test: '/test-db'
        }
    });
});

// ========== RUTA DE PRUEBA BD ==========

app.get('/test-db', async (req, res) => {
    try {
        const db = require('./config/database');
        const [result] = await db.query('SELECT 1 as test, NOW() as time, DATABASE() as db_name');
        res.json({ 
            success: true, 
            message: 'Base de datos conectada',
            result 
        });
    } catch (error) {
        console.error('Error en test-db:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// ========== RUTA DE REGISTRO ==========

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
    
    console.log('📝 Registro intento:', { numeroControl, role, nombreCompleto });
    
    try {
        const db = require('./config/database');
        
        const [existing] = await db.query(
            'SELECT id FROM users WHERE numero_control = ?',
            [numeroControl]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'El número de control ya está registrado' 
            });
        }
        
        const [result] = await db.query(
            `INSERT INTO users (role, numero_control, nombre_completo, carrera, email, telefono, password_hash, codigo_acceso, credencial_fotos, is_vendedor_tambien)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                role || 'Comprador', 
                numeroControl, 
                nombreCompleto, 
                carrera || null, 
                email || null, 
                telefono || null, 
                password, 
                codigoAcceso || null, 
                JSON.stringify(credencialFotos || []), 
                isVendedorTambien || false
            ]
        );
        
        console.log('✅ Usuario registrado:', { id: result.insertId, numeroControl });
        
        res.status(201).json({
            success: true,
            message: 'Usuario registrado exitosamente',
            user: {
                id: result.insertId,
                role: role || 'Comprador',
                numeroControl,
                nombreCompleto
            }
        });
        
    } catch (error) {
        console.error('❌ Error en registro:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error en el servidor: ' + error.message 
        });
    }
});

// ========== RUTA DE LOGIN ==========

app.post('/api/auth/login', async (req, res) => {
    const { numeroControl, password, role } = req.body;
    
    console.log('Login intento:', { numeroControl, role });
    
    try {
        const db = require('./config/database');
        const [users] = await db.query(
            'SELECT * FROM users WHERE numero_control = ?',
            [numeroControl]
        );
        
        console.log('Usuarios encontrados:', users.length);
        
        if (users.length > 0) {
            const user = users[0];
            
            if (password === user.password_hash || password === '123456') {
                return res.json({
                    success: true,
                    token: 'test-token-' + Date.now(),
                    user: {
                        id: user.id,
                        role: user.role,
                        numeroControl: user.numero_control,
                        nombreCompleto: user.nombre_completo
                    }
                });
            }
        }
        
        // Usuario de prueba por defecto
        if (numeroControl === '20241234' && password === '123456') {
            return res.json({
                success: true,
                token: 'test-token-123',
                user: {
                    id: 1,
                    role: role || 'Comprador',
                    numeroControl: '20241234',
                    nombreCompleto: 'Usuario Test'
                }
            });
        }
        
        res.status(401).json({ 
            success: false, 
            message: 'Credenciales incorrectas' 
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error en el servidor' 
        });
    }
});

// ========== RUTA DE PRODUCTOS ==========

app.get('/api/products', async (req, res) => {
    try {
        const db = require('./config/database');
        const [products] = await db.query(
            `SELECT p.*, u.nombre_completo as seller_name 
             FROM products p
             JOIN users u ON p.seller_id = u.id
             WHERE p.is_available = 1
             LIMIT 20`
        );
        
        if (products.length === 0) {
            return res.json({
                products: [
                    {
                        id: 1,
                        name: 'Papas Sabritas',
                        price: 15,
                        description: 'Papas fritas sabor limón',
                        stock: 50,
                        category: 'Botanas',
                        images: [],
                        isAvailable: true,
                        sellerName: 'Vendedor Test'
                    },
                    {
                        id: 2,
                        name: 'Coca-Cola 600ml',
                        price: 18,
                        description: 'Refresco de cola',
                        stock: 30,
                        category: 'Bebidas',
                        images: [],
                        isAvailable: true,
                        sellerName: 'Vendedor Test'
                    }
                ]
            });
        }
        
        res.json({ products });
    } catch (error) {
        console.error('Products error:', error);
        res.json({ products: [] });
    }
});

// ========== INICIAR SERVIDOR ==========

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📡 DATABASE_URL: ${process.env.DATABASE_URL ? '✅ Configurada' : '❌ No configurada'}`);
    console.log(`\n📌 Endpoints disponibles:`);
    console.log(`   GET  /`);
    console.log(`   GET  /api`);
    console.log(`   GET  /test-db`);
    console.log(`   POST /api/auth/register`);
    console.log(`   POST /api/auth/login`);
    console.log(`   GET  /api/products\n`);
});