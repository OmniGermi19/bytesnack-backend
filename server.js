const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// ========== RUTAS PRINCIPALES ==========

// Ruta raíz
app.get('/', (req, res) => {
    res.json({ 
        message: 'ByteSnack API',
        version: '1.0.0',
        status: 'online'
    });
});

// Ruta /api (redirige a la raíz)
app.get('/api', (req, res) => {
    res.json({ 
        message: 'ByteSnack API',
        endpoints: {
            auth: '/api/auth/login',
            products: '/api/products',
            test: '/test-db'
        }
    });
});

// ========== RUTAS DE PRUEBA ==========

// Probar conexión a BD
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

// ========== RUTAS DE AUTENTICACIÓN ==========

// Login
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
            
            // Comparación simple por ahora
            if (password === '123456') {
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
        
        // Usuario de prueba por si no hay en BD
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

// ========== RUTAS DE PRODUCTOS ==========

// Obtener productos
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
            // Productos de prueba si no hay en BD
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
        res.json({ 
            products: [
                {
                    id: 1,
                    name: 'Error al cargar productos',
                    price: 0,
                    description: 'Intenta de nuevo',
                    stock: 0,
                    category: 'Otros',
                    images: [],
                    isAvailable: false,
                    sellerName: 'Sistema'
                }
            ]
        });
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
    console.log(`   POST /api/auth/login`);
    console.log(`   GET  /api/products\n`);
});